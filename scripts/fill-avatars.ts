/**
 * Fills in the missing channel details — the avatar first.
 *
 * The normal sync fetches a slice of the channel details per run, because a
 * full pass over 14,000 channels is more than one run can afford. That works
 * for keeping the dataset fresh, but it is the wrong tool for the backlog:
 * 8,000 channels have no avatar at all, and a broken image is the first thing
 * anyone sees on a card.
 *
 * So this script does one thing, and does it until the backlog is empty:
 *
 *   npm run data:avatars -- --limit 2000
 *   npm run data:avatars -- --platform bilibili --limit 500
 *   npm run data:avatars -- --dry-run
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

import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, ensureDir, readJson, writeJson } from "./lib/io";
import {
  ALL_BUCKETS,
  bucketFor,
  layout,
  toSummary,
} from "./lib/dataset";
import { InnerTubeSource } from "./lib/youtubei";
import { TwitchGqlSource } from "./lib/twitch-gql";
import { createAdapters } from "./lib/platform-registry";
import { primaryPlatformOf, isPlaceholderName } from "./lib/platforms";
import {
  detectActivity,
  detectAffiliation,
  mergeActivity,
} from "./lib/classify";
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
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    limit: 500,
    platform: null,
    dryRun: false,
    intervalMs: 450,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--limit") options.limit = Number(argv[++i] ?? options.limit);
    else if (arg === "--platform") {
      options.platform = (argv[++i] ?? "") as PlatformId;
    } else if (arg === "--interval") {
      options.intervalMs = Number(argv[++i] ?? options.intervalMs);
    } else if (arg === "--dry-run") options.dryRun = true;
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
let failed = 0;

function log(message: string): void {
  const seconds = ((Date.now() - started) / 1000).toFixed(0);
  console.log(`[avatars:${seconds}s] ${message}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/* -------------------------------------------------------------------------- */
/* The record files                                                           */
/* -------------------------------------------------------------------------- */

interface ChannelFile {
  schemaVersion: number;
  generatedAt: string;
  channels: Channel[];
}

/** Every channel record file, with its path. */
function readChannelFiles(): { file: string; data: ChannelFile }[] {
  const out: { file: string; data: ChannelFile }[] = [];
  const root = path.join(DATA_DIR, "channels", "regions");
  if (!fs.existsSync(root)) return out;
  for (const region of fs.readdirSync(root)) {
    const dir = path.join(root, region);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith(".json")) continue;
      const full = path.join(dir, file);
      out.push({ file: full, data: readJson<ChannelFile>(full, { schemaVersion: 1, generatedAt: "", channels: [] }) });
    }
  }
  return out;
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
      const youtubeId = channel.id.startsWith("UC")
        ? channel.id
        : await ctx.innertube.resolveHandle(
            channel.id.replace(/^youtube:user-/, ""),
          );
      if (!youtubeId) return null;
      const profile = await ctx.innertube.profile(youtubeId);
      if (!profile) return null;
      return {
        name: profile.title,
        avatar: profile.avatar,
        description: profile.description,
        subscribers: profile.subscribers,
        videoCount: null,
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
    const profile = await adapter.resolve(query);
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
): void {
  const link = channel.platforms.find((p) => p.platform === platform);
  if (!link) return;

  if (profile.avatar) link.avatar = profile.avatar;
  if (profile.description && !channel.description) {
    channel.description = profile.description.slice(0, 1000);
  }
  if (profile.subscribers !== null) {
    link.subscribers = { tag: "has", count: profile.subscribers };
  }
  if (profile.videoCount !== null) channel.videoCount = profile.videoCount;

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
  if (profile.avatar && primaryPlatformOf(channel) === platform) {
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
   */
  if (channel.description) {
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

  // The avatar and the follower count follow the primary platform.
  channel.avatar = pickAvatar(channel);
  channel.subscribers = pickSubscribers(channel);
}

/* -------------------------------------------------------------------------- */
/* Main                                                                       */
/* -------------------------------------------------------------------------- */

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const overrides = readJson<Record<string, { name?: string }>>(
    layout.overrides,
    {},
  );

  log(`reading the dataset…`);
  const files = readChannelFiles();
  const all = files.flatMap((f) => f.data.channels);
  log(`${all.length} channel(s) in ${files.length} shard(s)`);

  /**
   * The channels that need an avatar, worst first.
   *
   * A channel with no avatar at all is worth more than one that merely
   * lacks a description, and a channel that has never been fetched is worth
   * more than one that has.
   */
  const pending = all
    .filter((c) => {
      if (c.avatar) return false;
      if (options.platform && primaryPlatformOf(c) !== options.platform) {
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

  log(`${pending.length} channel(s) need an avatar`);

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
  const touched = new Set<string>();

  /**
   * How many consecutive failures one platform may have before the run
   * leaves it alone.
   *
   * Bilibili's risk control rejects a burst for a while, and every rejected
   * request costs a backoff. Grinding through thousands of them would take
   * hours and fill nothing, so the platform is dropped for the rest of the
   * run and the others carry on.
   */
  const MAX_CONSECUTIVE_FAILURES = 8;
  const consecutiveFailures = new Map<PlatformId, number>();
  const abandoned = new Set<PlatformId>();

  for (const channel of pending) {
    const platform = primaryPlatformOf(channel);
    if (!platform) continue;
    if (abandoned.has(platform)) continue;

    const profile = await fetchProfile(channel, platform, ctx);
    fetched++;

    if (!profile) {
      failed++;
      const streak = (consecutiveFailures.get(platform) ?? 0) + 1;
      consecutiveFailures.set(platform, streak);
      if (streak >= MAX_CONSECUTIVE_FAILURES) {
        abandoned.add(platform);
        log(
          `bilibili: giving up on this platform for this run — ` +
            `${streak} consecutive failures`,
        );
        continue;
      }
      // The source is pushing back — wait a little longer before the next.
      await sleep(options.intervalMs * 2);
      continue;
    }
    consecutiveFailures.set(platform, 0);

    const before = channel.avatar;
    applyProfile(channel, platform, profile, overrides);
    if (channel.avatar && channel.avatar !== before) filled++;
    touched.add(channel.id);

    if (fetched % 50 === 0) {
      log(
        `${fetched}/${pending.length} fetched · ${filled} avatar(s) filled · ` +
          `${renamed} renamed · ${failed} failed`,
      );
    }
    await sleep(options.intervalMs);
  }

  log(
    `${fetched} fetched · ${filled} avatar(s) filled · ${renamed} renamed · ` +
      `${failed} failed`,
  );
  if (abandoned.size) {
    log(`abandoned: ${[...abandoned].join(", ")} — run them again later`);
  }

  if (options.dryRun) {
    log("dry run — nothing written");
    return;
  }

  /* --- write the records back ----------------------------------------- */
  const now = new Date().toISOString();
  for (const { file, data } of files) {
    const changed = data.channels.some((c) => touched.has(c.id));
    if (!changed) continue;
    writeJson(file, { ...data, generatedAt: now } satisfies ChannelFile);
  }
  log(`${touched.size} channel(s) written back`);

  /* --- the summaries ---------------------------------------------------- */
  /**
   * The list views read the summaries, not the records, so the avatar has to
   * land there too — otherwise the cards would still show a broken image.
   */
  const summariesRoot = path.join(DATA_DIR, "channels", "summaries");
  let summaryFiles = 0;
  if (fs.existsSync(summariesRoot)) {
    const byId = new Map(all.map((c) => [c.id, c]));
    for (const region of fs.readdirSync(summariesRoot)) {
      const dir = path.join(summariesRoot, region);
      if (!fs.statSync(dir).isDirectory()) continue;
      for (const file of fs.readdirSync(dir)) {
        if (!file.endsWith(".json")) continue;
        const full = path.join(dir, file);
        const data = readJson<{
          schemaVersion: number;
          generatedAt: string;
          channels: any[];
        }>(full, { schemaVersion: 1, generatedAt: "", channels: [] });
        let changed = false;
        for (const summary of data.channels) {
          const channel = byId.get(summary.id);
          if (!channel) continue;
          const next = toSummary(channel);
          if (JSON.stringify(next) !== JSON.stringify(summary)) {
            data.channels[data.channels.indexOf(summary)] = next;
            changed = true;
          }
        }
        if (!changed) continue;
        writeJson(full, { ...data, generatedAt: now });
        summaryFiles++;
      }
    }
  }
  log(`${summaryFiles} summary shard(s) updated`);
}

main().catch((err) => {
  console.error(`[avatars] failed: ${(err as Error).message}`);
  process.exit(1);
});
