/**
 * Fills in the missing channel details — the avatar first, the name close
 * behind.
 *
 * The normal sync fetches a slice of the channel details per run, because a
 * full pass over 14,000 channels is more than one run can afford. That works
 * for keeping the dataset fresh, but it is the wrong tool for the backlog:
 * 8,000 channels have no avatar at all, and a broken image is the first thing
 * anyone sees on a card.
 *
 * So this script walks the backlog and fills what is missing:
 *
 *   npm run data:details -- --limit 2000
 *   npm run data:details -- --platform bilibili --limit 500
 *   npm run data:details -- --name-only
 *   npm run data:ids                   # re-key handle ids to UC… ids
 *   npm run data:details -- --dry-run
 *
 * `--name-only` is the cheap pass: the same request that carries the avatar
 * carries the platform's current name, and the name is the field a roster
 * gets wrong most often. It also splits the title into aliases, so a channel
 * titled 「空星きらめ/Sorahoshi Kirame【にじさんじ】」 is findable under any
 * of the three names in it.
 *
 * ## What it fetches
 *
 * | Platform | Source | Cost |
 * | --- | --- | --- |
 * | YouTube | InnerTube | no quota |
 * | Twitch | GQL | no quota |
 * | Bilibili | the public `card` endpoint | no quota |
 * | Niconico / VK / CHZZK / KICK | the platform adapters | no quota |
 *
 * ## What it writes
 *
 * Only the fields it actually fetched: the avatar, the current name, the
 * description, the follower count and the video count. Nothing else in the
 * record is touched, and the file layout is unchanged — the shards are
 * rewritten in place.
 *
 * ## The name
 *
 * The platform is the primary source for a name, so a name the platform
 * reports replaces the one the roster recorded — unless a human has written
 * the name down in `data/overrides.json`, which is the final word. The old
 * name is kept as an alias so the channel stays findable under it.
 */

import {
  acquireRunLock,
  readJson,
} from "./lib/io";
import {
  ALL_BUCKETS,
  bucketFor,
  layout,
  readAllChannelRecords,
  writeChannelShards,
} from "./lib/dataset";
import { InnerTubeSource } from "./lib/youtubei";
import { TwitchGqlSource } from "./lib/twitch-gql";
import { createAdapters } from "./lib/platform-registry";
import {
  isPlaceholderName,
  normalizeChannelId,
  primaryPlatformOf,
} from "./lib/platforms";
import { dedupePlatformLinks, mergeChannels, REGION_TRUST } from "./lib/dedupe";
import {
  classifyChannel,
  detectActivity,
  detectAffiliation,
  extractAgency,
  mergeActivity,
} from "./lib/classify";
import { REGION_LANGUAGE, profileLanguage } from "./lib/regions";
import { splitName } from "./lib/names";
import { pickAvatar, pickSubscribers } from "./lib/platforms";
import type { Channel, PlatformId } from "./lib/types";

/* -------------------------------------------------------------------------- */
/* Arguments                                                                  */
/* -------------------------------------------------------------------------- */

interface Options {
  limit: number;
  platform: PlatformId | null;
  dryRun: boolean;
  /** The gap between requests to one platform, in milliseconds. */
  intervalMs: number;
  /**
   * Do the work even when the record looks finished.
   *
   * By default the name pass skips a channel the platform has already
   * named, so a second run costs nothing.
   */
  force: boolean;
  /**
   * Only the name and the aliases — no avatar, no description, no counts.
   *
   * The name is the field a roster gets wrong most often, and it is the one
   * that is cheapest to correct: it comes from the same profile request
   * that carries the avatar.
   */
  nameOnly: boolean;
  /**
   * Re-key the records that are stored under a renameable id.
   *
   * A YouTube handle is unique but the performer can change it, so a record
   * keyed by `youtube:@someone` breaks the day they rename. `UC…` is the
   * channel's permanent id and the one `youtube.com/channel/UC…` uses, so
   * those records are resolved and re-keyed.
   */
  normalizeIds: boolean;
  /**
   * Re-read the region of every YouTube record whose region is a guess.
   *
   * A record whose region came from a **mirror** — vdb's display language,
   * the script of a name — sits in the wrong shard, and the shard is what
   * the app downloads. This pass asks YouTube for the channel's published
   * country and the name in its own language, so a Japanese channel with a
   * Bilibili account is stored as `jp` under its Japanese name.
   */
  weakRegion: boolean;
}

/**
 * The spellings of the name pass.
 *
 * `npm run data:details --nameOnly` is what a person actually types, so the
 * dashes and the case are not something to be strict about.
 */
const NAME_ONLY_FLAGS = new Set([
  "--name-only",
  "--nameonly",
  "--names-only",
  "--namesonly",
  "--only",
]);

function parseArgs(argv: string[]): Options {
  const options: Options = {
    limit: 500,
    platform: null,
    dryRun: false,
    intervalMs: 450,
    nameOnly: false,
    force: false,
    normalizeIds: false,
    weakRegion: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--limit") options.limit = Number(argv[++i] ?? options.limit);
    else if (arg === "--platform") {
      options.platform = (argv[++i] ?? "") as PlatformId;
    } else if (arg === "--interval") {
      options.intervalMs = Number(argv[++i] ?? options.intervalMs);
    } else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--force") options.force = true;
    else if (
      arg === "--normalize-ids" ||
      arg === "--normalizeIds" ||
      arg === "--ids-only"
    ) {
      options.normalizeIds = true;
    } else if (
      arg === "--weak-region" ||
      arg === "--weak-regions" ||
      arg === "--regions"
    ) {
      options.weakRegion = true;
    }
    else if (NAME_ONLY_FLAGS.has(arg.toLowerCase())) {
      const value = argv[i + 1];
      if (value && !value.startsWith("--")) {
        i++;
        options.nameOnly = value.toLowerCase() === "name";
      } else {
        options.nameOnly = true;
      }
    }
  }
  if (!Number.isFinite(options.limit) || options.limit <= 0) options.limit = 500;
  return options;
}

/* -------------------------------------------------------------------------- */
/* Logging                                                                    */
/* -------------------------------------------------------------------------- */

const started = Date.now();
let fetched = 0;
let filled = 0;
let renamed = 0;
let grouped = 0;
let rekeyed = 0;
/** Records whose region was corrected from the channel's published country. */
let regionFixed = 0;
let failed = 0;

function log(message: string): void {
  const seconds = ((Date.now() - started) / 1000).toFixed(0);
  console.log(`[details:${seconds}s] ${message}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/* -------------------------------------------------------------------------- */
/* The fetchers                                                               */
/* -------------------------------------------------------------------------- */

interface Profile {
  name: string | null;
  avatar: string | null;
  description: string | null;
  subscribers: number | null;
  videoCount: number | null;
  /**
   * The platform's own immutable id, when it has one.
   *
   * A YouTube handle is unique but **renameable**, so `@someone` is not a
   * stable identity: the performer can take a different handle tomorrow and
   * the record would point at nothing. `UC…` cannot change, and it is what
   * the channel URL uses.
   */
  id?: string | null;
  /** The channel's current `@handle`, when the platform publishes one. */
  handle?: string | null;
  /**
   * The 🎵 Official Artist Channel badge.
   *
   * Only YouTube has one; the other platforms leave it `undefined`.
   */
  officialArtist?: boolean;
  /**
   * The country the channel publishes, as an ISO code.
   *
   * Only YouTube states one, and it is the fact a mirror cannot corrupt.
   */
  country?: string | null;
}

/**
 * Fetches the profile of one channel.
 *
 * Each platform has its own path, and each is a free endpoint — no API key,
 * no quota. A failure returns `null` rather than throwing, so one broken
 * channel never stops the run.
 */
async function fetchProfile(
  channel: Channel,
  platform: PlatformId,
  ctx: {
    innertube: InnerTubeSource;
    twitch: TwitchGqlSource;
    adapters: Map<PlatformId, { resolve(q: string): Promise<any> }>;
  },
): Promise<Profile | null> {
  const link = channel.platforms.find((p) => p.platform === platform);
  if (!link) return null;
  const query = link.handle ?? link.id;

  try {
    if (platform === "youtube") {
      /**
       * InnerTube resolves a channel id or a handle, but not the dataset's
       * own id format — a handle record is stored as `youtube:user-<handle>`,
       * so the handle is what has to be handed over.
       */
      /**
       * A YouTube channel id, cleaned up.
       *
       * Two records were built from a channel *URL*, so their id carries the
       * tab: `UC…/featured`, `UC…/videos`. The tab is not part of the id.
       */
      const raw = channel.id.split("/")[0]!;
      const youtubeId = raw.startsWith("UC")
        ? raw
        : await ctx.innertube.resolveHandle(
            raw.replace(/^youtube:(user-)?/, ""),
          );
      if (!youtubeId) return null;
      /**
       * The profile is asked for in the record's **own language**, so the
       * name that comes back is the one the performer uses. YouTube's
       * default answer is the English localization, which for a Japanese
       * channel is often an alias: `Aoi / Vtuber` instead of
       * 「向葵 / あおい」.
       */
      const profile = await ctx.innertube.profile(youtubeId, {
        lang: profileLanguage(channel.region),
        about: true,
      });
      if (!profile) return null;
      return {
        name: profile.title,
        avatar: profile.avatar,
        description: profile.description,
        subscribers: profile.subscribers,
        videoCount: null,
        id: profile.id,
        handle: profile.handle,
        country: profile.country,
        officialArtist: profile.officialArtist,
      };
    }

    if (platform === "twitch") {
      // The numeric id is the stable identifier; the login changes on rename.
      const lookup = /^\d+$/.test(link.id) ? link.id : query;
      const profile = await ctx.twitch.profile(lookup);
      if (!profile) return null;
      return {
        name: profile.displayName,
        avatar: profile.avatar,
        description: profile.description,
        subscribers: profile.followers ?? null,
        videoCount: null,
      };
    }

    const adapter = ctx.adapters.get(platform);
    if (!adapter) return null;
    const profile = await adapter.resolve(
      platform === "ci.me" ? link.id : query,
    );
    if (!profile) return null;
    const count =
      profile.subscribers && profile.subscribers.tag === "has"
        ? profile.subscribers.count
        : null;
    return {
      name: profile.name ?? null,
      avatar: profile.avatar ?? null,
      description: profile.description ?? null,
      subscribers: count,
      videoCount: profile.videoCount ?? null,
    };
  } catch {
    return null;
  }
}

export { splitName } from "./lib/names";

/**
 * Whether a record's identity is a name the platform can change.
 *
 * A YouTube handle is unique but renameable; `UC…` is not. The record may be
 * keyed by the handle itself (`youtube:@someone`) or merely hold one as its
 * YouTube link.
 */
function needsStableId(channel: Channel): boolean {
  const link = channel.platforms.find((p) => p.platform === "youtube");
  if (!link) return false;
  // A tab in the id means it was built from a URL, not a channel.
  if (channel.id.includes("/") || (link.id ?? "").includes("/")) return true;
  if (link.id && !link.id.startsWith("UC")) return true;
  const bare = channel.id.replace(/^youtube:(user-)?/, "");
  return channel.id !== bare && !bare.startsWith("UC");
}

/* -------------------------------------------------------------------------- */
/* Applying a profile                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Writes a fetched profile into the record.
 *
 * Only the record's **own** platform may rename it: a Chinese Bilibili
 * account must not rename a Japanese YouTube channel, because the two names
 * are different languages for the same performer.
 */
function applyProfile(
  channel: Channel,
  platform: PlatformId,
  profile: Profile,
  overrides: Record<string, { name?: string }>,
  nameOnly = false,
): void {
  const link = channel.platforms.find((p) => p.platform === platform);
  if (!link) return;

  /**
   * The identity is the platform's immutable id.
   *
   * A YouTube handle is unique but can be **changed** — the performer picks a
   * new `@name` and every `@old` link dies — while `UC…` is permanent and is
   * what `youtube.com/channel/UC…` uses. So a record stored under a handle is
   * re-keyed the first time its profile is fetched, and the handle is kept as
   * the link's handle for display.
   *
   * A Twitch login is renameable for the same reason; its numeric id is the
   * stable one, and that is what `twitch-gql` resolves.
   */
  if (platform === "youtube") {
    /**
     * The id is the `UC…` channel id, and the URL is its `/channel/…` form.
     *
     * A handle is unique but renameable, so `@someone` is not an identity: the
     * performer takes a new handle and the link points at nothing. The handle
     * is kept beside it, for display and for lookups that take one.
     */
    const was = link.handle ?? link.id;
    if (profile.handle) link.handle = profile.handle;
    if (profile.id && profile.id.startsWith("UC")) {
      link.id = normalizeChannelId(profile.id);
    }
    /**
     * The record is re-keyed when its identity is not the stable one — a
     * handle, a `youtube:user-…`, or an id built from a URL (`UC…/featured`).
     */
    if (link.id.startsWith("UC") && channel.id !== link.id) {
      const bare = channel.id.replace(/^youtube:(user-)?/, "");
      if (
        bare === was ||
        bare === link.id ||
        normalizeChannelId(channel.id) === link.id
      ) {
        channel.id = link.id;
        rekeyed++;
      }
    }
    if (link.id.startsWith("UC")) {
      link.url = `https://www.youtube.com/channel/${link.id}`;
    }
  }

  if (!nameOnly) {
    if (profile.avatar) link.avatar = profile.avatar;
    if (profile.description && !channel.description) {
      channel.description = profile.description.slice(0, 1000);
    }
    if (profile.subscribers !== null) {
      link.subscribers = { tag: "has", count: profile.subscribers };
    }
    if (profile.videoCount !== null) channel.videoCount = profile.videoCount;
  }

  /**
   * The name.
   *
   * The platform is the primary source. A hand-written name in
   * `data/overrides.json` is the final word and is never overwritten, and a
   * placeholder — 「账号已注销」 — is not a name at all.
   */
  const manual = overrides[channel.id]?.name;
  if (
    profile.name &&
    !manual &&
    profile.name !== channel.name &&
    !isPlaceholderName(profile.name)
  ) {
    /**
     * The name the record had becomes an alias, so a search for the name
     * someone remembers still finds the channel.
     */
    if (!channel.aliases.includes(channel.name)) {
      channel.aliases.push(channel.name);
    }
    /**
     * The **parts** of the platform's name.
     *
     * A channel title is often several names in one string —
     * 「空星きらめ/Sorahoshi Kirame【にじさんじ】」 is the Japanese name, the
     * romanised name and the agency. Each part is a name the performer is
     * known by, so each one becomes an alias and a search for any of them
     * finds the channel.
     */
    for (const part of splitName(profile.name)) {
      if (part !== channel.name && !channel.aliases.includes(part)) {
        channel.aliases.push(part);
      }
    }
    if (channel.aliases.length > 12) {
      channel.aliases = channel.aliases.slice(-12);
    }
    channel.name = profile.name;
    channel.nameSource = "platform";
    link.name = profile.name;
    renamed++;
  }

  /**
   * The record's own avatar is the **primary** platform's avatar, so it is
   * only replaced when the profile came from the primary platform.
   */
  if (!nameOnly && profile.avatar && primaryPlatformOf(channel) === platform) {
    channel.avatar = profile.avatar;
  }

  /**
   * The description is where a performer states their own facts, and it has
   * only just arrived — so the classification is read again.
   *
   * 「已畢業」 in a bio means the performer has graduated, 「個人勢」 means
   * they are independent, and a channel that says it publishes songs is a
   * singing one. None of that was available when the record was first
   * classified.
   *
   * It is also where the agency is stated: 「にじさんじ所属」, 「所属：彩虹社」,
   * 「니지산지 소속」, "affiliated with Nijisanji" all name the group, in the
   * performer's own words, for a field the rosters leave empty.
   */
  if (channel.description) {
    if (!channel.agency) {
      const stated = extractAgency(channel.name, channel.description);
      if (stated) {
        channel.agency = stated;
        grouped++;
      }
    }
    channel.affiliation = detectAffiliation(
      channel.name,
      channel.description,
      channel.agency,
    );
    channel.activity = mergeActivity(
      channel.activity,
      detectActivity(channel.name, channel.description, null),
    );
  }

  /**
   * The country the channel publishes, and the region it implies.
   *
   * YouTube states it on the about page — 「日本」 for a channel that also
   * has a Bilibili account, which is exactly the case a **mirror** breaks.
   * Only a more trusted source may replace the region that is already there,
   * so a roster's nationality, an agency and an override are never
   * overwritten.
   */
  if (profile.country) {
    channel.country = profile.country;
    const fresh = classifyChannel({
      name: channel.name,
      description: channel.description,
      tags: channel.tags,
      country: channel.country,
      platform: primaryPlatformOf(channel) ?? undefined,
    });
    if (
      REGION_TRUST[fresh.regionSource] >
      REGION_TRUST[channel.regionSource ?? "unknown"]
    ) {
      channel.region = fresh.region;
      channel.regionSource = fresh.regionSource;
      // The language follows the region, unless the performer stated one.
      if (!(channel.statedLanguages?.length ?? 0)) {
        const language = REGION_LANGUAGE[fresh.region];
        if (language) channel.languages = [language];
      }
      regionFixed++;
    }
  }

  // The avatar and the follower count follow the primary platform.
  channel.avatar = pickAvatar(channel);
  channel.subscribers = pickSubscribers(channel);

  /**
   * The 🎵 Official Artist Channel badge.
   *
   * It is a fact about the YouTube channel, so a non-YouTube profile leaves
   * whatever the last YouTube pass found untouched.
   */
  if (profile.officialArtist !== undefined) {
    channel.isOfficialArtist = profile.officialArtist;
  }
}

/* -------------------------------------------------------------------------- */
/* Main                                                                       */
/* -------------------------------------------------------------------------- */

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  /**
   * One writer at a time.
   *
   * The run reads the whole dataset before it writes it, so a sync running
   * at the same time would lose its work to this run's snapshot.
   */
  const releaseLock = acquireRunLock("details");
  const overrides = readJson<Record<string, { name?: string }>>(
    layout.overrides,
    {},
  );

  log(`reading the dataset…`);
  const all = readAllChannelRecords();
  log(`${all.length} channel(s) in the dataset`);

  /**
   * The channels that need an avatar, worst first.
   *
   * A channel with no avatar at all is worth more than one that merely
   * lacks a description, and a channel that has never been fetched is worth
   * more than one that has.
   */
  const pending = all
    .filter((c) => {
      if (options.platform && primaryPlatformOf(c) !== options.platform) {
        return false;
      }
      /**
       * `--normalize-ids` touches only the records whose identity is a
       * handle — everything else is already keyed by a permanent id.
       */
      if (options.normalizeIds) return needsStableId(c);
      /**
       * `--weak-region` touches only the records whose region is a guess.
       *
       * `override` and `roster` are facts, an agency is a fact and kana is
       * good evidence; `declared` (vdb's display language), `script` and
       * `unknown` are the ones a mirror can get wrong.
       */
      if (options.weakRegion) {
        return (
          primaryPlatformOf(c) === "youtube" &&
          ["declared", "script", "unknown"].includes(
            c.regionSource ?? "unknown",
          )
        );
      }
      // In name-only mode every channel is a candidate: the point is to
      // correct the name, whether or not the avatar is already there.
      if (!options.nameOnly && c.avatar) return false;
      /**
       * A channel the platform has already named is done — unless the run
       * was asked to do everything anyway.
       */
      if (
        options.nameOnly &&
        !options.force &&
        c.nameSource === "platform" &&
        !overrides[c.id]?.name
      ) {
        return false;
      }
      return c.platforms.length > 0;
    })
    .sort((a, b) => {
      const score = (c: Channel) =>
        (c.avatar ? 0 : 4) +
        (c.description ? 0 : 1) +
        (c.lastDetailsFetchedAt ? 0 : 2);
      return score(b) - score(a);
    })
    .slice(0, options.limit);

  log(
    options.normalizeIds
      ? `${pending.length} channel(s) are keyed by a handle`
      : options.weakRegion
        ? `${pending.length} channel(s) have a guessed region`
        : options.nameOnly
          ? `${pending.length} channel(s) to rename`
          : `${pending.length} channel(s) need an avatar`,
  );

  const innertube = new InnerTubeSource({
    delayMs: options.intervalMs,
    onLog: (m) => log(m),
  });
  await innertube.connect();

  const twitch = new TwitchGqlSource({
    delayMs: options.intervalMs,
    onLog: (m) => log(m),
  });

  const adapters = new Map<PlatformId, { resolve(q: string): Promise<any> }>();
  for (const adapter of createAdapters({ youtubeClient: null, twitchClient: null })) {
    adapters.set(adapter.id, adapter);
  }

  const ctx = { innertube, twitch, adapters };
  /** Every record this run changed, by id. */
  const updatedById = new Map<string, Channel>();

  /**
   * The failures of one platform in a row.
   *
   * A source that is pushing back — Bilibili's risk control, for instance —
   * is handled by the adapter's own circuit breaker, which stops calling it
   * rather than waiting out a backoff on every channel. So the run does not
   * give up on a platform here: a channel that no longer exists is a fact
   * about the channel, not a reason to stop.
   */
  const consecutiveFailures = new Map<PlatformId, number>();

  for (const channel of pending) {
    const platform = primaryPlatformOf(channel);
    if (!platform) continue;

    const profile = await fetchProfile(channel, platform, ctx);
    fetched++;

    if (!profile) {
      failed++;
      const streak = (consecutiveFailures.get(platform) ?? 0) + 1;
      consecutiveFailures.set(platform, streak);
      // The source is pushing back — wait a little longer before the next.
      await sleep(options.intervalMs * 2);
      continue;
    }
    consecutiveFailures.set(platform, 0);

    const before = channel.avatar;
    const originalId = channel.id;
    const beforeRegion = channel.region;
    applyProfile(channel, platform, profile, overrides, options.nameOnly);
    /**
     * A record whose region just moved is asked again, in the language of
     * its **new** region.
     *
     * The first request was answered in the language of the old — possibly
     * wrong — one, which is how `Aoi / Vtuber` was stored for a Japanese
     * channel: the English localization is not the name the performer uses.
     */
    if (platform === "youtube" && channel.region !== beforeRegion) {
      const localized = await fetchProfile(channel, platform, ctx);
      if (localized) {
        applyProfile(channel, platform, localized, overrides, options.nameOnly);
        log(
          `region: ${beforeRegion} → ${channel.region} (${channel.regionSource}) · ${channel.name}`,
        );
      }
    }
    if (channel.avatar && channel.avatar !== before) filled++;
    /**
     * Keyed by the id the record **had** when it was read: a profile can
     * re-key a handle record to its permanent `UC…` id, and the shard on disk
     * still holds the old one.
     */
    updatedById.set(originalId, channel);
    if (channel.id !== originalId) log(`id: ${originalId} → ${channel.id}`);

    if (fetched % 50 === 0) {
      log(
        `${fetched}/${pending.length} fetched · ` +
          (options.nameOnly ? "" : `${filled} avatar(s) filled · `) +
          `${renamed} renamed · ${regionFixed} region(s) fixed · ` +
          `${grouped} grouped · ${rekeyed} re-keyed · ${failed} failed`,
      );
    }
    await sleep(options.intervalMs);
  }

  log(
    `${fetched} fetched · ` +
      (options.nameOnly ? "" : `${filled} avatar(s) filled · `) +
      `${renamed} renamed · ${regionFixed} region(s) fixed · ` +
      `${grouped} grouped · ${rekeyed} re-keyed · ${failed} failed`,
  );
  const struggling = [...consecutiveFailures.entries()].filter(
    ([, streak]) => streak >= 20,
  );
  if (struggling.length) {
    log(
      `struggling: ${struggling
        .map(([p, streak]) => `${p} ${streak} in a row`)
        .join(", ")} — the source may be pushing back`,
    );
  }

  if (options.dryRun) {
    log("dry run — nothing written");
    releaseLock();
    return;
  }

  /* --- write the records back ----------------------------------------- */
  /**
   * The dataset is **re-read** before it is written.
   *
   * A run reads the dataset at the start and writes it at the end, so a sync
   * that ran in between would have its work replaced by this run's stale
   * snapshot — the same reason the run holds the lock. So the current records
   * are read again, the fields this run fetched are applied to the ones it
   * touched, and every record is written back through
   * `writeChannelShards()`, which is the only writer.
   */
  const now = new Date().toISOString();
  const fresh = readAllChannelRecords();
  const written = new Set<string>();
  for (const record of fresh) {
    const updated = updatedById.get(record.id);
    if (!updated) continue;
    record.id = updated.id;
    /**
     * The platform list is taken **whole**: it carries the re-keyed id, the
     * handle it replaced and the URL that follows, and copying it field by
     * field is how the id on disk stayed a handle after the record had been
     * re-keyed.
     */
    record.platforms = dedupePlatformLinks(updated.platforms);
    record.avatar = updated.avatar;
    record.name = updated.name;
    record.aliases = updated.aliases;
    record.nameSource = updated.nameSource;
    record.description = updated.description;
    record.activity = updated.activity;
    record.affiliation = updated.affiliation;
    record.agency = updated.agency;
    /**
     * The region is a field this run can correct: the country is fetched
     * with the profile, and a record whose region was a guess moves to the
     * shard its own country names.
     */
    record.region = updated.region;
    record.regionSource = updated.regionSource;
    record.country = updated.country;
    record.languages = updated.languages;
    record.isSinging = updated.isSinging;
    record.isOfficialArtist = updated.isOfficialArtist;
    record.subscribers = updated.subscribers;
    record.videoCount = updated.videoCount;
    written.add(record.id);
  }
  /**
   * Two records can become one: re-keying a record to the id another already
   * holds (`UC…/videos` and `UC…` are the same channel) must not leave two
   * records with the same id, or the next read is ambiguous.
   */
  const byId = new Map<string, Channel>();
  for (const record of fresh) {
    const seen = byId.get(record.id);
    byId.set(record.id, seen ? mergeChannels(record, seen) : record);
  }
  const shards = writeChannelShards([...byId.values()], now);
  log(
    `${written.size} channel(s) updated · ${shards.files} shard(s) written`,
  );

  releaseLock();
}

main().catch((err) => {
  console.error(`[details] failed: ${(err as Error).message}`);
  process.exit(1);
});
