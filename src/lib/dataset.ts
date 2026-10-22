/**
 * Dataset loader.
 *
 * The web app reads the JSON dataset that the sync pipeline commits to the
 * repository. Everything is fetched lazily and cached in memory:
 *
 *   data/manifest.json            counts + region table (always loaded)
 *   data/channels/index.json      lightweight channel summaries (always loaded)
 *   data/channels/virtual.json    full records for virtual performers
 *   data/channels/real.json       full records for real artists
 *   data/items/<region>/<b>.json  items, sharded by region and id bucket
 *   data/items/live.json          currently live streams
 *   data/items/upcoming.json      scheduled streams and premieres
 *   data/search/<region>.json     inverted index for that region
 *
 * Only the slices the user actually looks at are downloaded, which is what
 * makes the sharded layout worth the extra complexity.
 */

import type {
  Affiliation,
  Channel,
  ChannelSummary,
  Gender,
  Item,
  Manifest,
  RegionCode,
} from "@shared/lib/types";
import type { SearchPack, SearchHit } from "@shared/lib/search";
import { searchPacks } from "@shared/lib/search";
import { toLanguageList } from "@shared/lib/regions";

/** Base path of the deployment (handles GitHub Pages sub-paths). */
const BASE = import.meta.env.BASE_URL || "/";

function url(path: string): string {
  return `${BASE}${path.replace(/^\//, "")}`;
}

/* -------------------------------------------------------------------------- */
/* Fetching                                                                   */
/* -------------------------------------------------------------------------- */

async function fetchJson<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(url(path), { headers: { Accept: "application/json" } });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Cache                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The cache is deliberately **not** reactive.
 *
 * The search packs contain tens of thousands of tokens and posting lists.
 * Putting them in a `reactive()` object makes Vue create a deep proxy for
 * every array and object, which turns a lookup into tens of thousands of
 * proxy traps — the search took seconds instead of milliseconds.
 *
 * The data is immutable once loaded, so plain variables are both faster and
 * semantically correct.
 */
const cache = {
  manifest: null as Manifest | null,
  channelManifest: null as
    | { code: RegionCode; channels: number; buckets: string[] }[]
    | null,
  summaries: null as ChannelSummary[] | null,
  summariesByRegion: new Map<RegionCode, ChannelSummary[]>(),
  channelsByKind: new Map<string, Channel[]>(),
  shards: new Map<string, string[]>(),
  virtual: null as Channel[] | null,
  real: null as Channel[] | null,
  live: null as Item[] | null,
  upcoming: null as Item[] | null,
  items: new Map<string, Item[]>(),
  packs: new Map<string, SearchPack>(),
  /** Regions that actually have a search pack (avoids pointless 404s). */
  packRegions: null as RegionCode[] | null,
};

/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

export async function loadManifest(): Promise<Manifest | null> {
  if (cache.manifest) return cache.manifest;
  const manifest = await fetchJson<Manifest>("data/manifest.json");
  if (manifest) cache.manifest = manifest;
  return manifest;
}

/**
 * Loads the channel summaries for the given regions.
 *
 * The summaries are sharded by region and then by id bucket, so only the
 * regions the user is actually looking at are downloaded. With a roster of
 * more than 14,000 performers, loading everything up front would be a waste.
 */
export async function loadSummaries(
  regions: RegionCode[] | "all" = "all",
): Promise<ChannelSummary[]> {
  if (regions === "all" && cache.summaries) return cache.summaries;

  const targets =
    regions === "all"
      ? (await loadChannelManifest()).map((r) => r.code)
      : regions;

  const results = await Promise.all(
    targets.map(async (region) => {
      const cached = cache.summariesByRegion.get(region);
      if (cached) return cached;
      const buckets = await loadShards("channels/summaries", region);
      const list: ChannelSummary[] = [];
      for (const bucket of buckets) {
        const parsed = await fetchJson<{ channels?: ChannelSummary[] }>(
          `data/channels/summaries/${region}/${bucket}.json`,
        );
        list.push(...(parsed?.channels ?? []));
      }
      cache.summariesByRegion.set(region, list);
      return list;
    }),
  );

  const all = results.flat();
  if (regions === "all") cache.summaries = all;
  return all;
}

/** The region list for the channel dataset. */
export async function loadChannelManifest(): Promise<
  { code: RegionCode; channels: number; buckets: string[] }[]
> {
  if (cache.channelManifest) return cache.channelManifest;
  const parsed = await fetchJson<{
    regions?: { code: RegionCode; channels: number; buckets: string[] }[];
  }>("data/channels/manifest.json");
  cache.channelManifest = parsed?.regions ?? [];
  return cache.channelManifest!;
}

/**
 * The shard files that hold a region's records.
 *
 * The manifest lists them, so the browser never has to probe for files that
 * do not exist — which would fill the console with 404s.
 */
async function loadShards(dir: string, region: RegionCode): Promise<string[]> {
  const key = `${dir}:${region}`;
  const cached = cache.shards.get(key);
  if (cached) return cached;

  const manifest = await loadChannelManifest();
  const entry = manifest.find((r) => r.code === region);
  const buckets = entry?.buckets ?? [];
  cache.shards.set(key, buckets);
  return buckets;
}

/** Full channel records for one artist kind, in the given regions. */
export async function loadChannels(
  kind: "virtual" | "real",
  regions: RegionCode[] | "all" = "all",
): Promise<Channel[]> {
  const targets =
    regions === "all"
      ? (await loadChannelManifest()).map((r) => r.code)
      : regions;

  const results = await Promise.all(
    targets.map(async (region) => {
      const cached = cache.channelsByKind.get(`${kind}:${region}`);
      if (cached) return cached;
      const buckets = await loadShards(`channels/${kind}`, region);
      const list: Channel[] = [];
      for (const bucket of buckets) {
        const parsed = await fetchJson<{ channels?: Channel[] }>(
          `data/channels/${kind}/${region}/${bucket}.json`,
        );
        list.push(...(parsed?.channels ?? []));
      }
      cache.channelsByKind.set(`${kind}:${region}`, list);
      return list;
    }),
  );

  const all = results.flat();
  if (kind === "virtual") cache.virtual = all;
  else cache.real = all;
  return all;
}

/** Every channel record, both kinds. */
export async function loadAllChannels(
  regions: RegionCode[] | "all" = "all",
): Promise<Channel[]> {
  const [virtual, real] = await Promise.all([
    loadChannels("virtual", regions),
    loadChannels("real", regions),
  ]);
  return [...virtual, ...real];
}

/** Currently live streams. */
export async function loadLive(): Promise<Item[]> {
  if (cache.live) return cache.live;
  const parsed = await fetchJson<{ items?: Item[] }>("data/items/live.json");
  cache.live = parsed?.items ?? [];
  return cache.live!;
}

/** Scheduled streams and premieres. */
export async function loadUpcoming(): Promise<Item[]> {
  if (cache.upcoming) return cache.upcoming;
  const parsed = await fetchJson<{ items?: Item[] }>(
    "data/items/upcoming.json",
  );
  cache.upcoming = parsed?.items ?? [];
  return cache.upcoming!;
}

/**
 * Loads every item for the given regions.
 * `region: "all"` loads every region that the items manifest knows about.
 */
export async function loadItems(
  regions: RegionCode[] | "all",
): Promise<Item[]> {
  const manifest = await fetchJson<{
    regions?: { code: RegionCode; buckets: string[] }[];
  }>("data/items/manifest.json");

  const targets = regions === "all"
    ? (manifest?.regions ?? []).map((r) => r.code)
    : regions;

  const results = await Promise.all(
    targets.map(async (region) => {
      const key = region;
      const cached = cache.items.get(key);
      if (cached) return cached;

      const buckets = manifest?.regions?.find((r) => r.code === region)?.buckets ?? [];
      const lists = await Promise.all(
        buckets.map(async (bucket) => {
          const parsed = await fetchJson<{ items?: Item[] }>(
            `data/items/${region}/${bucket}.json`,
          );
          return parsed?.items ?? [];
        }),
      );
      const items = lists.flat();
      cache.items.set(key, items);
      return items;
    }),
  );

  return results.flat();
}

/** Loads the search index pack for a region. */
export async function loadSearchPack(region: RegionCode): Promise<SearchPack | null> {
  const cached = cache.packs.get(region);
  if (cached) return cached;
  const pack = await fetchJson<SearchPack>(`data/search/${region}.json`);
  if (pack) cache.packs.set(region, pack);
  return pack;
}

/** Loads the search index for every region (or a subset). */
export async function loadSearchPacks(
  regions: RegionCode[] | "all" = "all",
): Promise<SearchPack[]> {
  if (regions === "all") {
    // Only fetch regions that actually have a pack, so the browser does not
    // log 404s for regions with no data.
    if (!cache.packRegions) {
      const manifest = await fetchJson<{ regions?: { code: RegionCode }[] }>(
        "data/search/manifest.json",
      );
      cache.packRegions = (manifest?.regions ?? [])
        .map((r) => r.code)
        .filter((code) => code !== "unknown");
    }
    const packs = await Promise.all(
      cache.packRegions.map((c) => loadSearchPack(c)),
    );
    return packs.filter((p): p is SearchPack => !!p);
  }
  const packs = await Promise.all(regions.map((r) => loadSearchPack(r)));
  return packs.filter((p): p is SearchPack => !!p);
}

/* -------------------------------------------------------------------------- */
/* Querying                                                                   */
/* -------------------------------------------------------------------------- */

export interface ItemQuery {
  kind?: "virtual" | "real" | "both";
  region?: RegionCode | "all";
  /** Zero or more content categories. Empty means "all". */
  categories?: string[];
  status?: string | "all";
  /** Only items that are singing while playing an instrument. */
  acoustic?: boolean;
  /** Gender filter. */
  gender?: Gender | "all";
  /** Independent or signed to a business group. */
  affiliation?: Affiliation | "all";
  /** A language the performer streams in. */
  language?: string | "all";
  /** `ai` shows only AI performers, `human` hides them, `all` shows both. */
  ai?: "ai" | "human" | "all";
  /** Free-text filter over title / song / channel. */
  text?: string;
  limit?: number;
}

/**
 * Filters a list of items.
 *
 * This is where the global scope switch is enforced — every view funnels its
 * results through here, so `Virtual` / `Real` / `Both` works everywhere
 * without any view having to remember it.
 */
export function filterItems(items: Item[], query: ItemQuery): Item[] {
  const kind = query.kind ?? "both";
  const region = query.region ?? "all";
  const categories = query.categories ?? [];
  const status = query.status ?? "all";
  const gender = query.gender ?? "all";
  const ai = query.ai ?? "all";
  const affiliation = query.affiliation ?? "all";
  const language = query.language ?? "all";
  const text = query.text?.trim().toLowerCase() ?? "";

  const filtered = items.filter((item) => {
    if (kind !== "both" && item.channelKind !== kind) return false;
    if (region !== "all" && item.region !== region) return false;
    if (categories.length > 0 && !categories.includes(item.category)) {
      return false;
    }
    if (status !== "all" && item.status !== status) return false;
    if (query.acoustic && !item.isAcoustic) return false;
    if (gender !== "all" && item.gender !== gender) return false;
    if (ai === "ai" && !item.isAi) return false;
    if (ai === "human" && item.isAi) return false;
    if (text) {
      const haystack = `${item.title} ${item.songTitle ?? ""} ${
        item.originalArtist ?? ""
      } ${item.channelName}`.toLowerCase();
      if (!haystack.includes(text)) return false;
    }
    return true;
  });

  const limit = query.limit ?? 500;
  return filtered
    .sort((a, b) => {
      const at = Date.parse(a.scheduledStart ?? a.publishedAt ?? "") || 0;
      const bt = Date.parse(b.scheduledStart ?? b.publishedAt ?? "") || 0;
      return bt - at;
    })
    .slice(0, limit);
}

/** Filters channel summaries. */
export function filterChannels(
  channels: ChannelSummary[],
  query: ItemQuery,
): ChannelSummary[] {
  const kind = query.kind ?? "both";
  const region = query.region ?? "all";
  const gender = query.gender ?? "all";
  const ai = query.ai ?? "all";
  const affiliation = query.affiliation ?? "all";
  const language = query.language ?? "all";
  const text = query.text?.trim().toLowerCase() ?? "";

  return channels.filter((channel) => {
    if (kind !== "both" && channel.kind !== kind) return false;
    if (region !== "all" && channel.region !== region) return false;
    if (gender !== "all" && channel.gender !== gender) return false;
    if (ai === "ai" && !channel.isAi) return false;
    if (ai === "human" && channel.isAi) return false;
    if (affiliation !== "all" && channel.affiliation !== affiliation) {
      return false;
    }
    if (
      language !== "all" &&
      !toLanguageList(channel.languages).includes(language)
    ) {
      return false;
    }
    if (text) {
      const haystack = `${channel.name} ${channel.handle ?? ""} ${
        channel.agency ?? ""
      }`.toLowerCase();
      if (!haystack.includes(text)) return false;
    }
    return true;
  });
}

/**
 * Runs a full-text search across the loaded search packs.
 *
 * The packs are cached per region, so repeated searches are instant.
 */
export async function search(
  query: string,
  options: {
    kind?: "virtual" | "real" | "both";
    region?: RegionCode | "all";
    limit?: number;
  } = {},
): Promise<SearchHit[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];

  const packs = await loadSearchPacks("all");
  return searchPacks(packs, trimmed, {
    kind: options.kind ?? "both",
    region: options.region ?? "all",
    limit: options.limit ?? 200,
  });
}

/* -------------------------------------------------------------------------- */
/* Formatting helpers                                                         */
/* -------------------------------------------------------------------------- */

/** Formats a subscriber count the way YouTube does (1.2M). */
export function formatCount(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${(value / 1000).toFixed(1).replace(/\.0$/, "")}K`;
  if (value < 1_000_000_000) {
    return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  }
  return `${(value / 1_000_000_000).toFixed(1).replace(/\.0$/, "")}B`;
}

/** Formats a duration in seconds as `1h 23m`. */
export function formatDuration(seconds: number | null | undefined): string {
  if (!seconds || seconds <= 0) return "—";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/** Formats how long ago something happened. */
export function formatRelative(iso: string | null | undefined): string {
  if (!iso) return "";
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return "";
  const diff = Date.now() - ts;
  const minutes = Math.round(diff / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.round(months / 12)}y ago`;
}

/** Formats an upcoming time as a countdown. */
export function formatUntil(iso: string | null | undefined): string {
  if (!iso) return "";
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return "";
  const diff = ts - Date.now();
  if (diff <= 0) return "now";
  const minutes = Math.round(diff / 60000);
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `in ${hours}h`;
  return `in ${Math.round(hours / 24)}d`;
}
