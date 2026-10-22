#!/usr/bin/env tsx
/**
 * YouTube Data API v3 sync pipeline.
 *
 * Reads the current dataset from `data/`, refreshes it from the YouTube Data
 * API within a fixed quota budget, and writes the new snapshot back to `data/`.
 *
 *   npm run sync              # normal run (uses YOUTUBE_API_KEY)
 *   npm run sync -- --dry-run # fetch + classify, print summary, write nothing
 *   npm run sync -- --no-search # only refresh known channels (1 unit each)
 *   npm run sync -- --budget 500 # cap this run at 500 quota units
 *
 * The script is designed to run unchanged in GitHub Actions: it only needs
 * `YOUTUBE_API_KEY` and writes exclusively inside the repository.
 */

import path from "node:path";
import fs from "node:fs";
import {
  YouTubeClient,
  QuotaBudget,
  QuotaExceededError,
  pickThumbnail,
  parseIsoDuration,
  uploadsPlaylistId,
  API_COST,
} from "./lib/youtube";
import {
  classifyChannel,
  classifyItem,
  detectActivity,
  detectAffiliation,
  extractCollaboratorNames,
  isShortItem,
} from "./lib/classify";
import { ALL_SEEDS, type SeedEntry } from "./lib/seeds";
import {
  extractExternalLinks,
  extractTwitchLogin,
  TwitchClient,
} from "./lib/twitch";
import { createAdapters } from "./lib/platform-registry";
import { orderPlatformLinks, pickAvatar, primaryPlatformOf } from "./lib/platforms";
import { fetchAiList, isOnAiList } from "./lib/aislist";
import { fetchTrackedVtubers } from "./lib/taiwan-vtuber-data";
import { buildRoster } from "./lib/roster";
import { dedupeChannels, mergeChannels } from "./lib/dedupe";
import { IdentityRegistry } from "./lib/identity";
import { fetchMusicDataset, indexMusicDataset } from "./lib/music-dataset";
import { deriveVariant } from "./lib/classify";
import type {
  PlatformAdapter,
  PlatformChannel,
  PlatformUpload,
} from "./lib/platforms";
import {
  CACHE_DIR,
  paths,
  readJson,
  mergeById,
  ROOT,
} from "./lib/io";
import {
  layout,
  writeDataset,
  describeDatasetSize,
  readAllChannelRecords,
} from "./lib/dataset";
import { buildRegionMeta } from "./lib/regions";
import type {
  Channel,
  ChannelFile,
  Item,
  ItemFile,
  Manifest,
  ManifestCounts,
  RecordSource,
} from "./lib/types";
import { SCHEMA_VERSION, toCountRef } from "./lib/types";
import type { Collaborator, PlatformLink } from "./lib/types";

/* -------------------------------------------------------------------------- */
/* CLI                                                                        */
/* -------------------------------------------------------------------------- */

interface Args {
  dryRun: boolean;
  noSearch: boolean;
  /** Skip every YouTube API call; only apply the external enrichments. */
  offline: boolean;
  /**
   * Rebuild the channel roster from the authoritative public sources
   * (the Taiwan VTuber track list, the curated seeds and the other
   * platforms) before syncing.
   */
  roster: boolean;
  budget: number;
  quotaLimit: number;
  limitChannels: number | null;
  keywords: string[];
  force: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    dryRun: false,
    noSearch: false,
    offline: false,
    roster: false,
    budget: 10_000,
    quotaLimit: 10_000,
    limitChannels: null,
    keywords: [],
    force: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--no-search") args.noSearch = true;
    else if (a === "--offline") args.offline = true;
    else if (a === "--roster") args.roster = true;
    else if (a === "--force") args.force = true;
    else if (a === "--budget") args.budget = Number(argv[++i]);
    else if (a === "--quota") args.quotaLimit = Number(argv[++i]);
    else if (a === "--limit-channels") args.limitChannels = Number(argv[++i]);
    else if (a === "--keyword") args.keywords.push(argv[++i]);
  }
  return args;
}

/* -------------------------------------------------------------------------- */
/* Config                                                                     */
/* -------------------------------------------------------------------------- */

interface SearchSpec {
  query: string;
  type: "channel" | "video";
  region: string;
  eventType?: "live" | "upcoming";
}

interface SyncConfig {
  maxSearchesPerRun: number;
  maxChannelsPerRun: number;
  maxItemsPerChannel: number;
  maxItemsPerChannelRetained: number;
  maxItemAgeDays: number;
  maxLiveChannelsPerRun: number;
  maxChannelDetailsPerRun: number;
  detailsDelayMs: number;
  searchResultsPerKeyword: number;
  refreshLiveEveryRun: boolean;
  searches: SearchSpec[];
}

const config: SyncConfig = readJson(
  path.join(ROOT, "config", "sync.config.json"),
  {
    maxSearchesPerRun: 40,
    maxChannelsPerRun: 60,
    maxItemsPerChannel: 25,
    maxItemsPerChannelRetained: 30,
    maxItemAgeDays: 365,
    maxLiveChannelsPerRun: 60,
    maxChannelDetailsPerRun: 200,
    detailsDelayMs: 700,
    searchResultsPerKeyword: 25,
    refreshLiveEveryRun: true,
    searches: [],
  },
);

/* -------------------------------------------------------------------------- */
/* Overrides                                                                  */
/* -------------------------------------------------------------------------- */

interface Override {
  kind?: Channel["kind"];
  role?: Channel["role"];
  region?: Channel["region"];
  agency?: string | null;
  gender?: Channel["gender"];
  isAi?: boolean;
  isSinging?: boolean;
  /** Hide a channel from the public dataset. */
  hidden?: boolean;
  /** Who verified this record, and when. Written by `scripts/verify.ts`. */
  verifiedBy?: string;
  verifiedAt?: string;
  /** Why the correction was made. */
  note?: string;
}

type OverrideMap = Record<string, Override>;

const overrides: OverrideMap = readJson<OverrideMap>(paths.overrides, {});

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

const nowIso = () => new Date().toISOString();

function log(msg: string): void {
  console.log(`[sync] ${msg}`);
}

function toNumber(v: unknown): number | null {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Truncates free-text fields so the dataset stays small. */
function truncate(value: string | null | undefined, max: number): string | null {
  if (!value) return null;
  const s = value.trim();
  if (!s) return null;
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/* -------------------------------------------------------------------------- */
/* Normalisation: API → Channel                                               */
/* -------------------------------------------------------------------------- */

function channelFromApi(
  raw: any,
  source: RecordSource,
  now: string,
  override?: Override,
): Channel | null {
  if (!raw?.id) return null;
  const snippet = raw.snippet ?? {};
  const stats = raw.statistics ?? {};
  const contentDetails = raw.contentDetails ?? {};
  const branding = raw.brandingSettings ?? {};

  const description = snippet.description ?? "";
  const classification = classifyChannel({
    name: snippet.title ?? "",
    description,
    tags: snippet.tags ?? [],
    country: branding.country ?? null,
    platform: "youtube",
    override: override
      ? {
          kind: override.kind,
          role: override.role,
          region: override.region,
          agency: override.agency,
          isSinging: override.isSinging,
        }
      : undefined,
  });

  // Gender and the AI flag are applied after the classifier, because they are
  // curated facts rather than inferred ones.
  const gender = override?.gender ?? classification.gender;
  const isAi = override?.isAi ?? classification.isAi;

  return {
    id: raw.id,
    name: snippet.title ?? "Unknown",
    handle: snippet.customUrl ? snippet.customUrl.replace(/^@/, "") : null,
    kind: classification.kind,
    role: classification.role,
    region: classification.region,
    regionSource: classification.regionSource,
    language: classification.language,
    agency: classification.agency,
    affiliation: detectAffiliation(
      snippet.title,
      description,
      classification.agency,
    ),
    avatar: pickThumbnail(snippet.thumbnails, "high"),
    banner: branding.banner?.imageUrl
      ? pickThumbnail(
          [
            {
              url: branding.banner.imageUrl,
              width: branding.banner.imageUrlWidth ?? 2560,
              height: branding.banner.imageUrlHeight ?? 1440,
            },
          ],
          "max",
        )
      : null,
    description: truncate(description, 1000),
    subscribers: toCountRef(stats.subscriberCount),
    videoCount: toNumber(stats.videoCount),
    viewCount: toNumber(stats.viewCount),
    uploadsPlaylistId: contentDetails.relatedPlaylists?.uploads ?? null,
    country: branding.country ?? null,
    tags: (snippet.tags ?? []).slice(0, 30),
    isSinging: override?.isSinging ?? classification.isSinging,
    gender,
    isAi,
    variant: deriveVariant(
      override?.role ?? classification.role,
      gender,
      isAi,
    ),
    confidence: override?.verifiedAt
      ? { kind: 1, region: 1, role: 1, gender: 1, ai: 1, overall: 1 }
      : classification.confidence,
    source: override?.verifiedAt ? "manual" : source,
    addedAt: now,
    updatedAt: now,
    lastItemsFetchedAt: null,
    lastDetailsFetchedAt: null,

    activity: detectActivity(snippet.title, description, null),
    debutDate: null,
    graduateDate: null,

    platforms: [
      {
        platform: "youtube",
        id: raw.id,
        handle: snippet.customUrl ? snippet.customUrl.replace(/^@/, "") : null,
        name: snippet.title ?? null,
        url: `https://www.youtube.com/channel/${raw.id}`,
        subscribers: toCountRef(stats.subscriberCount),
        avatar: pickThumbnail(snippet.thumbnails, "high"),
        activity: "unknown",
        lastCheckedAt: now,
      },
    ],
    externals: extractExternalLinks(description),

    popularVideoId: null,
  };
}

/* -------------------------------------------------------------------------- */
/* Normalisation: API → Item                                                  */
/* -------------------------------------------------------------------------- */

function itemFromApi(
  raw: any,
  channel: Channel | undefined,
  source: RecordSource,
  now: string,
): Item | null {
  if (!raw?.id) return null;
  const snippet = raw.snippet ?? {};
  const stats = raw.statistics ?? {};
  const live = raw.liveStreamingDetails ?? {};

  const duration = parseIsoDuration(raw.contentDetails?.duration);
  const scheduledStart = live.scheduledStartTime ?? null;
  const actualStart = live.actualStartTime ?? null;
  const actualEnd = live.actualEndTime ?? null;

  let status: Item["status"] = "unknown";
  if (actualStart && actualEnd) status = "past";
  else if (actualStart) status = "live";
  else if (scheduledStart) status = "upcoming";

  const isShort = isShortItem(
    snippet.title ?? "",
    duration,
    snippet.description ?? null,
  );

  const classification = classifyItem({
    title: snippet.title ?? "",
    description: snippet.description ?? null,
    tags: snippet.tags ?? [],
    channelKind: channel?.kind ?? "virtual",
    status,
    isShort,
    durationSeconds: duration,
    channelRegion: channel?.region ?? "unknown",
  });

  /**
   * Everyone who performed on this upload.
   *
   * The uploader comes first; the other performers are read from the title
   * and, when the curated music dataset knows them, from its `collabVTuber`
   * and `memo` columns.
   */
  const collaborators: Collaborator[] = channel
    ? [
        {
          channelId: channel.id,
          name: channel.name,
          kind: channel.kind,
          region: channel.region,
        },
      ]
    : [];

  const type: Item["type"] =
    status === "live" || status === "upcoming"
      ? "live"
      : isShort
        ? "short"
        : "video";

  return {
    id: raw.id,
    type,
    channelId: channel?.id ?? snippet.channelId ?? "",
    channelName: channel?.name ?? snippet.channelTitle ?? "Unknown",
    channelKind: channel?.kind ?? "virtual",
    region: channel?.region ?? "unknown",
    gender: channel?.gender ?? "unknown",
    isAi: channel?.isAi ?? false,
    variant: channel?.variant ?? "unknown",
    title: snippet.title ?? "Untitled",
    description: truncate(snippet.description, 600),
    thumbnail: pickThumbnail(snippet.thumbnails, "high"),
    publishedAt: snippet.publishedAt ?? null,
    scheduledStart,
    actualStart,
    actualEnd,
    duration,
    status,
    category: classification.category,
    songTitle: classification.songTitle,
    originalArtist: classification.originalArtist,
    isCollab: classification.isCollab,
    collaborators: collaborators,
    isAcoustic: classification.isAcoustic,
    tags: (snippet.tags ?? []).slice(0, 25),
    viewCount: toNumber(stats.viewCount),
    likeCount: toNumber(stats.likeCount),
    concurrentViewers: toNumber(live.concurrentViewers),
    source,
    addedAt: now,
    updatedAt: now,
    lastItemsFetchedAt: null,
    lastDetailsFetchedAt: null,
  };
}

/* -------------------------------------------------------------------------- */
/* Item extraction from playlists & broadcasts                                */
/* -------------------------------------------------------------------------- */

interface RawVideo {
  id: string;
  title: string;
  description: string | null;
  tags: string[];
  channelId: string;
  channelTitle: string;
  publishedAt: string | null;
  thumbnails: any;
}

/** Pulls the upload list of a channel from its uploads playlist. */
async function fetchChannelVideos(
  client: YouTubeClient,
  channel: Channel,
  maxItems: number,
): Promise<RawVideo[]> {
  const playlistId =
    channel.uploadsPlaylistId ?? uploadsPlaylistId(channel.id);
  if (!playlistId) return [];

  const entries = await client.playlistItems(playlistId, maxItems);
  return entries
    .map((entry: any) => {
      const snippet = entry?.snippet ?? {};
      const resourceId = snippet?.resourceId ?? {};
      const videoId = resourceId.videoId ?? entry?.contentDetails?.videoId;
      if (!videoId) return null;
      return {
        id: videoId,
        title: snippet.title ?? "",
        description: snippet.description ?? null,
        tags: [],
        channelId: channel.id,
        channelTitle: channel.name,
        publishedAt: snippet.publishedAt ?? null,
        thumbnails: snippet.thumbnails,
      } as RawVideo;
    })
    .filter((v): v is RawVideo => v !== null);
}

/** Fetches full details (tags, stats, live info) for a list of video ids. */
async function fetchVideoDetails(
  client: YouTubeClient,
  ids: string[],
): Promise<any[]> {
  if (!ids.length) return [];
  return client.videos(ids);
}

/* -------------------------------------------------------------------------- */
/* Main                                                                       */
/* -------------------------------------------------------------------------- */

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const apiKey =
    process.env.YOUTUBE_API_KEY ?? process.env.YT_API_KEY ?? "";

  /**
   * Offline mode applies the external enrichment sources — the Taiwan VTuber
   * roster, AiSList and the music dataset — to the existing dataset without
   * touching the YouTube API. It needs no API key and spends no quota.
   */
  if (!apiKey && !args.offline) {
    console.error(
      "[sync] YOUTUBE_API_KEY is not set. Get a free key at https://console.cloud.google.com/apis/credentials and enable 'YouTube Data API v3'.\n" +
        "       (Use --offline to apply the external enrichments only, without an API key.)",
    );
    process.exit(1);
  }

  const quotaPath = path.join(CACHE_DIR, "quota.json");
  const budget = new QuotaBudget(quotaPath, args.quotaLimit);
  if (args.force) budget.overrideUsed(0);

  const client = apiKey
    ? new YouTubeClient({
        apiKey,
        cacheDir: path.join(CACHE_DIR, "youtube"),
        budget,
        onLog: (m) => log(m),
      })
    : null;

  const now = nowIso();

  /* --- load current dataset ------------------------------------------- */
  const existingChannels = readAllChannelRecords();

  const existingItems: Item[] = [];
  const itemsRoot = path.join(ROOT, "data", "items");
  if (fs.existsSync(itemsRoot)) {
    for (const region of fs.readdirSync(itemsRoot)) {
      const dir = path.join(itemsRoot, region);
      if (!fs.statSync(dir).isDirectory()) continue;
      for (const file of fs.readdirSync(dir)) {
        if (!file.endsWith(".json")) continue;
        existingItems.push(
          ...readJson<ItemFile>(path.join(dir, file), {
            schemaVersion: SCHEMA_VERSION,
            generatedAt: now,
            items: [],
          }).items,
        );
      }
    }
  }
  let channels = existingChannels;
  let items = existingItems;
  log(`loaded ${channels.length} channels / ${items.length} items from disk`);

  if (!client) {
    log("offline mode — skipping every YouTube API call");
  }

  /* --- resolve seeds --------------------------------------------------- */
  const seedByChannelId = new Map<string, SeedEntry>();
  const seedHandles: SeedEntry[] = [];
  for (const seed of ALL_SEEDS) {
    if (seed.channelId) seedByChannelId.set(seed.channelId, seed);
    else if (seed.handle) seedHandles.push(seed);
  }

  const seedIds = [...seedByChannelId.keys()];
  const resolvedSeeds: any[] = [];
  if (client && seedIds.length) {
    resolvedSeeds.push(...(await client.channels(seedIds)));
  }
  if (client && seedHandles.length) {
    try {
      resolvedSeeds.push(...(await client.resolveHandles(seedHandles.map((s) => s.handle!))));
    } catch (err) {
      log(`warn: seed handle resolution failed: ${(err as Error).message}`);
    }
  }
  log(`resolved ${resolvedSeeds.length}/${ALL_SEEDS.length} seeds`);

  /* --- discovery searches --------------------------------------------- */
  const discoveredChannelIds = new Set<string>();
  const discoveredVideoIds = new Set<string>();
  const platformChannelIds = new Set<string>();
  const platformCandidates: {
    adapter: PlatformAdapter;
    channel: PlatformChannel;
  }[] = [];

  const searchSpecs: SearchSpec[] = (
    args.keywords.length
      ? args.keywords.map((q) => ({
          query: q,
          type: "channel" as const,
          region: "jp",
        }))
      : config.searches
  ).slice(0, config.maxSearchesPerRun);

  if (!args.noSearch && client) {
    for (const spec of searchSpecs) {
      if (!budget.canAfford(API_COST.search)) {
        log("search budget exhausted — skipping remaining searches");
        break;
      }
      try {
        const results = await client.search(
          {
            q: spec.query,
            type: spec.type,
            ...(spec.eventType ? { eventType: spec.eventType } : {}),
            order: "viewCount",
          },
          budget,
        );
        for (const r of results) {
          const sn = r?.snippet ?? {};
          const channelId =
            sn?.channelId ?? (spec.type === "channel" ? r?.id?.channelId : null);
          if (channelId) discoveredChannelIds.add(channelId);
          if (spec.type === "video" && r?.id?.videoId) {
            discoveredVideoIds.add(r.id.videoId);
          }
        }
        log(
          `search "${spec.query}" (${spec.type}${spec.eventType ? `/${spec.eventType}` : ""}) → ${results.length} hits`,
        );
      } catch (err) {
        if (err instanceof QuotaExceededError) {
          log("quota exhausted during search — stopping");
          break;
        }
        log(`warn: search "${spec.query}" failed: ${(err as Error).message}`);
      }
    }
  }

  /* --- assemble the channel set --------------------------------------- */
  const channelById = new Map<string, Channel>();
  for (const c of channels) channelById.set(c.id, c);

  /* --- rebuild the channel roster -------------------------------------- */
  /**
   * The roster comes from the authoritative public sources rather than from
   * the legacy SQLite database, which has been removed: the Taiwan VTuber
   * track list publishes YouTube ids, aliases, debut and graduation dates,
   * activity status, nationality and Twitch ids for ~4,400 performers, and
   * the curated seeds cover the virtual and real artists outside that scene.
   */
  if (args.roster || !client) {
    const roster = await buildRoster({
      onLog: (m) => log(m),
    });
    for (const channel of roster) {
      const existing = channelById.get(channel.id);
      if (!existing) {
        channelById.set(channel.id, channel);
        continue;
      }
      /**
       * The roster wins on the facts it owns; anything it does not know is
       * kept from the existing record.
       *
       * `mergeChannels` is used rather than a hand-written field list: a
       * hand-written list silently drops every field it does not mention,
       * which is how `affiliation`, `language`, `gender` and friends went
       * missing from the dataset.
       */
      // The roster record is the target — it is the authoritative source —
      // and the existing record fills in the gaps it does not cover.
      channelById.set(channel.id, mergeChannels(channel, existing));
    }
    log(`roster: ${roster.length} channels, ${channelById.size} total`);
  }


  // 1. Seeded channels (highest priority for provenance).
  for (const raw of resolvedSeeds) {
    const seed =
      seedByChannelId.get(raw.id) ??
      seedHandles.find((s) => s.handle && raw.snippet?.customUrl?.endsWith(s.handle));
    const override = seed
      ? {
          kind: seed.kind,
          role: seed.role,
          region: seed.region,
          agency: seed.agency ?? null,
          isSinging: seed.isSinging,
        }
      : undefined;
    const ch = channelFromApi(raw, "seed", now, override);
    if (ch) channelById.set(ch.id, ch);
  }

  // 2. Discovered channels (refresh details for up to maxChannelsPerRun).
  const toRefresh = [...discoveredChannelIds]
    .filter((id) => !channelById.has(id) || args.force)
    .slice(0, config.maxChannelsPerRun);

  if (client && toRefresh.length) {
    try {
      const raws = await client.channels(toRefresh);
      for (const raw of raws) {
        const ch = channelFromApi(raw, "api", now, overrides[raw.id]);
        if (ch) channelById.set(ch.id, ch);
      }
      log(`refreshed ${raws.length} discovered channels`);
    } catch (err) {
      log(`warn: channel refresh failed: ${(err as Error).message}`);
    }
  }

  // 3. Refresh details of known channels (cheap: 1 unit per 50).
  const knownIds = [...channelById.keys()];
  if (client && knownIds.length) {
    try {
      const raws = await client.channels(knownIds);
      for (const raw of raws) {
        const prev = channelById.get(raw.id);
        const override = overrides[raw.id];
        const ch = channelFromApi(raw, prev?.source ?? "api", now, {
          ...(override ?? {}),
          // Preserve a curated kind/role unless an explicit override exists.
          ...(prev && prev.source === "seed" && !override
            ? {
                kind: prev.kind,
                role: prev.role,
                region: prev.region,
                agency: prev.agency,
                isSinging: prev.isSinging,
              }
            : {}),
        });
        if (ch) {
          ch.addedAt = prev?.addedAt ?? ch.addedAt;
          if (prev?.confidence) {
            ch.confidence = {
              kind: Math.max(prev.confidence.kind ?? 0, ch.confidence.kind),
              region: Math.max(prev.confidence.region, ch.confidence.region),
              role: Math.max(prev.confidence.role, ch.confidence.role),
              gender: Math.max(prev.confidence.gender, ch.confidence.gender),
              ai: Math.max(prev.confidence.ai, ch.confidence.ai),
              overall: 0,
            };
            ch.confidence.overall = Math.min(
              ch.confidence.kind,
              ch.confidence.region,
            );
          }
          channelById.set(ch.id, ch);
        }
      }
      log(`refreshed ${raws.length} known channels`);
    } catch (err) {
      log(`warn: known-channel refresh failed: ${(err as Error).message}`);
    }
  }

  channels = [...channelById.values()].filter((c) => !overrides[c.id]?.hidden);
  log(`channel set: ${channels.length}`);

  /** Every known item, keyed by id — the working set for this run. */
  const itemById = new Map<string, Item>();
  for (const i of items) itemById.set(i.id, i);

  /* --- de-duplicate ---------------------------------------------------- */
  /**
   * The same performer arrives from several sources under different ids — a
   * YouTube channel id and a Bilibili space id for the same person, for
   * example. Records that share an identity key are merged, so the dataset
   * lists every performer exactly once.
   */
  {
    const registry = IdentityRegistry.loadFromDisk();
    const result = dedupeChannels(channels, registry);
    channels = result.channels;
    log(
      `dedupe: ${result.merged} duplicate record(s) merged ` +
        `(${channels.length} unique channels)`,
    );
    for (const pair of result.pairs.slice(0, 5)) {
      log(`  merged ${pair.merged} → ${pair.kept}`);
    }
  }

  /**
   * The platform adapters. YouTube and Twitch are handled by their own
   * clients above; these are the ones that discover channels on their own.
   */
  const adapters = createAdapters({
    youtubeClient: null,
    twitchClient: null,
  });

  /* --- platform profile details ----------------------------------------- */
  /**
   * Fetch the profile of the channels whose details are missing.
   *
   * The description, the follower count and the platform-specific fields come
   * from the platform's own API, one channel at a time. That is far too many
   * requests to do in one run for a catalogue this size, so it is rotated:
   * the channels that have never been resolved come first, then the least
   * recently resolved.
   */
  {
    const budget = config.maxChannelDetailsPerRun;
    const adapterById = new Map(adapters.map((a) => [a.id as string, a]));

    /**
     * Only the channels this pass can actually improve.
     *
     * YouTube profiles come from the YouTube API refresh instead, so a
     * channel with no other platform is not a candidate — including it would
     * spend the whole budget on channels the pass cannot resolve.
     */
    const needDetails = channels
      .filter((c) => {
        const resolvable = c.platforms.some((p) => adapterById.has(p.platform));
        if (!resolvable) return false;
        return (
          !c.description ||
          c.platforms.some((p) => p.subscribers.tag === "hidden")
        );
      })
      .sort((a, b) =>
        (a.lastDetailsFetchedAt ?? "").localeCompare(
          b.lastDetailsFetchedAt ?? "",
        ),
      )
      .slice(0, budget);

    let resolved = 0;
    for (const channel of needDetails) {
      /**
       * The platform links are visited in a defined order — the channel's
       * primary platform first — so the avatar and the details always come
       * from the same place, rather than from whichever account the source
       * happened to list first.
       */
      const ordered = orderPlatformLinks(channel);
      for (const link of ordered) {
        const adapter = adapterById.get(link.platform);
        if (!adapter) continue;

        // Be polite to the public endpoints: one request at a time, with a
        // short pause between them.
        if (resolved > 0) {
          await new Promise((r) => setTimeout(r, config.detailsDelayMs));
        }

        try {
          const profile = await adapter.resolve(link.handle ?? link.id);
          if (!profile) continue;
          if (profile.description && !channel.description) {
            channel.description = profile.description.slice(0, 1000);
          }
          if (profile.avatar && !channel.avatar) channel.avatar = profile.avatar;
          if (profile.subscribers.tag === "has") {
            link.subscribers = profile.subscribers;
          }
          if (profile.handle) link.handle = profile.handle;
          resolved++;
        } catch {
          /* a profile that cannot be fetched is not a reason to fail */
        }
        channel.lastDetailsFetchedAt = now;
        if (resolved >= budget) break;
      }
      if (resolved >= budget) break;
    }
    if (needDetails.length) {
      log(`details: resolved ${resolved}/${needDetails.length} channel profile(s)`);
    }

    /**
     * Re-evaluate the facts the description can answer.
     *
     * The affiliation and the activity status are both stated in the
     * channel's own description — 「个人势vup」 says the performer is
     * independent, 「已毕业」 says they have graduated. Those facts were not
     * available when the record was first classified, so they are read now.
     */
    for (const channel of channels) {
      // The avatar follows the primary platform, whatever order the source
      // listed the accounts in.
      channel.avatar = pickAvatar(channel);
    }

    let reclassified = 0;
    for (const channel of channels) {
      if (!channel.description) continue;
      const affiliation = detectAffiliation(
        channel.name,
        channel.description,
        channel.agency,
      );
      if (affiliation !== channel.affiliation) {
        channel.affiliation = affiliation;
        reclassified++;
      }
      const activity = detectActivity(
        channel.name,
        channel.description,
        null,
      );
      if (activity !== "unknown" && channel.activity === "unknown") {
        channel.activity = activity;
      }
    }
    if (reclassified) {
      log(`details: ${reclassified} channel(s) re-classified from their description`);
    }
  }

  /* --- Twitch enrichment (optional) ------------------------------------ */
  const twitch = TwitchClient.fromEnv(
    process.env,
    path.join(CACHE_DIR, "twitch"),
  );
  if (twitch) {
    /**
     * The Twitch identity lives in `platforms[]`, so the enrichment updates
     * the link in place rather than a separate field.
     */
    const logins = [
      ...new Set(
        channels
          .map((c) =>
            c.platforms.find((p) => p.platform === "twitch")?.handle,
          )
          .filter((l): l is string => !!l),
      ),
    ];
    log(`twitch: enriching ${logins.length} linked channel(s)`);
    try {
      const users = await twitch.users(logins);
      const byLogin = new Map<string, any>(
        users.map((u) => [String(u.login).toLowerCase(), u]),
      );
      for (const channel of channels) {
        const link = channel.platforms.find((p) => p.platform === "twitch");
        if (!link?.handle) continue;
        const user = byLogin.get(link.handle.toLowerCase());
        if (!user) continue;

        link.id = user.id ?? link.id;
        link.handle = user.login ?? link.handle;
        link.name = user.display_name ?? link.name;
        link.avatar = user.profile_image_url ?? link.avatar;
        link.url = `https://www.twitch.tv/${link.handle}`;

        try {
          link.subscribers = await twitch.followers(user.id);
        } catch {
          link.subscribers = { tag: "no" };
        }
      }
      log(`twitch: enriched ${users.length} user(s)`);
    } catch (err) {
      log(`warn: twitch enrichment failed: ${(err as Error).message}`);
    }
  } else {
    log("twitch: skipped (TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET not set)");
  }

  /* --- Taiwan VTuber Tracking Data: authoritative region + lifecycle --- */
  const tracked = await fetchTrackedVtubers();
  if (tracked.size) {
    let enriched = 0;
    for (const channel of channels) {
      const record = tracked.get(channel.id);
      if (!record) continue;

      // The tracked roster is authoritative for the region and the activity:
      // its nationality column is the performer's own country.
      channel.region = record.region;
      channel.regionSource = "roster";
      channel.activity = record.activity;
      channel.debutDate = record.debutDate ?? channel.debutDate;
      if (record.group && !channel.agency) channel.agency = record.group;
      if (record.twitchId) {
        const link = channel.platforms.find((p) => p.platform === "twitch");
        if (link) {
          link.id = record.twitchId;
          link.handle = record.twitchId;
        } else {
          channel.platforms.push({
            platform: "twitch",
            id: record.twitchId,
            handle: record.twitchId,
            name: channel.name,
            url: `https://www.twitch.tv/${record.twitchId}`,
            subscribers: { tag: "hidden" },
            avatar: null,
            activity: channel.activity,
            lastCheckedAt: now,
          });
        }
      }

      // Subscriber counts: prefer the tracked figure when it is public.
      if (record.subscribers.tag === "has") {
        channel.subscribers = record.subscribers;
      }
      if (!channel.avatar && record.avatar) channel.avatar = record.avatar;

      channel.variant = deriveVariant(
        channel.role,
        channel.gender,
        channel.isAi,
      );
      enriched++;
    }
    log(
      `taiwan vtuber data: ${tracked.size} tracked performers, ${enriched} channel(s) enriched`,
    );
  } else {
    log("taiwan vtuber data: unavailable — using heuristic region detection");
  }

  /* --- AiSList: authoritative AI-channel detection --------------------- */
  const aiList = await fetchAiList();
  if (aiList) {
    let marked = 0;
    for (const channel of channels) {
      if (channel.isAi) continue;
      if (isOnAiList(aiList, channel)) {
        channel.isAi = true;
        channel.variant = deriveVariant(
          channel.role,
          channel.gender,
          true,
        );
        // The AiSList is authoritative about the AI flag.
        channel.confidence = {
          kind: channel.confidence.kind,
          region: channel.confidence.region,
          role: channel.confidence.role,
          gender: channel.confidence.gender,
          ai: 1,
          overall: channel.confidence.overall,
        };
        marked++;
      }
    }
    log(
      `aislist: ${aiList.blocklistCount} blocklist + ${aiList.warnlistCount} warnlist entries, ${marked} channel(s) marked as AI`,
    );
  } else {
    log("aislist: unavailable — falling back to heuristic AI detection");
  }

  /* --- other platforms: bilibili / niconico / vk ----------------------- */
  const extraPlatforms = adapters.filter(
    (a) => a.id !== "youtube" && a.id !== "twitch",
  );
  if (extraPlatforms.length) {
    const platformKeywords = readJson<Record<string, string[]>>(
      path.join(ROOT, "config", "platform-keywords.json"),
      {},
    );
    for (const adapter of extraPlatforms) {
      const queries = platformKeywords[adapter.id] ?? [];
      let found = 0;
      for (const query of queries) {
        if (!adapter.search) continue;
        try {
          const channels = await adapter.search(query, 10);
          for (const foundChannel of channels) {
            const key = `${adapter.id}:${foundChannel.id}`;
            if (platformChannelIds.has(key)) continue;
            platformChannelIds.add(key);
            platformCandidates.push({ adapter, channel: foundChannel });
            found++;
          }
        } catch (err) {
          log(`warn: ${adapter.id} search "${query}" failed: ${(err as Error).message}`);
          break;
        }
      }
      log(`${adapter.id}: discovered ${found} channel(s)`);
    }

    /**
     * Collect the uploads the adapters found while discovering channels.
     *
     * Bilibili's live list is partition-wide, so the adapter hands back the
     * live streams it saw; they become dataset items like any other upload.
     */
    for (const { adapter, channel } of platformCandidates) {
      const liveUploads = (adapter as unknown as { liveUploads?: any[] })
        .liveUploads;
      if (Array.isArray(liveUploads)) {
        for (const upload of liveUploads) {
          const item = platformUploadToItem(upload, now);
          if (!item) continue;
          const prev = itemById.get(item.id);
          itemById.set(item.id, { ...item, addedAt: prev?.addedAt ?? item.addedAt });
        }
      }
    }

    // Store the discovered channels as platform links on matching YouTube
    // channels when the name matches, otherwise record them as standalone
    // entries in the dataset.
    for (const { adapter, channel } of platformCandidates) {
      const match = findChannelByName(channels, channel.name);
      const link: PlatformLink = {
        platform: adapter.id,
        id: channel.id,
        handle: channel.handle,
        name: channel.name,
        url: channel.url,
        subscribers: channel.subscribers,
        avatar: channel.avatar,
        activity: "unknown",
        lastCheckedAt: now,
      };
      if (match) {
        if (!match.platforms.some((p) => p.platform === adapter.id)) {
          match.platforms.push(link);
        }
      } else {
        // No YouTube counterpart: represent it as a channel of its own.
        const standalone = channelFromPlatform(adapter, channel, now);
        if (standalone) channelById.set(standalone.id, standalone);
      }
    }
    channels = [...channelById.values()].filter(
      (c) => !overrides[c.id]?.hidden,
    );
  }

  /* --- fetch items ----------------------------------------------------- */
  const singingChannels = channels.filter((c) => c.isSinging);

  /**
   * Channels to refresh uploads for.
   *
   * Not only the channels the classifier believes are singing: a channel that
   * already has items in the dataset must keep them fresh even if its
   * description has not been fetched yet. Otherwise the dataset would slowly
   * go stale for every channel whose `isSinging` flag is still unknown.
   */
  const channelsWithItems = new Set(items.map((i) => i.channelId));

  /**
   * The channels to fetch uploads for, in rotation order.
   *
   * The catalogue is far larger than a single run can afford, so each run
   * takes the slice that needs it most:
   *
   * 1. channels that publish singing content and have never been fetched;
   * 2. channels that have never been fetched;
   * 3. the rest, oldest fetch first.
   *
   * That way a 14,000-channel catalogue fills in over a few days of
   * scheduled runs without any channel being starved.
   */
  const neverFetched = (c: Channel) => !c.lastItemsFetchedAt;
  const refreshable = channels
    .filter((c) => c.isSinging || channelsWithItems.has(c.id) || neverFetched(c))
    .sort((a, b) => {
      // Singing channels first — they are the point of the project.
      const aSinging = a.isSinging ? 0 : 1;
      const bSinging = b.isSinging ? 0 : 1;
      if (aSinging !== bSinging) return aSinging - bSinging;

      // Then never-fetched channels.
      const aNew = neverFetched(a) ? 0 : 1;
      const bNew = neverFetched(b) ? 0 : 1;
      if (aNew !== bNew) return aNew - bNew;

      // Then the least recently fetched.
      return (a.lastItemsFetchedAt ?? "").localeCompare(
        b.lastItemsFetchedAt ?? "",
      );
    });

  const channelList =
    args.limitChannels !== null
      ? refreshable.slice(0, args.limitChannels)
      : refreshable.slice(0, config.maxChannelsPerRun);

  let fetchedVideos = 0;
  let fetchedDetails = 0;

  for (const channel of channelList) {
    if (!client || !budget.canAfford(2)) break;
    try {
      const rawVideos = await fetchChannelVideos(
        client,
        channel,
        config.maxItemsPerChannel,
      );
      if (!rawVideos.length) continue;

      const details = await fetchVideoDetails(
        client,
        rawVideos.map((v) => v.id),
      );
      fetchedVideos += rawVideos.length;
      fetchedDetails += details.length;

      for (const raw of details) {
        const item = itemFromApi(raw, channel, "api", now);
        if (!item) continue;
        const prev = itemById.get(item.id);
        itemById.set(item.id, {
          ...item,
          addedAt: prev?.addedAt ?? item.addedAt,
        });
      }
      channel.lastItemsFetchedAt = now;
    } catch (err) {
      if (err instanceof QuotaExceededError) {
        log("quota exhausted while fetching items — stopping");
        break;
      }
      log(`warn: item fetch failed for ${channel.id}: ${(err as Error).message}`);
    }
  }
  log(`fetched ${fetchedVideos} videos / ${fetchedDetails} details`);

  /* --- live + upcoming broadcasts -------------------------------------- */
  if (client && config.refreshLiveEveryRun && budget.canAfford(API_COST.liveBroadcasts)) {
    const liveTargets = singingChannels
      .slice(0, config.maxLiveChannelsPerRun)
      .map((c) => c.id);
    try {
      const broadcasts = await client.liveBroadcasts(liveTargets);
      let added = 0;
      for (const b of broadcasts) {
        const channel = channelById.get(b.snippet?.channelId ?? "");
        if (!channel) continue;
        const snippet = b.snippet ?? {};
        const status = b.status?.lifeCycleStatus ?? "unknown";
        const state: Item["status"] =
          status === "live"
            ? "live"
            : status === "upcoming"
              ? "upcoming"
              : "past";
        const item: Item = {
          id: b.id,
          type: "live",
          channelId: channel.id,
          channelName: channel.name,
          channelKind: channel.kind,
          region: channel.region,
          gender: channel.gender,
          isAi: channel.isAi,
          variant: channel.variant,
          title: snippet.title ?? "Untitled",
          description: truncate(snippet.description, 600),
          thumbnail: pickThumbnail(snippet.thumbnails, "high"),
          publishedAt: snippet.publishedAt ?? null,
          scheduledStart: b.contentDetails?.scheduledStartTime ?? null,
          actualStart: b.contentDetails?.actualStartTime ?? null,
          actualEnd: b.contentDetails?.actualEndTime ?? null,
          duration: null,
          status: state,
          category: state === "upcoming" ? "premiere" : "live",
          songTitle: null,
          originalArtist: null,
          isCollab: false,
          collaborators: [
            {
              channelId: channel.id,
              name: channel.name,
              kind: channel.kind,
              region: channel.region,
            },
          ],
          isAcoustic: false,
          tags: [],
          viewCount: null,
          likeCount: null,
          concurrentViewers: null,
          source: "api",
          addedAt: now,
          updatedAt: now,
          lastItemsFetchedAt: null,
          lastDetailsFetchedAt: null,
        };
        const prev = itemById.get(item.id);
        itemById.set(item.id, { ...item, addedAt: prev?.addedAt ?? item.addedAt });
        added++;
      }
      log(`live broadcasts: ${broadcasts.length} fetched, ${added} stored`);
    } catch (err) {
      log(`warn: live broadcast fetch failed: ${(err as Error).message}`);
    }
  }

  /* --- discovered videos ------------------------------------------------ */
  if (client && discoveredVideoIds.size && budget.canAfford(API_COST.videos)) {
    const ids = [...discoveredVideoIds].slice(0, 200);
    try {
      const details = await fetchVideoDetails(client, ids);
      for (const raw of details) {
        const channel = channelById.get(raw.snippet?.channelId ?? "");
        const item = itemFromApi(raw, channel, "api", now);
        if (!item) continue;
        const prev = itemById.get(item.id);
        itemById.set(item.id, { ...item, addedAt: prev?.addedAt ?? item.addedAt });
      }
      log(`search-discovered videos: ${details.length} stored`);
    } catch (err) {
      log(`warn: discovered video fetch failed: ${(err as Error).message}`);
    }
  }

  /* --- backfill missing durations -------------------------------------- */
  /**
   * `videos.list` returns `contentDetails.duration` for free (1 unit per 50
   * videos), but records imported from the legacy database have no duration
   * at all. This pass fills them in, budget permitting.
   */
  const missingDuration = items.filter(
    (i) => i.duration === null && i.type === "video" && i.status !== "upcoming",
  );
  if (client && missingDuration.length && budget.canAfford(API_COST.videos)) {
    const ids = missingDuration.slice(0, 500).map((i) => i.id);
    try {
      const details = await fetchVideoDetails(client, ids);
      let filled = 0;
      for (const raw of details) {
        const item = itemById.get(raw.id);
        if (!item) continue;
        const duration = parseIsoDuration(raw.contentDetails?.duration);
        if (duration !== null) {
          item.duration = duration;
          filled++;
        }
        if (item.viewCount === null && raw.statistics?.viewCount) {
          item.viewCount = Number(raw.statistics.viewCount);
        }
        if (item.likeCount === null && raw.statistics?.likeCount) {
          item.likeCount = Number(raw.statistics.likeCount);
        }
        if (!item.tags.length && raw.snippet?.tags?.length) {
          item.tags = raw.snippet.tags.slice(0, 25);
        }
      }
      log(`durations: backfilled ${filled}/${missingDuration.length}`);
    } catch (err) {
      log(`warn: duration backfill failed: ${(err as Error).message}`);
    }
  }

  items = [...itemById.values()];

  /* --- curated song metadata (VTuber Music Dataset) -------------------- */
  const musicEntries = await fetchMusicDataset();
  if (musicEntries?.length) {
    const index = indexMusicDataset(musicEntries);
    let enriched = 0;
    for (const item of items) {
      const entry = index.get(item.id);
      if (!entry) continue;
      // The curated dataset wins over the heuristic extraction.
      if (entry.song) item.songTitle = entry.song;
      if (entry.original) item.originalArtist = entry.original;
      if (entry.collab) item.isCollab = true;
      if (!item.publishedAt && entry.publishedAt) {
        item.publishedAt = entry.publishedAt;
      }
      if (entry.song) {
        item.category =
          item.category === "other" || item.category === "live"
            ? "cover"
            : item.category;
      }
      enriched++;
    }
    log(
      `music dataset: ${musicEntries.length} entries, ${enriched} item(s) enriched`,
    );
  } else {
    log("music dataset: unavailable — using heuristic song extraction");
  }

  /* --- activity status, now that we know the newest upload ------------- */
  const newestByChannel = new Map<string, string>();
  for (const item of items) {
    const ts = item.publishedAt ?? item.scheduledStart;
    if (!ts) continue;
    const prev = newestByChannel.get(item.channelId);
    if (!prev || ts > prev) newestByChannel.set(item.channelId, ts);
  }
  for (const channel of channels) {
    channel.activity = detectActivity(
      channel.name,
      channel.description,
      newestByChannel.get(channel.id) ?? null,
    );
  }

  /* --- merge with the on-disk dataset ---------------------------------- */
  channels = mergeById(existingChannels, channels);
  items = mergeById(existingItems, items);

  /**
   * Items carry denormalised copies of their channel's classification, so
   * they can be filtered without a join. When a channel's region, kind,
   * gender or AI flag changes — which happens whenever the roster or the
   * verifier corrects it — the items have to follow.
   */
  for (const item of items) {
    const channel = channelById.get(item.channelId);
    if (!channel) continue;
    item.region = channel.region;
    item.channelKind = channel.kind;
    item.gender = channel.gender;
    item.isAi = channel.isAi;
    item.variant = channel.variant;
    if (!item.channelName) item.channelName = channel.name;
  }

  /**
   * Whether a channel publishes singing content is discovered from its
   * uploads, not assumed. A channel with a cover, an MV, an original song or
   * a live performance is a singing channel.
   */
  const singingChannelsFound = new Set(
    items
      .filter((i) =>
        ["cover", "mv", "original", "performance", "live"].includes(i.category),
      )
      .map((i) => i.channelId),
  );
  for (const channel of channels) {
    if (singingChannelsFound.has(channel.id)) channel.isSinging = true;
  }

  /**
   * Retention runs *after* the merge, not before.
   *
   * The merge is a union with what is already on disk, so trimming before it
   * would simply re-add the trimmed records on the next pass — retention
   * would never take effect.
   */
  const beforeRetention = items.length;
  items = applyRetention(items, {
    maxPerChannel: config.maxItemsPerChannelRetained,
    maxAgeDays: config.maxItemAgeDays,
  });
  log(
    `retention: ${beforeRetention} → ${items.length} items ` +
      `(max ${config.maxItemsPerChannelRetained}/channel, max age ${config.maxItemAgeDays}d)`,
  );

  /* --- write ------------------------------------------------------------ */
  const counts = computeCounts(channels, items);
  const regionCounts = new Map<
    string,
    { channels: number; items: number }
  >();
  for (const c of channels) {
    const e = regionCounts.get(c.region) ?? { channels: 0, items: 0 };
    e.channels++;
    regionCounts.set(c.region, e);
  }
  for (const i of items) {
    const e = regionCounts.get(i.region) ?? { channels: 0, items: 0 };
    e.items++;
    regionCounts.set(i.region, e);
  }

  const manifest: Manifest = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: now,
    counts,
    regions: buildRegionMeta(regionCounts as never),
    quota: {
      used: budget.used,
      limit: budget.limit,
      remaining: budget.remaining,
    },
    notes:
      "Generated by scripts/sync.ts from the YouTube Data API v3. " +
      "Virtual and real datasets are kept separate — see docs/DATA-SCHEMA.md.",
  };

  if (args.dryRun) {
    log("dry run — nothing written");
    printSummary(manifest, channels, items);
    return;
  }

  const result = writeDataset(channels, items, manifest, now);
  printSummary(manifest, channels, items);
  log(`quota used: ${budget.used}/${budget.limit}`);
  log(`dataset: ${result.files} files · ${describeDatasetSize()}`);
  if (result.removed.length) {
    log(`pruned ${result.removed.length} stale shard(s)`);
  }
}

/* -------------------------------------------------------------------------- */
/* Multi-platform helpers                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Converts a platform upload into a dataset item.
 *
 * Items from other platforms are stored alongside the YouTube ones — a
 * Bilibili MV and its YouTube upload are the same performance, and the
 * dataset should not hide one because it came from a different site.
 */
export function platformUploadToItem(
  upload: PlatformUpload,
  now: string,
): Item | null {
  if (!upload?.id) return null;
  return {
    id: upload.id,
    type: upload.status === "live" ? "live" : "video",
    channelId: upload.channelId,
    channelName: "",
    channelKind: "virtual",
    region: "cn",
    gender: "unknown",
    isAi: false,
    variant: "unknown",
    title: upload.title ?? "Untitled",
    description: upload.description ?? null,
    thumbnail: upload.thumbnail ?? null,
    publishedAt: upload.publishedAt ?? null,
    scheduledStart: upload.scheduledStart ?? null,
    actualStart: null,
    actualEnd: null,
    duration: upload.duration ?? null,
    status: upload.status,
    category: upload.category,
    songTitle: upload.songTitle ?? null,
    originalArtist: upload.originalArtist ?? null,
    isCollab: false,
    collaborators: [],
    isAcoustic: false,
    tags: [],
    viewCount: upload.viewCount ?? null,
    likeCount: null,
    concurrentViewers: null,
    source: "api",
    addedAt: now,
    updatedAt: now,
    lastItemsFetchedAt: null,
    lastDetailsFetchedAt: null,
  };
}

/**
 * Finds a YouTube channel that corresponds to a performer found on another
 * platform. Matching is by normalised display name, which is reliable because
 * performers usually keep the same name across platforms.
 */
export function findChannelByName(
  channels: Channel[],
  name: string | null | undefined,
): Channel | undefined {
  if (!name) return undefined;
  const target = name.trim().toLowerCase();
  if (!target) return undefined;

  for (const channel of channels) {
    if (channel.name.trim().toLowerCase() === target) return channel;
  }
  // Fall back to a "starts with" match for decorated names.
  for (const channel of channels) {
    const candidate = channel.name.trim().toLowerCase();
    if (candidate.startsWith(target) || target.startsWith(candidate)) {
      if (Math.abs(candidate.length - target.length) <= 12) return channel;
    }
  }
  return undefined;
}

/**
 * Builds a standalone channel record for a performer that only exists on a
 * non-YouTube platform. The id is namespaced with the platform so it cannot
 * collide with a YouTube channel id.
 */
export function channelFromPlatform(
  adapter: PlatformAdapter,
  channel: PlatformChannel,
  now: string,
): Channel | null {
  if (!channel.id) return null;

  const classification = classifyChannel({
    name: channel.name ?? channel.handle ?? "",
    description: channel.description,
    tags: channel.tags,
    country: null,
    platform: adapter.id,
  });

  return {
    id: `${adapter.id}:${channel.id}`,
    name: channel.name ?? channel.handle ?? channel.id,
    handle: channel.handle,
    kind: classification.kind,
    role: classification.role,
    region: classification.region,
    regionSource: classification.regionSource,
    language: classification.language,
    agency: classification.agency,
    affiliation: detectAffiliation(
      channel.name,
      channel.description,
      classification.agency,
    ),
    avatar: channel.avatar,
    banner: null,
    description: channel.description ? channel.description.slice(0, 1000) : null,
    subscribers: channel.subscribers,
    videoCount: null,
    viewCount: null,
    uploadsPlaylistId: null,
    country: null,
    tags: channel.tags.slice(0, 30),
    isSinging: classification.isSinging,
    gender: classification.gender,
    isAi: classification.isAi,
    variant: classification.variant,
    confidence: classification.confidence,
    source: "api",
    addedAt: now,
    updatedAt: now,
    lastItemsFetchedAt: null,
    lastDetailsFetchedAt: null,

    activity: "unknown",
    debutDate: null,
    graduateDate: null,

    platforms: [
      {
        platform: adapter.id,
        id: channel.id,
        handle: channel.handle,
        name: channel.name,
        url: channel.url,
        subscribers: channel.subscribers,
        avatar: channel.avatar,
        activity: "unknown",
        lastCheckedAt: now,
      },
    ],
    externals: {},

    popularVideoId: null,
  };
}

/* -------------------------------------------------------------------------- */
/* Retention                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Keeps the dataset inside its size budget.
 *
 * The dataset is committed to git, so it cannot grow without bound. Two rules
 * apply:
 *
 *  1. **Per-channel cap** — only the N most recent items per channel are
 *     kept. Older uploads are still reachable on YouTube.
 *  2. **Age cap** — items older than `maxAgeDays` are dropped, *except*
 *     live/upcoming items (always relevant) and signature uploads
 *     (covers, MVs, originals) which stay as long as the channel cap allows.
 */
export function applyRetention(
  items: Item[],
  rules: { maxPerChannel: number; maxAgeDays: number },
): Item[] {
  const cutoff = Date.now() - rules.maxAgeDays * 24 * 60 * 60 * 1000;

  const byChannel = new Map<string, Item[]>();
  for (const item of items) {
    const list = byChannel.get(item.channelId) ?? [];
    list.push(item);
    byChannel.set(item.channelId, list);
  }

  const kept: Item[] = [];
  for (const list of byChannel.values()) {
    const relevant = list.filter((i) => {
      if (i.status === "live" || i.status === "upcoming") return true;
      const ts = i.publishedAt ? Date.parse(i.publishedAt) : 0;
      if (!ts) return false;
      return ts >= cutoff;
    });

    // Signature uploads are worth keeping even when they are old.
    const signature = relevant.filter((i) =>
      ["cover", "mv", "original"].includes(i.category),
    );
    const routine = relevant.filter(
      (i) => !["cover", "mv", "original"].includes(i.category),
    );

    const sorted = (a: Item, b: Item) =>
      (b.publishedAt ?? "").localeCompare(a.publishedAt ?? "");

    const keptSignature = signature
      .sort(sorted)
      .slice(0, Math.max(5, Math.floor(rules.maxPerChannel * 0.5)));
    const keptRoutine = routine.sort(sorted).slice(0, rules.maxPerChannel);

    kept.push(...keptSignature, ...keptRoutine);
  }

  return kept;
}

/* -------------------------------------------------------------------------- */
/* Output                                                                     */
/* -------------------------------------------------------------------------- */

function computeCounts(channels: Channel[], items: Item[]): ManifestCounts {
  return {
    channels: channels.length,
    channelsVirtual: channels.filter((c) => c.kind === "virtual").length,
    channelsReal: channels.filter((c) => c.kind === "real").length,
    channelsSinging: channels.filter((c) => c.isSinging).length,
    items: items.length,
    itemsLive: items.filter((i) => i.status === "live").length,
    itemsUpcoming: items.filter((i) => i.status === "upcoming").length,
    itemsVideo: items.filter((i) => i.type === "video").length,
    itemsPlaylist: items.filter((i) => i.type === "playlist").length,
    itemsCover: items.filter((i) => i.category === "cover").length,
    itemsMv: items.filter((i) => i.category === "mv").length,
    itemsOriginal: items.filter((i) => i.category === "original").length,
  };
}

function printSummary(
  manifest: Manifest,
  channels: Channel[],
  items: Item[],
): void {
  const c = manifest.counts;
  console.log("");
  console.log("  channels   %d total · %d virtual · %d real · %d singing",
    c.channels, c.channelsVirtual, c.channelsReal, c.channelsSinging);
  console.log("  items      %d total · %d live · %d upcoming · %d video",
    c.items, c.itemsLive, c.itemsUpcoming, c.itemsVideo);
  console.log("  singing    %d covers · %d mvs · %d originals",
    c.itemsCover, c.itemsMv, c.itemsOriginal);
  console.log("");
  console.log("  region    channels   items");
  for (const r of manifest.regions) {
    if (!r.channels && !r.items) continue;
    console.log(
      `  ${r.badge} ${r.label.padEnd(9)} ${String(r.channels).padStart(8)} ${String(r.items).padStart(8)}`,
    );
  }
  console.log("");
}

main().catch((err) => {
  console.error("[sync] fatal:", err);
  process.exit(1);
});
