#!/usr/bin/env tsx
/**
 * Finds the missing cross-platform accounts of the catalogue.
 *
 * vdb files **9,000+ performers under Bilibili alone** — no YouTube channel,
 * no Twitch login, no X handle. For many of them that is simply the roster's
 * gap: the performer has a YouTube channel, their Bilibili signature or X bio
 * links to it, and YouTube's published country is the fact that says which
 * region they belong to.
 *
 * ```bash
 * npm run data:links -- --limit 200
 * npm run data:links -- --dry-run --limit 20
 * npm run data:links -- --platform bilibili --shard 2/4
 * npm run data:links -- --platform bilibili --region jp   # the Japanese mirror backlog
 * npm run data:links -- --web --limit 50      # + search-grounded fallback
 * ```
 *
 * ## Where the links come from, in order
 *
 * 1. **The performer's own text** — the Bilibili signature, the YouTube about
 *    page, the handles already in `externals`.
 * 2. **Their X profile**, read through the public FxTwitter mirror: the bio
 *    and the website field are where a Japanese VTuber puts their YouTube.
 * 3. **Wikidata**, by name in Japanese, Chinese and English — `P2397` is the
 *    YouTube channel id, `P4047` the Twitch login.
 * 4. **YouTube's own channel search**, by the record's display name. It costs
 *    no Data API quota, and it is the source a Japanese VTuber filed under
 *    Bilibili alone needs: they *have* a YouTube channel, named after them.
 * 5. **Web search** (`--web`, needs `GEMINI_API_KEY`), for the ones nothing
 *    else covers.
 *
 * Sources 3, 4 and 5 answer a **name** match, so the account they return has
 * to prove it is the same performer: its description must point back at the
 * record (the Bilibili space id, the X handle) or its name must be the
 * record's — containment either way, because 「雫るる_Official」 and 「雫るる」
 * are the same name with different decoration. A search result that is a clip
 * or fan account is dropped even when the name matches, because 切片 channels
 * are named after the person they clip. A candidate that cannot prove it is
 * dropped.
 *
 * ## What it writes
 *
 * The new `platforms[]` link, the handles it harvested, the description it
 * fetched, and — when a YouTube channel was found and publishes a country —
 * the **region**. It never renames the record: the performer's own platform
 * is still the authority for the name.
 *
 * It does **re-key** it: a record keyed `bilibili:…` whose own YouTube channel
 * has just been found is keyed by that `UC…` id when the run writes
 * (`canonicalizeChannelIds()`), its items are re-pointed at it, and the
 * duplicate that creates is merged.
 */

import {
  acquireRunLock,
  readJson,
} from "./lib/io";
import {
  layout,
  readAllChannelRecords,
  readAllItems,
  rebuildChannelsManifest,
  refreshManifestChannelCounts,
  writeChannelShards,
  writeItemShards,
} from "./lib/dataset";
import { logLine, progressBar } from "./lib/progress";
import { InnerTubeSource } from "./lib/youtubei";
import { TwitchGqlSource } from "./lib/twitch-gql";
import { createAdapters } from "./lib/platform-registry";
import {
  canonicalizeChannelIds,
  dedupePlatformLinks,
  mergeChannels,
  REGION_TRUST,
} from "./lib/dedupe";
import { classifyChannel } from "./lib/classify";
import { REGION_LANGUAGE, profileLanguage } from "./lib/regions";
import { isPlaceholderName, primaryPlatformOf } from "./lib/platforms";
import { shardOf } from "./lib/shard";
import { splitName } from "./lib/names";
import { searchByName } from "./lib/wikidata";
import { WebLinkFinder } from "./lib/web-links";
import {
  addMissingLinks,
  confirmingNames,
  harvestExternals,
  linksFromWikidata,
  linksFromXProfile,
  linksInText,
  resolveCandidate,
  type LinkCandidate,
  type LinkContext,
  type ResolvedLink,
} from "./lib/link-discovery";
import type { Channel, PlatformId, RegionCode } from "./lib/types";

/* -------------------------------------------------------------------------- */
/* Arguments                                                                  */
/* -------------------------------------------------------------------------- */

interface Options {
  limit: number;
  platform: PlatformId | null;
  dryRun: boolean;
  /** Also ask a search-grounded model for the accounts nothing else found. */
  web: boolean;
  /** The gap between requests, in milliseconds. */
  intervalMs: number;
  /** Which deterministic slice of the backlog this run owns. */
  shardIndex: number;
  shardCount: number;
  /** Re-check records that already have a YouTube or Twitch link. */
  force: boolean;
  /** Only the records whose region is a guess. */
  weakRegion: boolean;
  /**
   * Only the records of one region.
   *
   * The backlog is 9,000 Bilibili-only performers, and the ones worth asking
   * first are not the head of an alphabetical list: a Japanese VTuber filed
   * under Bilibili is the *mirror* case this pass exists to correct, and
   * their YouTube channel is the account that proves it.
   */
  region: RegionCode | null;
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    limit: 200,
    platform: null,
    dryRun: false,
    web: false,
    intervalMs: 500,
    shardIndex: 1,
    shardCount: 1,
    force: false,
    weakRegion: false,
    region: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--limit") options.limit = Number(argv[++i] ?? options.limit);
    else if (arg === "--platform") {
      options.platform = (argv[++i] ?? "") as PlatformId;
    } else if (arg === "--interval") {
      options.intervalMs = Number(argv[++i] ?? options.intervalMs);
    } else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--web") options.web = true;
    else if (arg === "--force") options.force = true;
    else if (arg === "--weak-region" || arg === "--regions") {
      options.weakRegion = true;
    } else if (arg === "--region") {
      options.region = (argv[++i] ?? "") as RegionCode;
    } else if (arg === "--shard") {
      const match = /^(\d+)\s*\/\s*(\d+)$/.exec(argv[++i] ?? "");
      if (match) {
        const count = Number(match[2]);
        const index = Number(match[1]);
        if (count >= 1 && index >= 1 && index <= count) {
          options.shardIndex = index;
          options.shardCount = count;
        }
      }
    }
  }
  if (!Number.isFinite(options.limit) || options.limit <= 0) options.limit = 200;
  return options;
}

/* -------------------------------------------------------------------------- */
/* Logging                                                                    */
/* -------------------------------------------------------------------------- */

const started = Date.now();
let scanned = 0;
let failed = 0;
const addedByPlatform = new Map<PlatformId, number>();
let regionFixed = 0;
let webQueries = 0;
let webHits = 0;

function log(message: string): void {
  const seconds = ((Date.now() - started) / 1000).toFixed(0);
  /* Clears the bar, prints, repaints — see `lib/progress.ts`. */
  logLine(`[links:${seconds}s] ${message}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* -------------------------------------------------------------------------- */
/* Candidates                                                                 */
/* -------------------------------------------------------------------------- */

/** A single platform account a record already links to, as a candidate. */
function candidatesFromExternals(channel: Channel): LinkCandidate[] {
  const out: LinkCandidate[] = [];
  for (const [platform, handle] of Object.entries(channel.externals ?? {})) {
    if (platform === "youtube" || platform === "twitch") {
      out.push({ platform, id: String(handle), via: "externals" });
    }
  }
  return out;
}

/** The names worth asking Wikidata about, cheapest first. */
function wikidataNames(channel: Channel): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of [channel.name, ...(channel.aliases ?? [])]) {
    const value = (name ?? "").trim();
    if (value.length < 3) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
    if (out.length >= 2) break;
  }
  return out;
}

/**
 * Whether a Wikidata answer is worth resolving.
 *
 * Wikidata search is fuzzy: 「月乃美緒」 returns 「Tsukino Mito」. The item's
 * labels have to agree with one of the record's names — and the name has to
 * be distinctive enough to mean something.
 */
function wikidataAgrees(
  labels: string[],
  channel: Channel,
): boolean {
  /**
   * The record's **display name**, never an alias. 「维多利亚」's alias is
   * `Victoria`, and the city of Victoria has a Wikidata item and a YouTube
   * channel — a name match on the alias would adopt the city.
   */
  const names = confirmingNames(channel);
  if (!names.length) return false;
  return labels.some((label) => {
    const normalized = label
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]/gu, "")
      .trim();
    if (!normalized) return false;
    return names.some(
      (name) => name === normalized || normalized.includes(name),
    );
  });
}

/* -------------------------------------------------------------------------- */
/* The primary profile                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Refreshes the record's own profile.
 *
 * The description is the point: a Bilibili signature is the only text most of
 * these records have, and it is where a performer writes their other
 * accounts. The avatar and the follower count come free with the same
 * request, so a record that has neither is filled in as well.
 */
async function refreshPrimary(
  channel: Channel,
  ctx: LinkContext,
): Promise<string | null> {
  const primary = primaryPlatformOf(channel);
  if (!primary) return null;
  const link = channel.platforms.find((p) => p.platform === primary);
  if (!link) return null;

  const resolved = await resolveCandidate(
    { platform: primary, id: link.handle ?? link.id, via: "description" },
    ctx,
  );
  if (!resolved) return null;

  if (!link.avatar && resolved.link.avatar) link.avatar = resolved.link.avatar;
  if (
    link.subscribers.tag === "hidden" &&
    resolved.link.subscribers.tag !== "hidden"
  ) {
    link.subscribers = resolved.link.subscribers;
  }
  link.lastCheckedAt = new Date().toISOString();

  /**
   * A description has to be a description.
   *
   * Bilibili answers a deleted account with the signature 「账号已注销」 —
   * a tombstone, not something the performer wrote — and storing it would
   * put a gravestone on the card.
   */
  if (
    !channel.description &&
    resolved.description &&
    !isPlaceholderName(resolved.description)
  ) {
    channel.description = resolved.description.slice(0, 1000);
  }
  return resolved.text;
}

/* -------------------------------------------------------------------------- */
/* The region a discovered YouTube channel implies                            */
/* -------------------------------------------------------------------------- */

/**
 * Applies the country and the names of a discovered YouTube channel.
 *
 * A region is a fact about the **performer**, so the discovered channel may
 * only correct it when what it says outranks what is already known: a
 * published country (or kana in the channel's own name) beats the
 * "Bilibili-only, so Chinese" prior, and never replaces an agency, a roster's
 * nationality or a hand-written override.
 */
function applyDiscoveredYouTube(channel: Channel, resolved: ResolvedLink): void {
  const country = resolved.country ?? null;

  /**
   * The channel's own title is a name the performer publishes. The record's
   * display name stays the primary platform's, but every part of the title
   * becomes an alias, so 「向葵 / あおい」 is findable from the Japanese name.
   */
  const title = resolved.link.name;
  if (title) {
    for (const part of splitName(title)) {
      if (
        part.length >= 2 &&
        part.toLowerCase() !== channel.name.toLowerCase() &&
        !channel.aliases.some((a) => a.toLowerCase() === part.toLowerCase())
      ) {
        channel.aliases.push(part);
      }
    }
    if (channel.aliases.length > 12) channel.aliases = channel.aliases.slice(-12);
  }

  if (!country) return;

  const fresh = classifyChannel({
    name: channel.name,
    description: channel.description,
    tags: channel.tags,
    country,
    platform: primaryPlatformOf(channel) ?? undefined,
  });
  if (
    REGION_TRUST[fresh.regionSource] >
    REGION_TRUST[channel.regionSource ?? "unknown"]
  ) {
    const before = `${channel.region} (${channel.regionSource ?? "unknown"})`;
    channel.country = country;
    channel.region = fresh.region;
    channel.regionSource = fresh.regionSource;
    if (!(channel.statedLanguages?.length ?? 0)) {
      const language = REGION_LANGUAGE[fresh.region];
      if (language) channel.languages = [language];
    }
    regionFixed++;
    log(
      `region: ${before} → ${channel.region} (${fresh.regionSource}) · ${channel.name} · youtube country ${country}`,
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Main                                                                       */
/* -------------------------------------------------------------------------- */

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const releaseLock = acquireRunLock("links");
  const overrides = readJson<Record<string, { name?: string; region?: string }>>(
    layout.overrides,
    {},
  );

  /** The run's single timestamp, so every record it touched agrees. */
  const now = new Date().toISOString();

  log("reading the dataset…");
  const all = readAllChannelRecords();
  log(`${all.length} channel(s) in the dataset`);

  const pending = all
    .filter((channel) => {
      if (options.shardCount > 1) {
        if (shardOf(channel.id, options.shardCount) !== options.shardIndex - 1) {
          return false;
        }
      }
      if (options.platform && primaryPlatformOf(channel) !== options.platform) {
        return false;
      }
      if (overrides[channel.id]?.region) return false;
      if (options.region && channel.region !== options.region) return false;
      const platforms = new Set((channel.platforms ?? []).map((p) => p.platform));
      if (!options.force) {
        // The gap this pass exists to close, plus the X-only accounts whose
        // bio is the one place the YouTube channel is written down.
        const hasVideoPlatform = platforms.has("youtube") || platforms.has("twitch");
        if (hasVideoPlatform) return false;
        if (!platforms.has("bilibili") && !platforms.has("twitter")) return false;
      }
      if (options.weakRegion) {
        return ["platform", "declared", "script", "unknown"].includes(
          channel.regionSource ?? "unknown",
        );
      }
      return true;
    })
    /**
     * The queue advances.
     *
     * Every record this pass looks at is stamped with
     * `lastDetailsFetchedAt` (whether or not a link was found), so sorting by
     * it **oldest first** walks the backlog instead of retrying the same head
     * forever: a record that yields nothing is not a record that needs
     * looking at again tomorrow. Within the untouched set, an X account is
     * the cheapest route to a link, then a description.
     */
    .sort((a, b) => {
      const seen = (channel: Channel): string =>
        channel.lastDetailsFetchedAt ?? "";
      const score = (channel: Channel): number => {
        const platforms = new Set(
          (channel.platforms ?? []).map((p) => p.platform),
        );
        return (
          (platforms.has("twitter") ? 0 : 2) + (channel.description ? 0 : 1)
        );
      };
      return (
        seen(a).localeCompare(seen(b)) ||
        score(a) - score(b) ||
        a.id.localeCompare(b.id)
      );
    })
    .slice(0, options.limit);

  log(
    options.platform
      ? `${pending.length} ${options.platform} record(s) without a YouTube or Twitch link`
      : `${pending.length} record(s) without a YouTube or Twitch link`,
  );

  /* --- the sources ------------------------------------------------------ */
  const innertube = new InnerTubeSource({
    delayMs: options.intervalMs,
    onLog: (m) => log(m),
  });
  await innertube.connect();
  const twitch = new TwitchGqlSource({
    delayMs: options.intervalMs,
    onLog: (m) => log(m),
  });
  const adapters = new Map<PlatformId, any>();
  for (const adapter of createAdapters({
    youtubeClient: null,
    twitchClient: null,
  })) {
    adapters.set(adapter.id, adapter);
  }
  const ctx: LinkContext = { innertube, twitch, adapters };

  const apiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY ?? "";
  const web =
    options.web && apiKey
      ? new WebLinkFinder({ apiKey, onLog: (m) => log(m) })
      : null;
  if (options.web && !apiKey) {
    log("--web was given but GEMINI_API_KEY is not set — skipping web search");
  }

  /** Every record this run changed, by the id it had when it was read. */
  const updatedById = new Map<string, Channel>();

  /**
   * Which record already owns each platform account.
   *
   * A discovered channel that another record already points at would turn
   * one performer into two, so it is skipped: the account is taken, and the
   * right fix for that pair is a merge, not a second link.
   */
  const owners = new Map<string, string>();
  for (const record of all) {
    for (const link of record.platforms ?? []) {
      owners.set(`${link.platform}:${link.id}`, record.id);
    }
  }

  const bar = progressBar("links", pending.length, { unit: "channels" });

  for (const channel of pending) {
    scanned++;
    /** The links the record arrived with — never removed by this pass. */
    const originalLinks = new Set(
      (channel.platforms ?? []).map((link) => `${link.platform}:${link.id}`),
    );

    /* --- 1. the performer's own text ---------------------------------- */
    const profileText = await refreshPrimary(channel, ctx);
    const candidates: LinkCandidate[] = [];

    harvestExternals(channel, channel.description);
    const descriptionCandidates =
      profileText && profileText !== channel.description
        ? [...linksFromText(profileText), ...linksFromText(channel.description)]
        : linksFromText(channel.description);
    candidates.push(...descriptionCandidates, ...candidatesFromExternals(channel));

    /* --- 2. the X profile --------------------------------------------- */
    const xHandle = xHandleOf(channel);
    if (xHandle) {
      const xLinks = await linksFromXProfile(xHandle);
      candidates.push(...xLinks);
      if (xLinks.length) {
        log(`  x: @${xHandle} → ${xLinks.length} link(s)`);
      }
    }

    /* --- 3. Wikidata, only when nothing was found ---------------------- */
    let added = await addMissingLinks(channel, dedupeCandidates(candidates), ctx);
    if (!added.length) {
      for (const name of wikidataNames(channel)) {
        const matches = await searchByName(name);
        let usable = false;
        for (const match of matches) {
          if (!wikidataAgrees(match.labels, channel)) continue;
          const links = linksFromWikidata(match);
          if (!links.length) continue;
          usable = true;
          const found = await addMissingLinks(channel, links, ctx);
          added.push(...found);
        }
        if (usable || added.length) break;
        await sleep(200);
      }
    }

    /* --- 3b. YouTube's own channel search, by name --------------------- */
    /**
     * A Japanese VTuber filed under Bilibili alone usually *does* have a
     * YouTube channel, and it is named after them. InnerTube's channel search
     * costs no quota, and the confirmation is the same one a name search
     * always gets: the channel's name has to be the record's, and a clip or
     * fan account that happens to carry the name is rejected
     * (`addMissingLinks()` → `confirmsIdentity()`).
     */
    if (!added.length) {
      const byName = await youtubeNameSearch(channel, ctx);
      if (byName.length) {
        const found = await addMissingLinks(channel, byName, ctx);
        added.push(...found);
        if (found.length) {
          log(
            `  youtube: name search → ` +
              found.map((link) => link.link.name ?? link.link.id).join(", "),
          );
        }
      }
    }

    /* --- 4. web search, the optional fallback -------------------------- */
    const hasVideo = channel.platforms.some(
      (link) => link.platform === "youtube" || link.platform === "twitch",
    );
    if (web && !hasVideo) {
      webQueries++;
      const result = await web.find({
        name: channel.name,
        aliases: channel.aliases,
        region: channel.region,
        knownUrls: channel.platforms.map((link) => link.url),
      });
      await web.throttle();
      if (result) {
        webHits++;
        log(
          `  web: ${channel.name} → yt=${result.youtube.length} tw=${result.twitch.length} x=${result.x.length} (${result.confidence.toFixed(2)})`,
        );
        const webCandidates: LinkCandidate[] = [
          ...result.youtube.map((id) => ({
            platform: "youtube" as const,
            id,
            via: "search" as const,
          })),
          ...result.twitch.map((id) => ({
            platform: "twitch" as const,
            id,
            via: "search" as const,
          })),
        ];
        const found = await addMissingLinks(channel, webCandidates, ctx);
        added.push(...found);
      }
    }

    /* --- an account another record already owns is not ours ------------ */
    const accepted = added.filter((link) => {
      const key = `${link.link.platform}:${link.link.id}`;
      const owner = owners.get(key);
      if (!owner || owner === channel.id) return true;
      log(`  skip ${key}: already the account of ${owner}`);
      return false;
    });
    if (accepted.length !== added.length) {
      const keep = new Set(
        accepted.map((link) => `${link.link.platform}:${link.link.id}`),
      );
      channel.platforms = channel.platforms.filter((link) => {
        const key = `${link.platform}:${link.id}`;
        return originalLinks.has(key) || keep.has(key);
      });
    }
    added = accepted;
    for (const link of added) {
      owners.set(`${link.link.platform}:${link.link.id}`, channel.id);
    }

    /* --- the region the discovered YouTube channel implies ------------- */
    const youtube = added.find((link) => link.link.platform === "youtube");
    if (youtube) applyDiscoveredYouTube(channel, youtube);

    for (const link of added) {
      addedByPlatform.set(
        link.link.platform,
        (addedByPlatform.get(link.link.platform) ?? 0) + 1,
      );
      log(
        `+ ${link.link.platform}: ${link.link.name ?? link.link.id} · ${channel.name}`,
      );
    }

    /**
     * The record was looked at, so it goes to the back of the queue — even
     * when nothing was found. Without this stamp the same head of the
     * backlog would be retried every run and the rest never reached.
     */
    channel.lastDetailsFetchedAt = now;
    updatedById.set(channel.id, channel);

    bar.tick(`${channel.name} · ${summaryLine()}`);
    await sleep(options.intervalMs);
  }

  bar.done(`${scanned}/${pending.length} scanned · ${summaryLine()} · ${failed} failed`);
  if (web) {
    log(`web search: ${webQueries} queried · ${webHits} answered`);
  }

  if (options.dryRun) {
    log("dry run — nothing written");
    releaseLock();
    return;
  }

  /* --- write the records back ----------------------------------------- */
  if (!updatedById.size) {
    log("nothing to write");
    releaseLock();
    return;
  }

  const fresh = readAllChannelRecords();
  const byId = new Map<string, Channel>();
  let written = 0;
  for (const record of fresh) {
    const updated = updatedById.get(record.id);
    if (updated) {
      record.platforms = dedupePlatformLinks(updated.platforms);
      record.externals = updated.externals;
      record.description = updated.description ?? record.description;
      record.aliases = updated.aliases;
      record.country = updated.country;
      record.region = updated.region;
      record.regionSource = updated.regionSource;
      record.languages = updated.languages;
      record.lastDetailsFetchedAt = now;
      written++;
    }
    const seen = byId.get(record.id);
    byId.set(record.id, seen ? mergeChannels(record, seen) : record);
  }
  /**
   * The id follows the channel that was found.
   *
   * A record keyed `bilibili:…` whose own YouTube channel has just been
   * discovered is keyed by that `UC…` id — the same rule the sync runs — and
   * the duplicate it creates, when the YouTube channel already had a record,
   * is merged. Without this the link would be stored and the record would stay
   * on the id the link was found to replace.
   */
  const canonical = canonicalizeChannelIds([...byId.values()]);
  if (canonical.renamed.length) {
    for (const { from, to } of canonical.renamed) log(`ids: ${from} → ${to}`);
    if (canonical.merged) {
      log(
        `ids: merged ${canonical.merged} duplicate record(s) with the same channel`,
      );
    }
    const followed = remapItemChannelIds(canonical.renamed, now);
    if (followed) log(`ids: ${followed} item(s) re-pointed at their channel`);
  }
  const shards = writeChannelShards(canonical.channels, now);
  /**
   * A region corrected from the discovered channel moves the record to
   * another shard **and** changes the per-region counts, so both maps are
   * rebuilt with it — otherwise the manifest names a file that no longer
   * exists, or reports a region size the app cannot load.
   */
  rebuildChannelsManifest(canonical.channels, now);
  refreshManifestChannelCounts(canonical.channels, now);
  log(`${written} channel(s) updated · ${shards.files} shard(s) written`);

  releaseLock();
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/** Re-points items at their channel's new id, after a re-key. */
function remapItemChannelIds(
  renamed: { from: string; to: string }[],
  now: string,
): number {
  const remap = new Map(renamed.map((entry) => [entry.from, entry.to]));
  const items = readAllItems();
  let changed = 0;
  for (const item of items) {
    const to = remap.get(item.channelId);
    if (!to) continue;
    item.channelId = to;
    changed++;
  }
  if (changed) writeItemShards(items, now);
  return changed;
}

/**
 * YouTube channels whose name is the record's own.
 *
 * Only the **display name** is searched, never an alias: an alias is a
 * romanisation or a translation the pipeline added (`vdb` lists 「维多利亚」 as
 * `Victoria`), and a common romanisation belongs to something else. The name
 * also has to be distinctive — `confirmingNames()` refuses one- and
 * two-character names, because 「ゆず」 is hundreds of channels.
 */
async function youtubeNameSearch(
  channel: Channel,
  ctx: LinkContext,
): Promise<LinkCandidate[]> {
  const query = (channel.name ?? "").trim();
  if (!query || !confirmingNames(channel).length) return [];
  const ids = await ctx.innertube.searchChannels(query, 8);
  return ids.map((id) => ({
    platform: "youtube" as const,
    id,
    via: "search" as const,
  }));
}

/** The X handle a record publishes, from a platform link or `externals`. */
function xHandleOf(channel: Channel): string | null {
  const link = channel.platforms.find((p) => p.platform === "twitter");
  if (link) {
    const fromUrl = /(?:twitter|x)\.com\/([A-Za-z0-9_]+)/i.exec(link.url ?? "");
    const handle = link.handle ?? fromUrl?.[1] ?? link.id;
    if (handle) return String(handle).replace(/^@/, "");
  }
  const external = channel.externals?.twitter ?? channel.externals?.x;
  return external ? String(external).replace(/^@/, "") : null;
}

/** Every identity a block of text mentions, as candidates. */
function linksFromText(text: string | null | undefined): LinkCandidate[] {
  return linksInText(text, "description");
}

/** Removes duplicate candidates, keeping the first (most trusted) sighting. */
function dedupeCandidates(candidates: LinkCandidate[]): LinkCandidate[] {
  const seen = new Set<string>();
  const out: LinkCandidate[] = [];
  for (const candidate of candidates) {
    const key = `${candidate.platform}:${candidate.id.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(candidate);
  }
  return out;
}

function summaryLine(): string {
  const parts = [...addedByPlatform.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([platform, count]) => `${platform} ${count}`);
  return (
    (parts.length ? `${parts.join(" · ")} link(s)` : "no new links") +
    (regionFixed ? ` · ${regionFixed} region(s) fixed` : "")
  );
}

main().catch((err) => {
  console.error(`[links] failed: ${(err as Error).message}`);
  process.exit(1);
});
