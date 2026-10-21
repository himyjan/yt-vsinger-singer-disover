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
import { classifyChannel, classifyItem, detectActivity, isShortItem } from "./lib/classify";
import { ALL_SEEDS, type SeedEntry } from "./lib/seeds";
import {
  extractExternalLinks,
  extractTwitchLogin,
  TwitchClient,
} from "./lib/twitch";
import { createAdapters } from "./lib/platform-registry";
import { fetchAiList, isOnAiList } from "./lib/aislist";
import { fetchTrackedVtubers } from "./lib/taiwan-vtuber-data";
import { buildRoster } from "./lib/roster";
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
import type { PlatformLink } from "./lib/types";

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
    language: classification.language,
    agency: classification.agency,
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
    confidence: override?.verifiedAt ? 1 : classification.confidence,
    source: override?.verifiedAt ? "manual" : source,
    addedAt: now,
    updatedAt: now,

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
    twitchId: null,
    twitchLogin: extractTwitchLogin(description),
    twitchFollowers: { tag: "hidden" },
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
    isAcoustic: classification.isAcoustic,
    tags: (snippet.tags ?? []).slice(0, 25),
    viewCount: toNumber(stats.viewCount),
    likeCount: toNumber(stats.likeCount),
    concurrentViewers: toNumber(live.concurrentViewers),
    source,
    addedAt: now,
    updatedAt: now,
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
      // The roster wins on the facts it owns; anything it does not know is
      // kept from the existing record.
      channelById.set(channel.id, {
        ...existing,
        name: channel.name || existing.name,
        kind: channel.kind,
        role: channel.role,
        region: channel.region,
        agency: channel.agency ?? existing.agency,
        subscribers: channel.subscribers.tag === "hidden"
          ? existing.subscribers
          : channel.subscribers,
        activity: channel.activity !== "unknown" ? channel.activity : existing.activity,
        debutDate: channel.debutDate ?? existing.debutDate,
        graduateDate: channel.graduateDate ?? existing.graduateDate,
        avatar: channel.avatar ?? existing.avatar,
        twitchId: channel.twitchId ?? existing.twitchId,
        twitchLogin: channel.twitchLogin ?? existing.twitchLogin,
        platforms: channel.platforms.length ? channel.platforms : existing.platforms,
        source: channel.source === "seed" ? "seed" : existing.source,
        confidence: Math.max(existing.confidence, channel.confidence),
      });
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
          ch.confidence = Math.max(prev?.confidence ?? 0, ch.confidence);
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

  /* --- Twitch enrichment (optional) ------------------------------------ */
  const twitch = TwitchClient.fromEnv(
    process.env,
    path.join(CACHE_DIR, "twitch"),
  );
  if (twitch) {
    const logins = [
      ...new Set(
        channels
          .map((c) => c.twitchLogin)
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
        if (!channel.twitchLogin) continue;
        const user = byLogin.get(channel.twitchLogin.toLowerCase());
        if (!user) continue;
        channel.twitchId = user.id ?? null;
        channel.externals = {
          ...channel.externals,
          ...(user.viewable_roles?.length ? {} : {}),
        };
        try {
          channel.twitchFollowers = await twitch.followers(user.id);
        } catch {
          channel.twitchFollowers = { tag: "no" };
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

      // The tracked roster is authoritative for the region and the activity.
      channel.region = record.region;
      channel.activity = record.activity;
      channel.debutDate = record.debutDate ?? channel.debutDate;
      if (record.group && !channel.agency) channel.agency = record.group;
      if (record.twitchId) channel.twitchId = record.twitchId;

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
        channel.confidence = 1;
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
  const adapters = createAdapters({
    youtubeClient: null,
    twitchClient: null,
  });
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
  const refreshable = channels.filter(
    (c) => c.isSinging || channelsWithItems.has(c.id),
  );
  const channelList =
    args.limitChannels !== null
      ? refreshable.slice(0, args.limitChannels)
      : refreshable;

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
          isAcoustic: false,
          tags: [],
          viewCount: null,
          likeCount: null,
          concurrentViewers: null,
          source: "api",
          addedAt: now,
          updatedAt: now,
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
    isAcoustic: false,
    tags: [],
    viewCount: upload.viewCount ?? null,
    likeCount: null,
    concurrentViewers: null,
    source: "api",
    addedAt: now,
    updatedAt: now,
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
  });

  return {
    id: `${adapter.id}:${channel.id}`,
    name: channel.name ?? channel.handle ?? channel.id,
    handle: channel.handle,
    kind: classification.kind,
    role: classification.role,
    region: classification.region,
    language: classification.language,
    agency: classification.agency,
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
    twitchId: null,
    twitchLogin: null,
    twitchFollowers: { tag: "hidden" },
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
