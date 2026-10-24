#!/usr/bin/env tsx
/**
 * YouTube channel and media sync pipeline.
 *
 * Reads the current dataset from `data/` and refreshes it from the public
 * sources. InnerTube is the primary YouTube source; the Data API is optional
 * and adds video statistics, exact broadcast times and a fallback.
 *
 *   npm run sync              # InnerTube sync; optionally uses YOUTUBE_API_KEY
 *   npm run sync -- --dry-run # fetch + classify, print summary, write nothing
 *   npm run sync -- --no-search # only refresh known channels
 *   npm run sync -- --shard 2/4 # refresh one deterministic slice
 *   npm run sync -- --budget 500 # cap this run at 500 quota units
 *
 * The script is designed to run unchanged in GitHub Actions and writes
 * exclusively inside the repository. InnerTube works without an API key.
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
  mergeActivity,
  detectAffiliation,
  extractCollaboratorNames,
  isShortItem,
} from "./lib/classify";
import { ALL_SEEDS, type SeedEntry } from "./lib/seed-catalog";
import {
  extractExternalLinks,
  extractTwitchLogin,
  TwitchClient,
} from "./lib/twitch";
import { createAdapters } from "./lib/platform-registry";
import {
  InnerTubeSource,
  type InnerTubeRelease,
  type InnerTubeSearchVideo,
} from "./lib/youtubei";
import {
  clearPendingAnalytics,
  writePendingAnalytics,
  type AnalyticsContentObservation,
  type AnalyticsObservation,
} from "./lib/analytics";
import { checkUpstreams, writeRevisions } from "./lib/upstream";
import { TwitchGqlSource } from "./lib/twitch-gql";
import { shardOf } from "./lib/shard";
import {
  isPlaceholderName,
  orderPlatformLinks,
  pickAvatar,
  pickSubscribers,
  primaryPlatformOf,
  PLATFORM_URLS,
  extractPlatformId,
} from "./lib/platforms";
import { languagesForRegion, mergeLanguages } from "./lib/regions";
import { fetchAiList, isOnAiList } from "./lib/aislist";
import { fetchTrackedVtubers } from "./lib/taiwan-vtuber-data";
import { buildRoster } from "./lib/roster";
import { VdbSource } from "./lib/vdb";
import {
  canonicalizeChannelIds,
  dedupeChannels,
  mergeChannels,
  REGION_TRUST,
} from "./lib/dedupe";
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
  acquireRunLock,
  ROOT,
} from "./lib/io";
import {
  layout,
  writeDataset,
  describeDatasetSize,
  readAllChannelRecords,
} from "./lib/dataset";
import { buildRegionMeta } from "./lib/regions";
import { ALL_PLATFORMS } from "./lib/types";
import type {
  Channel,
  ChannelFile,
  Item,
  ItemFile,
  Manifest,
  ManifestCounts,
  KnownPlatformId,
  PlatformId,
  RecordSource,
} from "./lib/types";
import { SCHEMA_VERSION, toCountRef } from "./lib/types";
import type {
  Collaborator,
  PlatformLink,
  Verification,
} from "./lib/types";

/* -------------------------------------------------------------------------- */
/* CLI                                                                        */
/* -------------------------------------------------------------------------- */

interface Args {
  dryRun: boolean;
  noSearch: boolean;
  /** Skip YouTube Data API calls; InnerTube remains available. */
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
  limitLive: number | null;
  keywords: string[];
  force: boolean;
  /**
   * The slice of the refresh rotation this run owns.
   *
   * `shardIndex` is zero-based; `shardCount` is 1 when sharding is off. The
   * scheduled workflow rotates the index between runs, so a catalogue larger
   * than one run can afford is still covered deterministically.
   */
  shardIndex: number;
  shardCount: number;
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
    limitLive: null,
    keywords: [],
    force: false,
    shardIndex: 0,
    shardCount: 1,
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
    else if (a === "--limit-live") args.limitLive = Number(argv[++i]);
    else if (a === "--keyword") args.keywords.push(argv[++i]);
    else if (a === "--shard") {
      const [indexRaw, countRaw] = String(argv[++i] ?? "").split("/");
      const index = Number(indexRaw);
      const count = Number(countRaw);
      if (
        Number.isInteger(index) &&
        Number.isInteger(count) &&
        count > 0 &&
        index >= 1 &&
        index <= count
      ) {
        args.shardIndex = index - 1;
        args.shardCount = count;
      } else {
        console.warn(
          `[sync] ignoring invalid --shard value; expected N/M with 1 <= N <= M`,
        );
      }
    }
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
  maxTwitchResolutionsPerRun: number;
  detailsDelayMs: number;
  innertubeDelayMs: number;
  searchResultsPerKeyword: number;
  refreshLiveEveryRun: boolean;
  searches: SearchSpec[];
}

const config: SyncConfig = readJson(
  path.join(ROOT, "config", "sync.config.json"),
  {
    maxSearchesPerRun: 40,
    maxChannelsPerRun: 150,
    maxItemsPerChannel: 25,
    maxItemsPerChannelRetained: 30,
    maxItemAgeDays: 1095,
    maxLiveChannelsPerRun: 300,
    maxChannelDetailsPerRun: 500,
    maxTwitchResolutionsPerRun: 150,
    detailsDelayMs: 700,
    innertubeDelayMs: 250,
    searchResultsPerKeyword: 25,
    refreshLiveEveryRun: true,
    searches: [],
  },
);

const SINGING_DISCOVERY_TERMS =
  /(?:vsinger|virtual\s+singer|singer|singing|karaoke|cover\s+song|music\s+video|vocaloid|歌枠|歌い手|歌ってみた|歌唱|歌姫|歌手|唱歌|翻唱|歌曲|歌回|歌回接力|接龍歌枠|歌.{0,8}(?:リレー|relay)|(?:リレー|relay).{0,8}歌|弾き語り|カラオケ|노래|가수|커버|노래방|nyanyi|menyanyi)/iu;
const VIRTUAL_SINGER_DISCOVERY_TERMS =
  /(?:vtuber|v[- ]?tuber|virtual\s+(?:you?tuber|singer)|vsinger|バーチャル(?:youtuber|ユーチューバー|シンガー|歌姫|歌手)|ぶいちゅーばー|虚拟(?:主播|歌姬|歌手)|虛擬(?:主播|歌姬|歌手)|버튜버|버추얼\s*유튜버)/iu;

function hasSingingDiscoveryEvidence(values: (string | null | undefined)[]): boolean {
  return values.some((value) => value && SINGING_DISCOVERY_TERMS.test(value));
}

function hasVirtualIdentityEvidence(values: (string | null | undefined)[]): boolean {
  return values.some((value) => value && VIRTUAL_SINGER_DISCOVERY_TERMS.test(value));
}

/* -------------------------------------------------------------------------- */
/* Overrides                                                                  */
/* -------------------------------------------------------------------------- */

interface Override {
  /** The current display name — a hand-written correction. */
  name?: string;
  /** The streaming status — `active`, `preparing`, `graduated`, `unknown`. */
  activity?: Channel["activity"];
  kind?: Channel["kind"];
  role?: Channel["role"];
  region?: Channel["region"];
  agency?: string | null;
  gender?: Channel["gender"];
  isAi?: boolean;
  isSinging?: boolean;
  /** A human-written description of the performer. */
  description?: string;
  /** A verified avatar URL, e.g. the Wikipedia infobox image. */
  avatar?: string;
  /** The verification record — what was looked up, and where. */
  verification?: Verification;
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

/**
 * True when the id belongs to this run's shard.
 *
 * The hash itself lives in `lib/shard.ts`, so the sync, the details fill and
 * the link resolver all put a channel in the same place.
 */
function inShard(id: string, args: Args): boolean {
  return (
    args.shardCount <= 1 ||
    shardOf(id, args.shardCount) === args.shardIndex
  );
}

function itemUrlForAnalytics(item: Item): string {
  switch (item.platform) {
    case "youtube":
      return `https://www.youtube.com/watch?v=${encodeURIComponent(item.id)}`;
    case "bilibili":
      return `https://www.bilibili.com/video/${encodeURIComponent(item.id)}`;
    case "niconico":
      return `https://www.nicovideo.jp/watch/${encodeURIComponent(item.id)}`;
    case "twitch":
      return `https://www.twitch.tv/videos/${encodeURIComponent(item.id)}`;
    case "chzzk":
      return `https://chzzk.naver.com/live/${encodeURIComponent(item.id)}`;
    case "kick":
      return `https://kick.com/video/${encodeURIComponent(item.id)}`;
    case "soop":
      return `https://play.sooplive.com/${encodeURIComponent(item.id)}`;
    case "vk":
      return `https://vk.com/video${encodeURIComponent(item.id)}`;
    case "ci.me":
      return `https://ci.me/${encodeURIComponent(item.id)}`;
    default:
      return "";
  }
}


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
          // A curated kind is a statement, and the aggregator test is a guess.
          curated: !!(override.kind || override.role || override.isSinging !== undefined),
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
    // The API reports the channel's current title.
    nameSource: "platform",
    // The API does not publish a channel's other names; the roster's aliases
    // are merged in separately.
    aliases: [],
    handle: snippet.customUrl ? snippet.customUrl.replace(/^@/, "") : null,
    kind: classification.kind,
    role: classification.role,
    region: classification.region,
    regionSource: classification.regionSource,
    languages: classification.languages,
    statedLanguages: classification.statedLanguages,

    agency: classification.agency,
    affiliation: detectAffiliation(
      snippet.title,
      description,
      classification.agency,
    ),
    avatar:
      override?.avatar ?? pickThumbnail(snippet.thumbnails, "high"),
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
    // A verified description and avatar beat an inferred one.
    description: override?.description ?? truncate(description, 1000),
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
    verification: override?.verification ?? null,
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
        videoCount: toNumber(stats.videoCount),
        viewCount: toNumber(stats.viewCount),
        avatar: pickThumbnail(snippet.thumbnails, "high"),
        lastCheckedAt: now,
      },
    ],
    externals: extractExternalLinks(description),

    popularVideoId: null,
  };
}

function channelFromInnerTubeProfile(
  profile: Awaited<ReturnType<InnerTubeSource["profile"]>>,
  now: string,
  source: RecordSource,
  override?: Override,
  fallbackName = "Unknown",
): Channel | null {
  if (!profile) return null;
  const channel = channelFromApi(
    {
      id: profile.id,
      snippet: {
        title: profile.title || fallbackName,
        description: profile.description ?? "",
        customUrl: profile.handle ? `@${profile.handle}` : null,
        thumbnails: profile.avatar
          ? [{ url: profile.avatar, width: 800, height: 800 }]
          : [],
        tags: [],
      },
      statistics: {
        subscriberCount: profile.subscribers,
        viewCount: profile.views,
        videoCount: profile.videos,
      },
      contentDetails: {},
      brandingSettings: {},
    },
    source,
    now,
    override,
  );
  if (channel) {
    channel.externals = {
      ...extractExternalLinks(profile.links.join(" ")),
      ...channel.externals,
    };
  }
  return channel;
}

/* -------------------------------------------------------------------------- */
/* Normalisation: API → Item                                                  */
/* -------------------------------------------------------------------------- */

function collaboratorsFor(title: string, owner?: Channel): Collaborator[] {
  const collaborators: Collaborator[] = owner
    ? [{
        channelId: owner.id,
        name: owner.name,
        kind: owner.kind,
        region: owner.region,
      }]
    : [];
  const knownNames = new Set(
    collaborators.map((collaborator) => collaborator.name.trim().toLowerCase()),
  );
  for (const name of extractCollaboratorNames(title)) {
    const key = name.trim().toLowerCase();
    if (!key || knownNames.has(key)) continue;
    knownNames.add(key);
    collaborators.push({
      channelId: null,
      name,
      kind: "unknown",
      region: "unknown",
    });
  }
  return collaborators;
}

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

  const collaborators = collaboratorsFor(snippet.title ?? "", channel);

  const type: Item["type"] =
    status === "live" || status === "upcoming"
      ? "live"
      : isShort
        ? "short"
        : "video";

  return {
    id: raw.id,
    platform: "youtube",
    type,
    channelId: channel?.id ?? snippet.channelId ?? "",
    channelName: channel?.name ?? snippet.channelTitle ?? "Unknown",
    channelKind: channel?.kind ?? "virtual",
    region: channel?.region ?? "unknown",
    gender: channel?.gender ?? "unknown",
    languages: channel?.languages ?? [],
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
  if (args.shardCount > 1) {
    log(
      `shard: ${args.shardIndex + 1}/${args.shardCount} of discovered, ` +
        `refresh and live candidates`,
    );
  }

  /**
   * One writer at a time.
   *
   * The sync and the details fill both read the whole dataset before they
   * write it, so two of them at once lose each other's work.
   */
  const releaseLock = acquireRunLock("sync");
  clearPendingAnalytics();

  const apiKey = args.offline
    ? ""
    : (process.env.YOUTUBE_API_KEY ?? process.env.YT_API_KEY ?? "");

  const quotaPath = path.join(CACHE_DIR, "quota.json");
  const budget = new QuotaBudget(quotaPath, args.quotaLimit);
  if (args.force) budget.overrideUsed(0);

  /**
   * The InnerTube client — the primary, quota-free source.
   *
   * It fetches channel profiles and upload lists without spending Data API
   * units, so the pipeline can run without an API key.
   */
  const innertube = new InnerTubeSource({
    enabled: process.env.YOUTUBE_USE_INNERTUBE !== "0",
    delayMs: config.innertubeDelayMs,
    onLog: (m) => log(m),
  });
  await innertube.connect();

  /**
   * The Twitch GQL client — the quota-free, secret-free Twitch source.
   * The same trade-off InnerTube offers on YouTube.
   */
  const twitchGql = new TwitchGqlSource({
    delayMs: config.innertubeDelayMs,
    onLog: (m) => log(m),
  });

  const client = apiKey
    ? new YouTubeClient({
        apiKey,
        cacheDir: path.join(CACHE_DIR, "youtube"),
        budget,
        onLog: (m) => log(m),
      })
    : null;
  if (!client) {
    log(
      args.offline
        ? "YouTube Data API disabled (--offline); using InnerTube"
        : "YouTube Data API key not set — using InnerTube; API-only discovery and live extras are skipped",
    );
  }

  const now = nowIso();

  /* --- upstream revisions ---------------------------------------------- */
  /**
   * Record which revision of each upstream the dataset is built from.
   *
   * The revisions are committed, so the next run can tell what moved — and a
   * change in the data can be traced back to the upstream commit that caused
   * it.
   */
  {
    const upstreamPath = path.join(ROOT, "data", "upstream.json");
    const { file, changed } = await checkUpstreams(upstreamPath, (m) =>
      log(`upstream: ${m}`),
    );
    if (!args.dryRun) writeRevisions(upstreamPath, file);
    if (changed.length) {
      log(
        `upstream: ${changed.length} source(s) changed since the last run ` +
          changed.map((c) => c.id).join(", "),
      );
    }
  }

  /* --- load current dataset ------------------------------------------- */
  /**
   * The ids are cleaned once, here.
   *
   * A record whose id carries a tab — `UC…/featured` — never resolves to a
   * channel, so it can never be enriched, renamed or verified. The clean id
   * may already belong to another record for the same channel, so the two are
   * merged rather than left as a pair.
   */
  const loaded = canonicalizeChannelIds(readAllChannelRecords());
  for (const { from, to } of loaded.renamed) log(`ids: ${from} → ${to}`);
  if (loaded.merged) {
    log(`ids: merged ${loaded.merged} duplicate record(s) with the same channel`);
  }
  const existingChannels = loaded.channels;

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

  /* --- resolve seeds --------------------------------------------------- */
  const seedByChannelId = new Map<string, SeedEntry>();
  const seedHandles: { seed: SeedEntry; handle: string }[] = [];
  for (const seed of ALL_SEEDS) {
    let channelId = seed.channelId;
    let handle = seed.handle;
    const youtubeUrl = seed.platformUrls?.youtube?.url;
    if (youtubeUrl) {
      const parsed = extractPlatformId(youtubeUrl);
      if (parsed?.platform === "youtube") {
        if (parsed.id.startsWith("UC")) channelId ??= parsed.id;
        else handle ??= parsed.id;
      } else {
        log(`warn: invalid YouTube seed URL for ${seed.name}: ${youtubeUrl}`);
      }
    }
    if (channelId) seedByChannelId.set(channelId, seed);
    else if (handle) seedHandles.push({ seed, handle });
  }

  const resolvedSeeds: any[] = [];
  const resolvedSeedIds = new Set<string>();
  const resolveSeedProfile = async (seed: SeedEntry, id: string) => {
    const profile = await innertube.profile(id);
    const channel = channelFromInnerTubeProfile(profile, now, "seed", {
      kind: seed.kind,
      role: seed.role,
      region: seed.region,
      agency: seed.agency ?? null,
      isSinging: seed.isSinging,
    }, seed.name);
    if (!channel) return false;
    seedByChannelId.set(channel.id, seed);
    resolvedSeedIds.add(channel.id);
    resolvedSeeds.push({
      id: channel.id,
      snippet: {
        title: channel.name,
        description: channel.description ?? "",
        customUrl: channel.handle ? `@${channel.handle}` : null,
        thumbnails: channel.avatar
          ? [{ url: channel.avatar, width: 800, height: 800 }]
          : [],
        tags: [],
      },
      statistics: { subscriberCount: channel.subscribers.tag === "has" ? channel.subscribers.count : null },
      contentDetails: {},
      brandingSettings: {},
    });
    return true;
  };

  for (const [id, seed] of seedByChannelId) {
    await resolveSeedProfile(seed, id);
  }

  const unresolvedSeedHandles: typeof seedHandles = [];
  for (const entry of seedHandles) {
    const id = await innertube.resolveHandle(entry.handle);
    if (!id || !(await resolveSeedProfile(entry.seed, id))) {
      unresolvedSeedHandles.push(entry);
    }
  }

  if (client) {
    const fallbackIds = [...seedByChannelId.keys()].filter(
      (id) => !resolvedSeedIds.has(id),
    );
    if (fallbackIds.length) {
      resolvedSeeds.push(...(await client.channels(fallbackIds)));
    }
    if (unresolvedSeedHandles.length) {
      try {
        resolvedSeeds.push(
          ...(await client.resolveHandles(
            unresolvedSeedHandles.map((entry) => entry.handle),
          )),
        );
      } catch (err) {
        log(`warn: seed handle resolution failed: ${(err as Error).message}`);
      }
    }
  } else if (unresolvedSeedHandles.length || resolvedSeedIds.size < seedByChannelId.size) {
    log("warn: some YouTube seeds could not be resolved through InnerTube");
  }
  log(`resolved ${resolvedSeeds.length}/${ALL_SEEDS.length} seeds`);

  const vdbSource = new VdbSource();
  const vdbRoster = await vdbSource.fetch();
  if (!vdbSource.isAvailable) {
    log("vdb: unavailable — automatic discovery is limited to existing and seeded identities");
  }

  const knownPlatformIdentities = new Map<
    PlatformId,
    { ids: Set<string>; handles: Set<string> }
  >();
  const rememberIdentity = (
    platform: PlatformId,
    value: string | null | undefined,
    kind: "id" | "handle" = "id",
  ) => {
    const normalized =
      kind === "handle"
        ? value?.trim().replace(/^@+/, "").toLowerCase()
        : value?.trim();
    if (!normalized) return;
    const identities = knownPlatformIdentities.get(platform) ?? {
      ids: new Set<string>(),
      handles: new Set<string>(),
    };
    identities[kind === "handle" ? "handles" : "ids"].add(normalized);
    knownPlatformIdentities.set(platform, identities);
  };
  const rememberPlatformLink = (link: PlatformLink) => {
    rememberIdentity(link.platform, link.id);
    rememberIdentity(link.platform, link.handle, "handle");
    if (link.platform === "youtube" && link.id && !link.id.startsWith("UC")) {
      rememberIdentity("youtube", link.id, "handle");
    }
  };
  const rememberChannel = (channel: Channel) => {
    if (channel.id.includes(":")) {
      const separator = channel.id.indexOf(":");
      const platform = channel.id.slice(0, separator);
      const id = channel.id.slice(separator + 1);
      rememberIdentity(platform, id);
      if (platform === "youtube" && !id.startsWith("UC")) {
        rememberIdentity("youtube", id, "handle");
      }
    } else {
      rememberIdentity("youtube", channel.id);
    }
    for (const link of channel.platforms ?? []) rememberPlatformLink(link);
  };
  for (const channel of channels) rememberChannel(channel);
  for (const performer of vdbRoster) {
    rememberIdentity("vdb", performer.uuid);
    rememberIdentity("vdb", performer.id);
    for (const link of performer.platforms) rememberPlatformLink(link);
  }
  for (const seed of ALL_SEEDS) {
    if (seed.channelId) rememberIdentity("youtube", seed.channelId);
    if (seed.handle) rememberIdentity("youtube", seed.handle, "handle");
    for (const [platform, identity] of Object.entries(seed.platformUrls ?? {})) {
      const parsed = extractPlatformId(identity.url);
      if (parsed) {
        rememberIdentity(platform, parsed.id);
        if (platform === "youtube" && !parsed.id.startsWith("UC")) {
          rememberIdentity("youtube", parsed.id, "handle");
        }
      }
    }
  }
  for (const raw of resolvedSeeds) rememberIdentity("youtube", raw.id);

  const isKnownPlatformIdentity = (
    platform: PlatformId,
    id?: string | null,
    handle?: string | null,
  ): boolean => {
    const identities = knownPlatformIdentities.get(platform);
    const normalizedId = id?.trim();
    const normalizedHandle = handle?.trim().replace(/^@+/, "").toLowerCase();
    return (
      (!!normalizedId && identities?.ids.has(normalizedId) === true) ||
      (!!normalizedHandle && identities?.handles.has(normalizedHandle) === true)
    );
  };

  /* --- discovery searches --------------------------------------------- */
  const discoveredChannelIds = new Set<string>();
  const discoveredVideoIds = new Set<string>();
  /** Search-result metadata for InnerTube-discovered videos. */
  const discoveredVideoMeta = new Map<string, InnerTubeSearchVideo>();
  const youtubeVideoEvidence = new Map<string, Map<string, string[]>>();
  const rememberYouTubeVideoEvidence = (
    channelId: string,
    videoId: string,
    ...values: unknown[]
  ) => {
    const evidence = values.filter(
      (value): value is string => typeof value === "string" && value.length > 0,
    );
    if (!evidence.length) return;
    const videos = youtubeVideoEvidence.get(channelId) ?? new Map<string, string[]>();
    videos.set(videoId, [...(videos.get(videoId) ?? []), ...evidence]);
    youtubeVideoEvidence.set(channelId, videos);
  };
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

  if (!args.noSearch) {
    for (const spec of searchSpecs) {
      /**
       * The Data API is used when it is configured and the search budget can
       * afford it. Otherwise InnerTube takes over — for **both** channel and
       * video queries, so a run without an API key still discovers channels
       * from singing videos.
       */
      if (client && budget.canAfford(API_COST.search)) {
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
          let allowedHits = 0;
          for (const r of results) {
            const sn = r?.snippet ?? {};
            const channelId =
              sn?.channelId ?? (spec.type === "channel" ? r?.id?.channelId : null);
            const singingEvidence = hasSingingDiscoveryEvidence([
              sn.title,
              sn.description,
            ]);
            const virtualAndSingingEvidence =
              hasVirtualIdentityEvidence([sn.title, sn.description]) &&
              singingEvidence;
            const knownChannel =
              channelId && isKnownPlatformIdentity("youtube", channelId);
            if (
              channelId &&
              (spec.type === "channel" || knownChannel || virtualAndSingingEvidence)
            ) {
              discoveredChannelIds.add(channelId);
              allowedHits++;
            }
            if (
              channelId &&
              spec.type === "video" &&
              (knownChannel || virtualAndSingingEvidence) &&
              r?.id?.videoId
            ) {
              discoveredVideoIds.add(r.id.videoId);
              if (!knownChannel) {
                rememberYouTubeVideoEvidence(
                  channelId,
                  r.id.videoId,
                  sn.title,
                  sn.description,
                );
              }
            }
          }
          log(
            `search "${spec.query}" (${spec.type}${spec.eventType ? `/${spec.eventType}` : ""}) → ${allowedHits}/${results.length} known or singing-relevant hits`,
          );
        } catch (err) {
          if (err instanceof QuotaExceededError) {
            log("quota exhausted during search — stopping");
            break;
          }
          log(`warn: search "${spec.query}" failed: ${(err as Error).message}`);
        }
        continue;
      }

      if (!innertube.isAvailable) {
        log(
          `skip "${spec.query}" (${spec.type}) — no discovery source available`,
        );
        continue;
      }

      if (spec.type === "channel") {
        const channelIds = await innertube.searchChannels(
          spec.query,
          config.searchResultsPerKeyword,
        );
        for (const id of channelIds) {
          discoveredChannelIds.add(id);
        }
        log(
          `InnerTube search "${spec.query}" (channel) → ` +
            `${channelIds.length} candidate channel(s) for video verification, no Data API quota`,
        );
        continue;
      }

      const videos = await innertube.searchVideos(
        spec.query,
        config.searchResultsPerKeyword,
        { liveOnly: spec.eventType === "live" },
      );
      let allowedHits = 0;
      for (const video of videos) {
        if (!video.channelId) continue;
        const evidence = [video.title, video.description];
        const knownChannel = isKnownPlatformIdentity("youtube", video.channelId);
        const virtualAndSingingEvidence =
          hasVirtualIdentityEvidence(evidence) &&
          hasSingingDiscoveryEvidence(evidence);
        if (!knownChannel && !virtualAndSingingEvidence) continue;
        discoveredChannelIds.add(video.channelId);
        discoveredVideoIds.add(video.id);
        discoveredVideoMeta.set(video.id, video);
        if (!knownChannel) {
          rememberYouTubeVideoEvidence(
            video.channelId,
            video.id,
            video.title,
            video.description,
          );
        }
        allowedHits++;
      }
      log(
        `InnerTube search "${spec.query}" (video) → ` +
          `${allowedHits}/${videos.length} known or singing-relevant hits, no Data API quota`,
      );
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
  const curatedBilibiliIds = new Set<string>();
  for (const seed of ALL_SEEDS) {
    const identity = seed.platformUrls?.bilibili;
    const parsed = identity ? extractPlatformId(identity.url) : null;
    if (parsed?.platform === "bilibili") {
      curatedBilibiliIds.add(parsed.id);
    }
  }
  if (args.roster || !client) {
    const rosterCandidates = await buildRoster({
      onLog: (m) => log(m),
      vdbSource,
      includeOtherPlatforms: false,
    });
    let skippedBilibiliOnly = 0;
    const roster = rosterCandidates.filter((channel) => {
      const bilibiliOnly =
        channel.id.startsWith("bilibili:") &&
        !channel.platforms.some((link) => link.platform === "youtube");
      if (
        bilibiliOnly &&
        !curatedBilibiliIds.has(channel.id.slice("bilibili:".length))
      ) {
        skippedBilibiliOnly++;
        return false;
      }
      const separator = channel.id.indexOf(":");
      const knownById =
        separator > 0
          ? isKnownPlatformIdentity(
              channel.id.slice(0, separator),
              channel.id.slice(separator + 1),
            )
          : isKnownPlatformIdentity("youtube", channel.id);
      return (
        knownById ||
        channel.platforms.some((link) =>
          isKnownPlatformIdentity(link.platform, link.id, link.handle),
        )
      );
    });
    if (skippedBilibiliOnly) {
      log(
        `roster: skipped ${skippedBilibiliOnly} Bilibili-only identities; add them as curated seeds instead`,
      );
    }
    if (roster.length !== rosterCandidates.length) {
      log(
        `roster: retained ${roster.length}/${rosterCandidates.length} identities from vdb, existing data, and seeds`,
      );
    }
    /**
     * The roster knows handles, the dataset knows channel ids.
     *
     * vdb lists a YouTube account as `@handle` — a name the performer can
     * change — while the record on disk is keyed by the permanent `UC…` id
     * once the details pass has resolved it. Matching on the id alone would
     * create a second record for the same channel on every run, so an
     * identity index is built from both the ids and the handles, and a
     * roster entry is merged into whichever record already holds it.
     */
    const identity = (channel: Channel): string[] => {
      const keys: string[] = [`id:${channel.id}`];
      for (const link of channel.platforms ?? []) {
        const ids = [link.id, link.handle].filter(
          (v): v is string => !!v && v.length > 0,
        );
        for (const value of ids) {
          keys.push(`${link.platform}:${value.toLowerCase()}`);
        }
        if (link.platform === "youtube") {
          keys.push(`youtube:user-${(link.handle ?? link.id).toLowerCase()}`);
        }
      }
      return keys;
    };
    const byIdentity = new Map<string, string>();
    for (const channel of channelById.values()) {
      for (const key of identity(channel)) {
        if (!byIdentity.has(key)) byIdentity.set(key, channel.id);
      }
    }

    for (const channel of roster) {
      const knownId =
        channelById.has(channel.id)
          ? channel.id
          : identity(channel)
              .map((key) => byIdentity.get(key))
              .find((id): id is string => !!id);
      const existing = knownId ? channelById.get(knownId) : undefined;
      if (!existing) {
        channelById.set(channel.id, channel);
        for (const key of identity(channel)) {
          if (!byIdentity.has(key)) byIdentity.set(key, channel.id);
        }
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
      /**
       * The roster record is the target — it is the authoritative source —
       * and the existing record fills in the gaps it does not cover.
       * `mergeChannels` keeps a `UC…` id over a handle id, so the record
       * that survives is the one with the stable identity.
       */
      const merged = mergeChannels(channel, existing);
      if (merged.id !== existing.id && existing.id !== channel.id) {
        channelById.delete(existing.id);
      }
      channelById.set(merged.id, merged);
      for (const key of identity(merged)) {
        if (!byIdentity.has(key)) byIdentity.set(key, merged.id);
      }
    }
    log(`roster: ${roster.length} channels, ${channelById.size} total`);
  }


  // 1. Seeded channels (highest priority for provenance).
  for (const raw of resolvedSeeds) {
    const seed =
      seedByChannelId.get(raw.id) ??
      seedHandles.find((entry) =>
        raw.snippet?.customUrl?.endsWith(entry.handle),
      )?.seed;
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
    if (ch) {
      for (const [platform, identity] of Object.entries(seed?.platformUrls ?? {})) {
        const platformId = platform as KnownPlatformId;
        if (ch.platforms.some((link) => link.platform === platformId)) continue;
        const parsed = extractPlatformId(identity.url);
        if (!parsed || parsed.platform !== platformId) {
          log(
            `warn: invalid ${platformId} seed URL for ${seed?.name ?? ch.name}: ${identity.url}`,
          );
          continue;
        }
        ch.platforms.push({
          platform: platformId,
          id: parsed.id,
          handle: null,
          name: null,
          url: PLATFORM_URLS[platformId](parsed.id),
          subscribers: { tag: "hidden" },
          avatar: null,
          lastCheckedAt: now,
        });
      }
      channelById.set(ch.id, ch);
    }
  }

  // 2. Discovered channels (refresh details for up to the per-run cap).
  const discoveredLimit = args.limitChannels ?? config.maxChannelsPerRun;
  const toRefresh = [...discoveredChannelIds]
    .filter((id) => inShard(id, args))
    .filter((id) => !channelById.has(id) || args.force)
    .slice(0, discoveredLimit);

  const hasTwoVirtualSingingVideos = async (channelId: string): Promise<boolean> => {
    const videos =
      youtubeVideoEvidence.get(channelId) ?? new Map<string, string[]>();
    const matches = new Set(
      [...videos.entries()]
        .filter(([, values]) =>
          hasVirtualIdentityEvidence(values) && hasSingingDiscoveryEvidence(values),
        )
        .map(([videoId]) => videoId),
    );
    if (matches.size >= 2) return true;

    for (const upload of await innertube.uploads(channelId, 10)) {
      if (
        hasVirtualIdentityEvidence([upload.title]) &&
        hasSingingDiscoveryEvidence([upload.title])
      ) {
        matches.add(upload.id);
        rememberYouTubeVideoEvidence(channelId, upload.id, upload.title);
      }
    }
    if (matches.size >= 2) return true;

    const playlistId = uploadsPlaylistId(channelId);
    if (!client || !playlistId || !budget.canAfford(
      API_COST.playlistItems + API_COST.videos,
    )) {
      return false;
    }
    try {
      const entries = await client.playlistItems(playlistId, 10);
      const videoIds = entries
        .map((entry: any) => entry?.snippet?.resourceId?.videoId)
        .filter((id: unknown): id is string => typeof id === "string" && !!id);
      const details = videoIds.length ? await client.videos(videoIds) : [];
      for (const video of details) {
        const evidence = [
          video.snippet?.title,
          video.snippet?.description,
          ...(video.snippet?.tags ?? []),
        ];
        if (
          hasVirtualIdentityEvidence(evidence) &&
          hasSingingDiscoveryEvidence(evidence)
        ) {
          matches.add(video.id);
          rememberYouTubeVideoEvidence(channelId, video.id, ...evidence);
        }
      }
    } catch (err) {
      log(
        `warn: YouTube singing evidence lookup failed for ${channelId}: ${(err as Error).message}`,
      );
    }
    return matches.size >= 2;
  };

  const classifyAsVirtualSingingChannel = (channel: Channel, channelId: string) => {
    const evidence = [
      ...(youtubeVideoEvidence.get(channelId)?.values() ?? []),
    ].flat();
    channel.kind = "virtual";
    channel.isSinging = true;
    if (
      hasVirtualIdentityEvidence(evidence) &&
      /(?:vsinger|virtual\s+singer|バーチャルシンガー|虚拟歌姬|虛擬歌姬)/iu.test(
        evidence.join(" "),
      )
    ) {
      channel.role = "vsinger";
    } else {
      channel.role = "vtuber";
    }
    channel.variant = deriveVariant(channel.role, channel.gender, channel.isAi);
  };

  if (toRefresh.length) {
    let refreshed = 0;
    let rejected = 0;
    const failedIds: string[] = [];
    if (innertube.isAvailable) {
      for (const id of toRefresh) {
        const profile = await innertube.profile(id);
        if (
          profile &&
          !isKnownPlatformIdentity("youtube", id) &&
          !(await hasTwoVirtualSingingVideos(id))
        ) {
          rejected++;
          continue;
        }
        const ch = channelFromInnerTubeProfile(
          profile,
          now,
          "api",
          overrides[id],
        );
        if (ch) {
          if (!isKnownPlatformIdentity("youtube", id)) {
            classifyAsVirtualSingingChannel(ch, id);
          }
          channelById.set(ch.id, ch);
          refreshed++;
        } else {
          failedIds.push(id);
        }
      }
    } else {
      failedIds.push(...toRefresh);
    }
    if (client && failedIds.length) {
      try {
        const raws = await client.channels(failedIds);
        for (const raw of raws) {
          if (
            !isKnownPlatformIdentity("youtube", raw.id) &&
            !(await hasTwoVirtualSingingVideos(raw.id))
          ) {
            rejected++;
            continue;
          }
          const ch = channelFromApi(raw, "api", now, overrides[raw.id]);
          if (ch) {
            if (!isKnownPlatformIdentity("youtube", raw.id)) {
              classifyAsVirtualSingingChannel(ch, raw.id);
            }
            channelById.set(ch.id, ch);
            refreshed++;
          }
        }
      } catch (err) {
        log(`warn: Data API channel fallback failed: ${(err as Error).message}`);
      }
    }
    log(
      `refreshed ${refreshed}/${toRefresh.length} discovered channels; rejected ${rejected} without singing evidence`,
    );
  }

  // 3. Use the Data API for known channel profiles only when InnerTube is down.
  const knownIds = [...channelById.keys()];
  if (!innertube.isAvailable && client && knownIds.length) {
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
          // A verification that already happened is kept.
          ch.verification = prev?.verification ?? ch.verification;
          // The API does not know the performer's other names, so the ones
          // the rosters recorded are kept.
          ch.aliases = [
            ...(prev?.aliases ?? []),
            ...(ch.aliases ?? []),
          ];
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

  /* --- hand-written overrides -------------------------------------------- */
  /**
   * `data/overrides.json` is the last word.
   *
   * The overrides used to be applied only to the channels the Data API
   * happened to refresh, so a hand-written correction was silently ignored
   * for every other channel — and a roster-only run ignored all of them.
   * They are applied here instead, to every record, whatever the run did.
   */
  {
    let applied = 0;
    for (const channel of channels) {
      const override = overrides[channel.id];
      if (!override) continue;

      /**
       * A hand-written name is the final word, and the name it replaces
       * becomes an alias so the channel stays findable under it.
       */
      if (override.name && override.name !== channel.name) {
        log(`override: ${channel.name} → ${override.name} (${channel.id})`);
        if (!channel.aliases.includes(channel.name)) {
          channel.aliases.push(channel.name);
        }
        channel.name = override.name;
        channel.nameSource = "manual";
        const primary = primaryPlatformOf(channel);
        const link = channel.platforms.find(
          (p) => p.id === channel.id || p.platform === primary,
        );
        if (link) link.name = override.name;
      }

      if (override.activity) channel.activity = override.activity;
      if (override.kind) channel.kind = override.kind;
      if (override.role) channel.role = override.role;
      if (override.region && override.region !== channel.region) {
        log(`override: ${channel.name} region ${channel.region} → ${override.region}`);
        channel.region = override.region;
        // The provenance has to say who decided it — a hand-written region is
        // the final word, and the record should show that.
        channel.regionSource = "override";
      } else if (override.region) {
        channel.regionSource = "override";
      }
      if (override.agency !== undefined) channel.agency = override.agency;
      if (override.gender) channel.gender = override.gender;
      if (override.isAi !== undefined) channel.isAi = override.isAi;
      if (override.isSinging !== undefined) channel.isSinging = override.isSinging;
      if (override.description) channel.description = override.description;
      if (override.avatar) channel.avatar = override.avatar;
      if (override.verification) channel.verification = override.verification;
      applied++;
    }
    if (applied) log(`overrides: ${applied} channel(s) corrected by hand`);
  }

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
  const twitch = TwitchClient.fromEnv(
    process.env,
    path.join(CACHE_DIR, "twitch"),
  );
  const adapters = createAdapters({
    youtubeClient: null,
    twitchClient: twitch,
    onLog: log,
  });
  if (!twitch) {
    log("twitch: discovery and live checks unavailable; configure TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET");
  }
  if (!adapters.some((adapter) => adapter.id === "ci.me")) {
    log("ci.me: profile refresh unavailable; configure CI_ME_CLIENT_ID and CI_ME_CLIENT_SECRET");
  }

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
    const livePlatforms = new Set(["chzzk", "kick", "soop"]);
    const liveRefreshIntervalMs = 6 * 60 * 60 * 1000;

    /**
     * Only the channels this pass can actually improve.
     *
     * YouTube profiles come from the YouTube API refresh instead, so a
     * channel with no other platform is not a candidate — including it would
     * spend the whole budget on channels the pass cannot resolve.
     */
    const needDetails = channels
      .filter((c) => {
        /**
         * A channel is resolvable if **any** of its platforms has an adapter
         * — including YouTube, which is resolved by InnerTube rather than by
         * the platform adapters.
         */
        const resolvable =
          c.id.startsWith("UC") ||
          c.platforms.some((p) => adapterById.has(p.platform));
        if (!resolvable) return false;
        const lastDetailsAt = c.lastDetailsFetchedAt
          ? Date.parse(c.lastDetailsFetchedAt)
          : Number.NaN;
          const metricsRefreshDue =
            !Number.isFinite(lastDetailsAt) ||
            Date.now() - lastDetailsAt >= 6 * 60 * 60 * 1000;
          const liveRefreshDue =
          c.platforms.some((platform) =>
            livePlatforms.has(platform.platform),
          ) &&
          (!Number.isFinite(lastDetailsAt) ||
            Date.now() - lastDetailsAt >= liveRefreshIntervalMs);
        return (
          !c.description ||
          c.platforms.some((p) => p.subscribers.tag === "hidden") ||
          metricsRefreshDue ||
          liveRefreshDue
        );
      })
      .sort((a, b) =>
        (a.lastDetailsFetchedAt ?? "").localeCompare(
          b.lastDetailsFetchedAt ?? "",
        ),
      )
      .slice(0, budget);

    /**
     * The channels that are missing the most visible fields come first.
     *
     * An avatar is the first thing anyone sees on a card, so a record with
     * no avatar at all is worth more than one that merely lacks a
     * description.
     */
    needDetails.sort((a, b) => {
      const score = (c: Channel) =>
        (c.avatar ? 0 : 4) + (c.description ? 0 : 1) + (c.subscribers.tag === "has" ? 0 : 1);
      return score(b) - score(a);
    });

    /**
     * The budget is **per platform**, not one pool.
     *
     * A single pool lets the largest platform take all of it: Bilibili has
     * four times as many channels as YouTube, so a run that sorts by "no
     * avatar" spends every request on Bilibili and the YouTube and Twitch
     * channels are never resolved at all. A per-platform share keeps every
     * platform moving.
     *
     * The avatar **backlog** is a separate job — `npm run data:avatars` —
     * so this pass is free to prioritise what it is actually good at: the
     * name, the description and the follower count.
     */
    const perPlatform = new Map<PlatformId, Channel[]>();
    for (const channel of needDetails) {
      const platform = primaryPlatformOf(channel);
      if (!platform) continue;
      const list = perPlatform.get(platform) ?? [];
      list.push(channel);
      perPlatform.set(platform, list);
    }

    /**
     * The share each platform gets: an equal split, with the remainder going
     * to the platforms that still have channels waiting.
     */
    const platforms = [...perPlatform.keys()];
    const share = Math.max(1, Math.floor(budget / Math.max(1, platforms.length)));
    const selected: Channel[] = [];
    const leftovers: Channel[] = [];
    for (const platform of platforms) {
      const list = perPlatform.get(platform)!;
      selected.push(...list.slice(0, share));
      leftovers.push(...list.slice(share));
    }
    // Whatever is left over goes to the platforms that have the most waiting.
    selected.push(...leftovers.slice(0, Math.max(0, budget - selected.length)));
    needDetails.length = 0;
    needDetails.push(...selected);
    log(
      `details: ${needDetails.length} channel(s) to resolve · ` +
        platforms.map((p) => `${p} ${Math.min(share, (perPlatform.get(p) ?? []).length)}`).join(", "),
    );

    let resolved = 0;
    for (const channel of needDetails) {
      /**
       * The platform links are visited in a defined order — the channel's
       * primary platform first — so the avatar and the details always come
       * from the same place, rather than from whichever account the source
       * happened to list first.
       */
      const ordered = orderPlatformLinks(channel);
      /**
       * The platform the record is *about* — the one its id belongs to. Only
       * that platform may rename the record: a Bilibili account with a
       * Chinese name must not rename a YouTube channel.
       */
      const primaryPlatform = primaryPlatformOf(channel);

      /**
       * A rename, recorded rather than applied silently.
       *
       * The platform knows the current name; the rosters know the name the
       * performer had when the roster was written. The old name is not
       * thrown away — it becomes an alias, so a search for the name someone
       * remembers still finds the channel.
       */
      const rename = (next: string, platform: string) => {
        const trimmed = next.trim();
        if (!trimmed || trimmed === channel.name) return;
        // A deleted account answers with a placeholder, not a name.
        if (isPlaceholderName(trimmed)) {
          log(`rename: ${channel.name} → (placeholder ignored, ${platform})`);
          return;
        }
        log(`rename: ${channel.name} → ${trimmed} (${platform})`);
        channel.aliases = channel.aliases ?? [];
        if (!channel.aliases.includes(channel.name)) {
          channel.aliases.push(channel.name);
        }
        // Keep the alias list from growing without bound.
        if (channel.aliases.length > 12) {
          channel.aliases = channel.aliases.slice(-12);
        }
        channel.name = trimmed;
        channel.nameSource = "platform";
      };
      /**
       * The YouTube profile, from InnerTube — no quota.
       *
       * The platform knows the channel's **current** name. The rosters carry
       * whatever the name was when they were written, so a performer who has
       * renamed keeps the old name until the platform corrects it.
       */
      if (channel.id.startsWith("UC") && innertube.isAvailable) {
        const profile = await innertube.profile(channel.id);
        if (profile) {
          if (profile.title) {
            rename(profile.title, "youtube");
            const link = channel.platforms.find((p) => p.platform === "youtube");
            if (link) link.name = channel.name;
          }
          {
            const link = channel.platforms.find((p) => p.platform === "youtube");
            if (link) {
              link.lastCheckedAt = now;
              if (profile.views != null) link.viewCount = profile.views;
              if (profile.videos != null) link.videoCount = profile.videos;
            }
            if (profile.views != null) channel.viewCount = profile.views;
            if (profile.videos != null) channel.videoCount = profile.videos;
          }
          if (profile.description && !channel.description) {
            channel.description = profile.description.slice(0, 1000);
          }
          channel.externals = {
            ...channel.externals,
            ...extractExternalLinks(profile.links.join(" ")),
          };
          if (profile.avatar && !channel.avatar) {
            channel.avatar = profile.avatar;
          }
          channel.isOfficialArtist = profile.officialArtist;
          if (profile.subscribers) {
            const link = channel.platforms.find((p) => p.platform === "youtube");
            if (link) {
              link.subscribers = { tag: "has", count: profile.subscribers };
            }
            if (channel.subscribers.tag === "hidden") {
              channel.subscribers = {
                tag: "has",
                count: profile.subscribers,
              };
            }
          }
          resolved++;
        }
      }

      /**
       * The Twitch profile, from GQL — no secret, no quota.
       *
       * The description is where a performer states their own language and
       * their links, and the follower count is the one Twitch publishes
       * publicly.
       */
      {
        const twitchLink = channel.platforms.find(
          (p) => p.platform === "twitch",
        );
        if (twitchLink) {
          /**
           * Ask by the **numeric id** when there is one.
           *
           * The id is stable; the login changes when a performer renames
           * their channel. The track list keeps the old login — 「樞木黎月」
           * is `kururugi_reitsuki` on Twitch, but the list still says
           * `kururugiliyue_0413` — so the login cannot be trusted and the
           * profile has to correct it.
           */
          const query = /^\d+$/.test(twitchLink.id)
            ? twitchLink.id
            : (twitchLink.handle ?? twitchLink.id);
          const profile = await twitchGql.profile(query);
          if (profile) {
            if (profile.description && !channel.description) {
              channel.description = profile.description.slice(0, 1000);
            }
            if (profile.avatar && !channel.avatar) {
              channel.avatar = profile.avatar;
            }
            if (profile.followers) {
              twitchLink.subscribers = {
                tag: "has",
                count: profile.followers,
              };
            }
            twitchLink.lastCheckedAt = now;
            // The profile knows the **current** display name, which
            // corrects a stale roster entry.
            /**
             * Only the record's **own** platform may rename it. A Chinese
             * Bilibili account must not rename a Japanese YouTube channel —
             * the two names are different languages for the same performer.
             */
            if (profile.displayName && primaryPlatform === "twitch") {
              rename(profile.displayName, "twitch");
              twitchLink.name = channel.name;
            }
            // The profile knows the **current** login, so a renamed channel
            // gets a link that resolves.
            if (profile.login && profile.login !== twitchLink.handle) {
              twitchLink.handle = profile.login;
              twitchLink.url = `https://www.twitch.tv/${profile.login}`;
            }
            if (profile.id) twitchLink.id = profile.id;
            if (profile.displayName) twitchLink.name = profile.displayName;
            if (profile.live) {
              // The channel is live right now.
              const item = liveStreamToItem(
                {
                  id: profile.live.id,
                  title: profile.live.title,
                  viewers: profile.live.viewers,
                  platform: "twitch",
                },
                channel,
                now,
              );
              if (item) {
                const prev = itemById.get(item.id);
                itemById.set(item.id, {
                  ...item,
                  addedAt: prev?.addedAt ?? item.addedAt,
                });
              }
            }
            resolved++;
          }
        }
      }

      for (const link of ordered) {
        const adapter = adapterById.get(link.platform);
        if (!adapter) continue;

        // Be polite to the public endpoints: one request at a time, with a
        // short pause between them.
        if (resolved > 0) {
          await new Promise((r) => setTimeout(r, config.detailsDelayMs));
        }

        try {
          const profile = await adapter.resolve(
            link.platform === "ci.me" ? link.id : (link.handle ?? link.id),
          );
          if (!profile) continue;

          /**
           * The platform's name is the current one. A roster can be months
           * old, and performers rename themselves — 「克蕾雅」 is one of them.
           */
          if (profile.name && link.platform === primaryPlatform) {
            rename(profile.name, link.platform);
            link.name = channel.name;
          }

          if (profile.description && !channel.description) {
            channel.description = profile.description.slice(0, 1000);
          }
          channel.externals = {
            ...extractExternalLinks(profile.description),
            ...channel.externals,
          };
          if (profile.avatar && !channel.avatar) channel.avatar = profile.avatar;
          if (profile.subscribers.tag !== "hidden") {
            link.subscribers = profile.subscribers;
          }
          if (profile.handle) link.handle = profile.handle;
          if (profile.videoCount !== undefined) {
            link.videoCount = profile.videoCount;
            if (profile.videoCount !== null && !channel.videoCount) {
              channel.videoCount = profile.videoCount;
            }
          }
          if (profile.viewCount !== undefined) {
            link.viewCount = profile.viewCount;
            if (profile.viewCount !== null && !channel.viewCount) {
              channel.viewCount = profile.viewCount;
            }
          }
          if (profile.subscribers.tag === "hidden" && adapter.followers) {
            // Some platforms publish the count on a different endpoint.
            const followers = await adapter.followers({
              platform: adapter.id,
              id: link.id,
              handle: link.handle,
              name: link.name,
              url: link.url,
              subscribers: link.subscribers,
              avatar: link.avatar,
              description: null,
              tags: [],
            });
            if (followers && followers.tag !== "hidden") {
              link.subscribers = followers;
            }
          }
          link.lastCheckedAt = now;
          try {
            const uploads = await adapter.uploads(
              profile,
              config.maxItemsPerChannel,
            );
            for (const upload of uploads) {
              const item = platformUploadToItem(upload, now, channel);
              if (!item) continue;
              const previous = itemById.get(item.id);
              itemById.set(item.id, {
                ...item,
                addedAt: previous?.addedAt ?? item.addedAt,
              });
            }
          } catch (error) {
            log(
              `warn: ${adapter.id} media lookup failed for ${link.id}: ${(error as Error).message}`,
            );
          }
          resolved++;
        } catch (error) {
          log(
            `warn: ${adapter.id} profile refresh failed for ${link.id}: ` +
              `${(error as Error).message}`,
          );
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
     * Re-classify the channels whose description just arrived.
     *
     * The description is where a performer states what they do — a channel
     * that says 「VTuber / VSinger」 or 「歌い手」 in its bio is a singing
     * channel, and the first classification could not know that because the
     * description had not been fetched yet.
     */
    {
      let reclassified = 0;
      for (const channel of channels) {
        if (!channel.description) continue;
        const fresh = classifyChannel({
          name: channel.name,
          description: channel.description,
          tags: channel.tags,
          country: channel.country,
        });
        if (fresh.isSinging && !channel.isSinging) {
          channel.isSinging = true;
          reclassified++;
        }
        if (fresh.role !== "unknown" && channel.role === "unknown") {
          channel.role = fresh.role;
        }
        if (fresh.gender !== "unknown" && channel.gender === "unknown") {
          channel.gender = fresh.gender;
        }
        if (fresh.agency && !channel.agency) {
          channel.agency = fresh.agency;
        }
      }
      if (reclassified) {
        log(
          `details: ${reclassified} channel(s) marked as singing from their description`,
        );
      }
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
      /**
       * The languages are settled from the **final** region.
       *
       * The region can change at several points — a roster entry, a platform
       * prior, an override — and the languages have to follow whichever one
       * won. Deriving them from different regions is how a Japanese VTuber
       * with a Chinese-subtitled Bilibili channel ended up recorded as
       * speaking Simplified Chinese.
       */
      channel.languages = mergeLanguages(
        channel.statedLanguages,
        languagesForRegion(channel.region),
      );

      // The avatar follows the primary platform, whatever order the source
      // listed the accounts in.
      channel.avatar = pickAvatar(channel);
      // The subscriber count is the best one any of the linked platforms
      // publishes — the primary platform's, then YouTube's, then any other.
      channel.subscribers = pickSubscribers(channel);
    }

    /**
     * The singing flag is read again for **every** channel.
     *
     * The description is where a performer states what they do, and it
     * arrives long after the record was first classified: 「歌勢」, 「翻唱」,
     * "song covers", «кавер» — any of them means the channel sings. The
     * details pass can only re-read the descriptions it fetched this run, so
     * without this pass a channel would keep the wrong flag until the next
     * time it happened to be fetched.
     */
    let markedSinging = 0;
    for (const channel of channels) {
      if (!channel.description) continue;
      const fresh = classifyChannel({
        name: channel.name,
        description: channel.description,
        tags: channel.tags,
        country: null,
      });
      if (fresh.isSinging && !channel.isSinging) {
        channel.isSinging = true;
        markedSinging++;
      }
    }
    if (markedSinging) {
      log(
        `singing: ${markedSinging} channel(s) marked as singing from their description`,
      );
    }

    /**
     * The region is read again for **every** channel, with the same trust
     * order the merge uses.
     *
     * A region can be wrong for a reason the record cannot remember: a
     * Japanese channel that lists its Bilibili account in its description
     * used to be classified `cn` from the word "bilibili" alone, and a record
     * whose region came from vdb's display language is a guess dressed up as
     * a fact. Re-reading the stored name, description, tags and country with
     * the current classifier fixes those without a single request — and a
     * more trusted source never replaces a less trusted one, so an override,
     * a roster and an agency are safe.
     */
    let regionsFixed = 0;
    for (const channel of channels) {
      const fresh = classifyChannel({
        name: channel.name,
        description: channel.description,
        tags: channel.tags,
        country: channel.country,
        platform: primaryPlatformOf(channel) ?? undefined,
      });
      if (
        REGION_TRUST[fresh.regionSource] <=
        REGION_TRUST[channel.regionSource ?? "unknown"]
      ) {
        continue;
      }
      if (fresh.region === channel.region) {
        // The source got stronger but the answer is the same.
        channel.regionSource = fresh.regionSource;
        continue;
      }
      log(
        `region: ${channel.name} ${channel.region} (${channel.regionSource}) → ` +
          `${fresh.region} (${fresh.regionSource})`,
      );
      channel.region = fresh.region;
      channel.regionSource = fresh.regionSource;
      // The language follows the region, unless the performer stated one.
      if (!channel.statedLanguages.length) {
        const current = Array.isArray(channel.languages)
          ? channel.languages
          : [channel.languages].filter(Boolean);
        channel.languages = languagesForRegion(fresh.region, current);
      }
      regionsFixed++;
    }
    if (regionsFixed) {
      log(`region: ${regionsFixed} channel(s) corrected`);
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
      /**
       * The description is where a performer states their own status — and
       * where a name or a bio says 「已畢業」, 「卒業」 or 「retired».
       */
      const activity = detectActivity(
        channel.name,
        channel.description,
        null,
      );
      channel.activity = mergeActivity(channel.activity, activity);
    }
    if (reclassified) {
      log(`details: ${reclassified} channel(s) re-classified from their description`);
    }
  }

  /* --- Twitch enrichment (optional) ------------------------------------ */
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
  /**
   * Resolving a Twitch login costs a request, and there are thousands of
   * Twitch links. The budget keeps a run bounded; the rest are corrected on
   * later runs.
   */
  const twitchBudget = config.maxTwitchResolutionsPerRun;
  let twitchResolutions = 0;

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
        /**
         * The **login** is what goes in a Twitch URL.
         *
         * The track list stores the numeric user id in one column and the
         * login in another. Using the id in the URL gives a link that does
         * not resolve — `twitch.tv/45375753` is not a channel.
         */
        /**
         * The **numeric id** is the stable identifier, so it is what the
         * Twitch API is asked about — the answer is the current login, which
         * corrects the track list's often-stale one.
         *
         * The list's login is only the fallback, for when the API cannot be
         * reached.
         */
        let login: string | null = null;
        if (/^\d+$/.test(record.twitchId) && twitchResolutions < twitchBudget) {
          twitchResolutions++;
          const profile = await twitchGql.profile(record.twitchId);
          if (profile?.login) {
            login = profile.login;
            if (login !== record.twitchLogin) {
              log(
                `twitch: ${channel.name} → ${login} (the list says ${record.twitchLogin ?? "?"})`,
              );
            }
          }
        }
        login ??= record.twitchLogin ?? record.twitchId;

        const link = channel.platforms.find((p) => p.platform === "twitch");
        if (link) {
          link.id = record.twitchId;
          link.handle = login;
          link.url = `https://www.twitch.tv/${login}`;
        } else {
          channel.platforms.push({
            platform: "twitch",
            id: record.twitchId,
            handle: login,
            name: channel.name,
            url: `https://www.twitch.tv/${login}`,
            subscribers: { tag: "hidden" },
            avatar: null,
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
        marked++;
      }
    }
    log(
      `aislist: ${aiList.blocklistCount} blocklist + ${aiList.warnlistCount} warnlist entries, ${marked} channel(s) marked as AI`,
    );
  } else {
    log("aislist: unavailable — falling back to heuristic AI detection");
  }

  /* --- other streaming platforms --------------------------------------- */
  const extraPlatforms = adapters.filter(
    (a) => a.id !== "youtube",
  );

  /**
   * Tell the Bilibili adapter which accounts are in the shared discovery
   * allowlist. Its live endpoint is broad, so the adapter needs the same
   * identity gate before returning candidates or live uploads.
   *
   * Its live endpoint returns the general live feed rather than the VTuber
   * partition, so the roster is the filter that keeps gaming and news streams
   * out of the dataset.
   */
  {
    const bili = adapters.find((a) => a.id === "bilibili") as
      | (typeof adapters)[number] & {
          knownMids?: Set<string>;
          discoverableMids?: Set<string>;
        }
      | undefined;
    if (bili) {
      const biliIdentities = knownPlatformIdentities.get("bilibili");
      const mids = new Set([
        ...(biliIdentities?.ids ?? []),
        ...(biliIdentities?.handles ?? []),
      ]);
      bili.knownMids = mids;
      const linkedIdentities = new Set<string>();
      for (const performer of vdbRoster) {
        if (!performer.platforms.some((link) => link.platform === "youtube")) {
          continue;
        }
        for (const link of performer.platforms) {
          if (link.platform === "bilibili") {
            linkedIdentities.add(link.id);
            if (link.handle) linkedIdentities.add(link.handle);
          }
        }
      }
      for (const id of curatedBilibiliIds) linkedIdentities.add(id);
      bili.discoverableMids = linkedIdentities;
      log(
        `bilibili: ${mids.size} known account(s); ranking discovery limited to ${linkedIdentities.size} curated or YouTube-linked account(s)`,
      );
    }
  }
  if (extraPlatforms.length && !args.noSearch) {
    const platformKeywords = readJson<Record<string, string[]>>(
      path.join(ROOT, "config", "platform-keywords.json"),
      {},
    );
    for (const adapter of extraPlatforms) {
      if (
        adapter.id === "vk" &&
        "hasToken" in adapter &&
        adapter.hasToken === false
      ) {
        log("vk: discovery requires VK_ACCESS_TOKEN; refreshing linked accounts only");
        continue;
      }
      const queries = args.keywords.length
        ? args.keywords
        : platformKeywords[adapter.id] ?? [];
      if (!adapter.search) {
        log(`${adapter.id}: channel discovery unavailable; refreshing linked accounts only`);
        continue;
      }
      if (!queries.length) {
        log(`${adapter.id}: no discovery keywords configured`);
        continue;
      }
      let found = 0;
      let rejected = 0;
      for (const query of queries) {
        try {
          const results = await adapter.search(query, 10);
          for (const foundChannel of results) {
            if (
              !isKnownPlatformIdentity(
                adapter.id,
                foundChannel.id,
                foundChannel.handle,
              )
            ) {
              rejected++;
              continue;
            }
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
      log(`${adapter.id}: discovered ${found} allowlisted channel(s), rejected ${rejected}`);
    }

    /**
     * Collect the media the adapters found while discovering channels.
     *
     * Bilibili's live list is partition-wide, so the adapter hands back the
     * live streams it saw. Niconico search likewise returns videos before
     * their author channels; those media items are retained directly.
     */
    for (const adapter of new Set(
      platformCandidates.map((candidate) => candidate.adapter),
    )) {
      const searchResults = adapter as PlatformAdapter & {
        liveUploads?: PlatformUpload[];
        discoveredUploads?: PlatformUpload[];
      };
      for (const uploads of [
        searchResults.liveUploads,
        searchResults.discoveredUploads,
      ]) {
        if (!Array.isArray(uploads)) continue;
        for (const upload of uploads) {
          if (!isKnownPlatformIdentity(adapter.id, upload.channelId)) continue;
          const item = platformUploadToItem(upload, now);
          if (!item) continue;
          const prev = itemById.get(item.id);
          itemById.set(item.id, { ...item, addedAt: prev?.addedAt ?? item.addedAt });
        }
      }
    }
    for (const { adapter, channel } of platformCandidates) {
      try {
        const uploads = await adapter.uploads(channel, 5);
        for (const upload of uploads) {
          const item = platformUploadToItem(upload, now);
          if (!item) continue;
          const prev = itemById.get(item.id);
          itemById.set(item.id, {
            ...item,
            addedAt: prev?.addedAt ?? item.addedAt,
          });
        }
      } catch (err) {
        log(
          `warn: ${adapter.id} media lookup failed for discovered ${channel.id}: ` +
            `${(err as Error).message}`,
        );
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
        lastCheckedAt: now,
      };
      if (match) {
        match.externals = {
          ...extractExternalLinks(channel.description),
          ...match.externals,
        };
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
  } else if (args.noSearch) {
    log("platform discovery skipped (--no-search)");
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

  const shardRefreshable = refreshable.filter((c) => inShard(c.id, args));
  const channelList =
    args.limitChannels !== null
      ? shardRefreshable.slice(0, args.limitChannels)
      : shardRefreshable.slice(0, config.maxChannelsPerRun);
  if (args.shardCount > 1) {
    log(
      `refresh: ${shardRefreshable.length} channel(s) in shard ` +
        `${args.shardIndex + 1}/${args.shardCount}, fetching ${channelList.length}`,
    );
  }

  let fetchedVideos = 0;
  let fetchedReleases = 0;
  let fetchedDetails = 0;

  for (const channel of channelList) {
    /**
     * InnerTube is the primary upload source. The Data API is the fallback
     * when InnerTube cannot return uploads for this channel.
     */
    if (innertube.isAvailable && channel.id.startsWith("UC")) {
      try {
        const catalog = await innertube.channelCatalog(
          channel.id,
          config.maxItemsPerChannel,
        );
        channel.isOfficialArtist = catalog.officialArtist;
        for (const upload of catalog.uploads) {
          const item = innertubeUploadToItem(upload, channel, now);
          if (!item) continue;
          const prev = itemById.get(item.id);
          itemById.set(item.id, {
            ...item,
            addedAt: prev?.addedAt ?? item.addedAt,
          });
          fetchedVideos++;
        }
        for (const release of catalog.releases) {
          const item = innertubeReleaseToItem(release, channel, now);
          const prev = itemById.get(item.id);
          itemById.set(item.id, {
            ...item,
            addedAt: prev?.addedAt ?? item.addedAt,
          });
          fetchedReleases++;
        }
        if (catalog.uploads.length || catalog.releases.length) {
          channel.lastItemsFetchedAt = now;
          continue;
        }
      } catch {
        log(`warn: InnerTube uploads failed for ${channel.id}`);
      }
    }

    if (!client) continue;
    if (!budget.canAfford(2)) break;
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
  log(
    `fetched ${fetchedVideos} videos / ${fetchedDetails} details / ` +
      `${fetchedReleases} YouTube Music releases`,
  );

  /* --- live + upcoming broadcasts -------------------------------------- */
  /**
   * InnerTube's channel Live tab is the live source.
   *
   * `liveBroadcasts.list` needs OAuth, and the scheduled pipeline only has an
   * API key, so it cannot read another channel's broadcasts. The public Live
   * tab needs no quota and returns the currently live and upcoming entries.
   *
   * A check that succeeds but returns nothing is meaningful: the broadcast
   * that was live on the previous run has ended, so its item is retired to
   * `past` instead of staying on the Live page forever. A failed check
   * (`null`) changes nothing.
   */
  if (config.refreshLiveEveryRun) {
    const itemsByChannel = new Map<string, Item[]>();
    for (const item of itemById.values()) {
      const list = itemsByChannel.get(item.channelId) ?? [];
      list.push(item);
      itemsByChannel.set(item.channelId, list);
    }

    const liveLimit = args.limitLive ?? config.maxLiveChannelsPerRun;
    const liveTargets = singingChannels
      .filter((c) => c.id.startsWith("UC") && inShard(c.id, args))
      .sort((a, b) =>
        (a.lastItemsFetchedAt ?? "").localeCompare(
          b.lastItemsFetchedAt ?? "",
        ),
      )
      .slice(0, liveLimit);

    const liveItemIds = new Set<string>();
    if (liveTargets.length && innertube.isAvailable) {
      let checked = 0;
      let found = 0;
      let retired = 0;
      for (const channel of liveTargets) {
        const streams = await innertube.liveStreams(channel.id);
        if (streams === null) continue;
        checked++;
        const current = new Set(streams.map((stream) => stream.id));
        found += streams.length;

        for (const stream of streams) {
          const item = liveStreamToItem(
            {
              id: stream.id,
              title: stream.title,
              platform: "youtube",
              thumbnail: stream.thumbnail,
              status: stream.status,
              scheduledStart: stream.scheduledStart,
            },
            channel,
            now,
          );
          if (!item) continue;
          const prev = itemById.get(item.id);
          itemById.set(item.id, {
            ...item,
            addedAt: prev?.addedAt ?? item.addedAt,
          });
          liveItemIds.add(item.id);
        }

        for (const existing of itemsByChannel.get(channel.id) ?? []) {
          if (existing.type !== "live") continue;
          if (existing.status !== "live" && existing.status !== "upcoming") {
            continue;
          }
          if (current.has(existing.id)) continue;
          const ended = itemById.get(existing.id);
          if (!ended) continue;
          ended.status = "past";
          ended.actualEnd = ended.actualEnd ?? now;
          ended.publishedAt =
            ended.publishedAt ?? ended.actualStart ?? ended.scheduledStart ?? now;
          ended.updatedAt = now;
          retired++;
        }
      }
      log(
        `innertube live: checked ${checked}/${liveTargets.length} channel(s), ` +
          `found ${found}, stored ${liveItemIds.size}, retired ${retired}`,
      );
    } else if (liveTargets.length) {
      log("live: InnerTube unavailable — skipping live refresh");
    }

    /**
     * The Data API adds the fields the Live tab does not carry: the exact
     * scheduled/actual start, the concurrent viewer count and the statistics.
     * It is optional and bounded to the broadcasts this run discovered.
     */
    if (
      client &&
      liveItemIds.size &&
      budget.canAfford(API_COST.videos)
    ) {
      const ids = [...liveItemIds].slice(0, 50);
      try {
        const details = await fetchVideoDetails(client, ids);
        let enriched = 0;
        for (const raw of details) {
          const channel = channelById.get(raw.snippet?.channelId ?? "");
          if (!channel) continue;
          const item = itemFromApi(raw, channel, "api", now);
          if (!item) continue;
          const prev = itemById.get(item.id);
          itemById.set(item.id, {
            ...item,
            addedAt: prev?.addedAt ?? item.addedAt,
          });
          enriched++;
        }
        log(`live details: enriched ${enriched}/${ids.length} broadcast(s)`);
      } catch (err) {
        log(`warn: live detail fetch failed: ${(err as Error).message}`);
      }
    }
  }

  /* --- discovered videos ------------------------------------------------ */
  if (discoveredVideoIds.size) {
    const ids = [...discoveredVideoIds].slice(0, 200);
    if (client && budget.canAfford(API_COST.videos)) {
      try {
        const details = await fetchVideoDetails(client, ids);
        for (const raw of details) {
          const channel = channelById.get(raw.snippet?.channelId ?? "");
          if (!channel) continue;
          const item = itemFromApi(raw, channel, "api", now);
          if (!item) continue;
          const prev = itemById.get(item.id);
          itemById.set(item.id, {
            ...item,
            addedAt: prev?.addedAt ?? item.addedAt,
          });
        }
        log(`search-discovered videos: ${details.length} stored`);
      } catch (err) {
        log(`warn: discovered video fetch failed: ${(err as Error).message}`);
      }
    } else if (innertube.isAvailable && discoveredVideoMeta.size) {
      /**
       * With no Data API the search result is all the metadata there is: the
       * title, the description snippet and the thumbnail. That is enough to
       * classify and store the video without spending quota.
       */
      let stored = 0;
      for (const id of ids) {
        const meta = discoveredVideoMeta.get(id);
        const channel = meta?.channelId
          ? channelById.get(meta.channelId)
          : undefined;
        if (!meta || !channel) continue;
        const item = innertubeUploadToItem(meta, channel, now);
        if (!item) continue;
        const prev = itemById.get(item.id);
        itemById.set(item.id, {
          ...item,
          addedAt: prev?.addedAt ?? item.addedAt,
        });
        stored++;
      }
      log(
        `search-discovered videos: ${stored} stored from InnerTube ` +
          `(no Data API quota)`,
      );
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
      if (entry.collabVtuber) {
        const collaborator = findChannelByName(channels, entry.collabVtuber);
        const key = entry.collabVtuber.trim().toLowerCase();
        if (
          !item.collaborators.some(
            (existing) => existing.name.trim().toLowerCase() === key,
          )
        ) {
          item.collaborators.push({
            channelId: collaborator?.id ?? null,
            name: entry.collabVtuber,
            kind: collaborator?.kind ?? "virtual",
            region: collaborator?.region ?? "unknown",
          });
        }
      }
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
    channel.activity = mergeActivity(
      channel.activity,
      detectActivity(
        channel.name,
        channel.description,
        newestByChannel.get(channel.id) ?? null,
      ),
    );
  }

  /* --- canonical ids, once more ---------------------------------------- */
  /**
   * A record is re-added after the load pass all the time: a roster or a
   * platform adapter that only knows a channel's **link** builds
   * `UC…/featured` from it, and that string is not the channel's id. The
   * complete set is canonicalised here, just before it is merged with what is
   * on disk — otherwise the copy the sources created is written beside the
   * record that was already there.
   */
  {
    const canonical = canonicalizeChannelIds(channels);
    for (const { from, to } of canonical.renamed) log(`ids: ${from} → ${to}`);
    if (canonical.merged) {
      log(
        `ids: merged ${canonical.merged} duplicate record(s) with the same channel`,
      );
    }
    if (canonical.renamed.length) {
      // Items point at their channel by id, and the id just changed.
      const remap = new Map(canonical.renamed.map((r) => [r.from, r.to]));
      for (const item of items) {
        const to = remap.get(item.channelId);
        if (to) item.channelId = to;
      }
      channelById.clear();
      for (const channel of canonical.channels) {
        channelById.set(channel.id, channel);
      }
    }
    channels = canonical.channels;
  }

  /* --- merge with the on-disk dataset ---------------------------------- */
  const existingThumbnailById = new Map(
    existingItems
      .filter((item) => item.thumbnail)
      .map((item) => [item.id, item.thumbnail!]),
  );
  let thumbnailsFilled = 0;
  let thumbnailLookups = 0;
  for (const item of itemById.values()) {
    if (item.platform !== "bilibili" || item.thumbnail) continue;
    if (!/^BV[\w]+$/i.test(item.id)) continue;
    if (thumbnailLookups >= 20) break;
    const adapter = adapters.find((entry) => entry.id === "bilibili");
    if (!adapter?.thumbnailForItem) break;
    thumbnailLookups++;
    const thumbnail = await adapter.thumbnailForItem(item.id);
    if (!thumbnail) continue;
    item.thumbnail = thumbnail;
    thumbnailsFilled++;
  }
  if (thumbnailsFilled) {
    log(`bilibili: filled ${thumbnailsFilled} missing media thumbnail(s)`);
  }

  channels = mergeById(existingChannels, channels);
  items = mergeById(existingItems, items).map((item) => ({
    ...item,
    thumbnail: item.thumbnail ?? existingThumbnailById.get(item.id) ?? null,
  }));

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
  /**
   * A channel is a singing channel when it has singing **content** — a
   * cover, an MV, an original song or a performance.
   *
   * A live stream on its own is not evidence: every channel streams. It
   * counts only when the channel is already known to be a singing one, which
   * is what makes 「歌枠」 a marker rather than a rule.
   */
  const singingChannelsFound = new Set(
    items
      .filter((i) =>
        ["cover", "mv", "original", "performance"].includes(i.category),
      )
      .map((i) => i.channelId),
  );
  for (const item of items) {
    if (item.category !== "live") continue;
    const channel = channelById.get(item.channelId);
    if (channel?.isSinging) singingChannelsFound.add(item.channelId);
  }
  for (const channel of channels) {
    if (singingChannelsFound.has(channel.id)) channel.isSinging = true;
  }

  /**
   * Drop the items whose channel is no longer in the dataset.
   *
   * The merge is a union with what is on disk, so an item whose channel was
   * removed — or whose channel was never really a performer — would stay
   * forever. This is also what keeps a mis-discovered source from polluting
   * the dataset: an item only survives if its channel is still a channel.
   */
  {
    const known = new Set(channels.map((c) => c.id));
    const before = items.length;
    items = items.filter((i) => known.has(i.channelId));
    if (items.length !== before) {
      log(`cleanup: dropped ${before - items.length} orphaned item(s)`);
    }
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
    releaseLock();
    return;
  }

  const result = writeDataset(channels, items, manifest, now);
  const liveViewers = new Map<string, number>();
  const content: AnalyticsContentObservation[] = [];
  const contentViews = new Map<string, number[]>();
  for (const item of items) {
    if (item.updatedAt !== now) continue;
    const platform = item.platform as KnownPlatformId;
    if (!ALL_PLATFORMS.includes(platform)) continue;
    if (item.status === "live" && item.concurrentViewers !== null) {
      liveViewers.set(
        `${item.channelId}:${platform}`,
        item.concurrentViewers,
      );
    }
    if (
      item.viewCount !== null &&
      item.status !== "live" &&
      item.status !== "upcoming"
    ) {
      content.push({
        platform,
        channelId: item.channelId,
        channelName: item.channelName,
        kind: item.channelKind,
        region: item.region,
        title: item.title,
        url: itemUrlForAnalytics(item),
        publishedAt: item.publishedAt,
        views: item.viewCount,
      });
      const key = `${item.channelId}:${platform}`;
      const values = contentViews.get(key) ?? [];
      values.push(item.viewCount);
      contentViews.set(key, values);
    }
  }
  const observations: AnalyticsObservation[] = [];
  for (const channel of channels) {
    for (const link of channel.platforms) {
      if (link.lastCheckedAt !== now || !ALL_PLATFORMS.includes(link.platform as KnownPlatformId)) {
        continue;
      }
      const platform = link.platform as KnownPlatformId;
      const liveCount = liveViewers.get(`${channel.id}:${platform}`);
      const recentViews = contentViews.get(`${channel.id}:${platform}`);
      const observation: AnalyticsObservation = {
        date: now.slice(0, 10),
        sampledAt: now,
        channelId: channel.id,
        channelName: channel.name,
        kind: channel.kind,
        region: channel.region,
        platform,
      };
      if (link.subscribers.tag === "has") {
        observation.followers = link.subscribers.count;
      } else if (link.subscribers.tag === "no") {
        observation.followers = 0;
      }
      if (link.viewCount != null) observation.views = link.viewCount;
      if (link.videoCount != null) observation.videos = link.videoCount;
      if (liveCount != null) observation.liveViewers = liveCount;
      if (recentViews?.length) {
        observation.recentContentViews = Math.round(
          recentViews.reduce((total, value) => total + value, 0) /
            recentViews.length,
        );
      }
      if (
        observation.followers !== undefined ||
        observation.views !== undefined ||
        observation.videos !== undefined ||
        observation.liveViewers !== undefined ||
        observation.recentContentViews !== undefined
      ) {
        observations.push(observation);
      }
    }
  }
  writePendingAnalytics(observations, content, new Date(now));
  log(
    `analytics: prepared ${observations.length} channel/platform snapshots and ${content.length} content records`,
  );
  printSummary(manifest, channels, items);
  log(`quota used: ${budget.used}/${budget.limit}`);
  log(`dataset: ${result.files} files · ${describeDatasetSize()}`);
  if (result.removed.length) {
    log(`pruned ${result.removed.length} stale shard(s)`);
  }
  releaseLock();
}

/* -------------------------------------------------------------------------- */
/* Multi-platform helpers                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Converts a live or upcoming stream into a dataset item.
 *
 * It is used for both YouTube's Live tab and a Twitch profile's current
 * stream. The platform decides the item URL, so a Twitch stream must not be
 * stored as a YouTube item.
 */
export function liveStreamToItem(
  live: {
    id: string;
    title: string;
    platform?: PlatformId;
    viewers?: number | null;
    thumbnail?: string | null;
    status?: "live" | "upcoming";
    scheduledStart?: string | null;
    actualStart?: string | null;
  },
  channel: Channel,
  now: string,
): Item | null {
  if (!live?.id) return null;
  const status = live.status ?? "live";
  const actualStart =
    status === "upcoming" ? null : (live.actualStart ?? now);
  const classification = classifyItem({
    title: live.title,
    description: null,
    tags: [],
    channelKind: channel.kind,
    status,
    isShort: false,
    durationSeconds: null,
    channelRegion: channel.region,
  });
  return {
    id: live.id,
    platform: live.platform ?? "youtube",
    type: "live",
    channelId: channel.id,
    channelName: channel.name,
    channelKind: channel.kind,
    region: channel.region,
    gender: channel.gender,
    languages: channel.languages,
    isAi: channel.isAi,
    variant: channel.variant,
    title: live.title || "Untitled",
    description: null,
    thumbnail: live.thumbnail ?? null,
    publishedAt: status === "upcoming" ? null : actualStart,
    scheduledStart: live.scheduledStart ?? null,
    actualStart,
    actualEnd: null,
    duration: null,
    status,
    category:
      status === "upcoming"
        ? "premiere"
        : classification.category === "other"
          ? "live"
          : classification.category,
    songTitle: classification.songTitle,
    originalArtist: classification.originalArtist,
    isCollab: classification.isCollab,
    collaborators: [
      {
        channelId: channel.id,
        name: channel.name,
        kind: channel.kind,
        region: channel.region,
      },
    ],
    isAcoustic: classification.isAcoustic,
    tags: [],
    viewCount: null,
    likeCount: null,
    concurrentViewers: live.viewers ?? null,
    source: "api",
    addedAt: now,
    updatedAt: now,
    lastItemsFetchedAt: null,
    lastDetailsFetchedAt: null,
  };
}

/** Maps a published URL to the platform key it belongs to. */
function externalKeyFor(url: string): string | null {
  const map: Record<string, string> = {
    "x.com": "x",
    "twitter.com": "x",
    "instagram.com": "instagram",
    "tiktok.com": "tiktok",
    "bilibili.com": "bilibili",
    "nicovideo.jp": "niconico",
    "discord.gg": "discord",
    "open.spotify.com": "spotify",
    "patreon.com": "patreon",
    "pixiv.net": "pixiv",
    "booth.pm": "booth",
  };
  for (const [host, key] of Object.entries(map)) {
    if (url.includes(host)) return key;
  }
  return null;
}

/**
 * Converts an InnerTube upload into a dataset item.
 *
 * The grid view carries the id, the title and the thumbnail. The published
 * date and the statistics come from the Data API when there is one.
 */
export function innertubeUploadToItem(
  upload: {
    id: string;
    title: string;
    thumbnail: string | null;
    description?: string | null;
  },
  channel: Channel,
  now: string,
): Item | null {
  if (!upload?.id) return null;
  const description = truncate(upload.description ?? null, 600);
  const classification = classifyItem({
    title: upload.title,
    description,
    tags: [],
    channelKind: channel.kind,
    status: "past",
    isShort: false,
    durationSeconds: null,
    channelRegion: channel.region,
  });

  return {
    id: upload.id,
    platform: "youtube",
    type: "video",
    channelId: channel.id,
    channelName: channel.name,
    channelKind: channel.kind,
    region: channel.region,
    gender: channel.gender,
    languages: channel.languages,


    isAi: channel.isAi,
    variant: channel.variant,
    title: upload.title || "Untitled",
    description,
    thumbnail: upload.thumbnail,
    publishedAt: null,
    scheduledStart: null,
    actualStart: null,
    actualEnd: null,
    duration: null,
    status: "past",
    category: classification.category,
    songTitle: classification.songTitle,
    originalArtist: classification.originalArtist,
    isCollab: classification.isCollab,
    collaborators: [
      {
        channelId: channel.id,
        name: channel.name,
        kind: channel.kind,
        region: channel.region,
      },
    ],
    isAcoustic: classification.isAcoustic,
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
}

/** Converts an Official Artist Channel album/single into a playlist item. */
export function innertubeReleaseToItem(
  release: InnerTubeRelease,
  channel: Channel,
  now: string,
): Item {
  return {
    id: release.id,
    platform: "youtube",
    url: `https://www.youtube.com/playlist?list=${encodeURIComponent(release.id)}`,
    type: "playlist",
    channelId: channel.id,
    channelName: channel.name,
    channelKind: channel.kind,
    region: channel.region,
    gender: channel.gender,
    languages: channel.languages,
    isAi: channel.isAi,
    variant: channel.variant,
    title: release.title,
    description: null,
    thumbnail: release.thumbnail,
    publishedAt: null,
    scheduledStart: null,
    actualStart: null,
    actualEnd: null,
    duration: null,
    status: "past",
    category: "other",
    songTitle: null,
    originalArtist: null,
    isCollab: false,
    collaborators: [{
      channelId: channel.id,
      name: channel.name,
      kind: channel.kind,
      region: channel.region,
    }],
    isAcoustic: false,
    tags: ["youtube-music", "release"],
    viewCount: null,
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
 * Converts a platform upload into a dataset item.
 *
 * Items from other platforms are stored alongside the YouTube ones — a
 * Bilibili MV and its YouTube upload are the same performance, and the
 * dataset should not hide one because it came from a different site.
 */
export function platformUploadToItem(
  upload: PlatformUpload,
  now: string,
  owner?: Channel,
): Item | null {
  if (!upload?.id) return null;
  const channelKind = owner?.kind ?? "virtual";
  const region = upload.region ?? owner?.region ?? "unknown";
  const classification = classifyItem({
    title: upload.title ?? "",
    description: upload.description,
    tags: [],
    channelKind,
    status: upload.status,
    isShort: false,
    durationSeconds: upload.duration,
    channelRegion: region,
  });
  return {
    id: upload.id,
    platform: upload.platform,
    url: upload.url,
    type: upload.status === "live" ? "live" : "video",
    channelId:
      owner?.id ??
      (upload.platform === "youtube"
        ? upload.channelId
        : `${upload.platform}:${upload.channelId}`),
    channelName: owner?.name ?? upload.channelId,
    channelKind,
    region,
    gender: owner?.gender ?? "unknown",
    languages: owner?.languages ?? [],

    isAi: owner?.isAi ?? false,
    variant: owner?.variant ?? "unknown",
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
    isCollab: classification.isCollab,
    collaborators: collaboratorsFor(upload.title, owner),
    isAcoustic: classification.isAcoustic,
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
    nameSource: "platform",
    aliases: [],
    handle: channel.handle,
    verification: null,
    kind: classification.kind,
    role: classification.role,
    region: classification.region,
    regionSource: classification.regionSource,
    languages: classification.languages,
    statedLanguages: classification.statedLanguages,

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
        lastCheckedAt: now,
      },
    ],
    externals: extractExternalLinks(channel.description),

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
      if (i.type === "playlist" && i.tags.includes("youtube-music")) return true;
      if (i.status === "live" || i.status === "upcoming") return true;
      const ts = i.publishedAt ? Date.parse(i.publishedAt) : 0;
      if (!ts) return false;
      return ts >= cutoff;
    });

    // Signature uploads and YouTube Music releases are worth keeping even
    // when they are old and do not have a publish timestamp.
    const signature = relevant.filter((i) =>
      ["cover", "mv", "original"].includes(i.category) ||
      (i.type === "playlist" && i.tags.includes("youtube-music")),
    );
    const routine = relevant.filter(
      (i) =>
        !["cover", "mv", "original"].includes(i.category) &&
        !(i.type === "playlist" && i.tags.includes("youtube-music")),
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
