/**
 * Dataset loader.
 *
 * The web app reads the JSON dataset that the sync pipeline commits to the
 * repository. Everything is fetched lazily and cached in memory:
 *
 *   data/manifest.json            counts + region table (always loaded)
 *   data/channels/manifest.json   the shard map, per kind and region
 *   data/channels/virtual/<r>/<b>.json  virtual performers
 *   data/channels/real/<r>/<b>.json     real artists
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
import { toSummary } from "@shared/lib/summary";
import { isScheduleTitle } from "@shared/lib/classify";

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
  channelManifest: null as ChannelRegionMeta[] | null,
  /** The manifest while it is downloading, so parallel readers share one. */
  channelManifestPending: null as Promise<ChannelRegionMeta[]> | null,
  summaries: null as ChannelSummary[] | null,
  summariesByRegion: new Map<RegionCode, ChannelSummary[]>(),
  /** Regions whose summary is being built right now. */
  summariesPending: new Map<RegionCode, Promise<ChannelSummary[]>>(),
  channelsByKind: new Map<string, Channel[]>(),
  /** Shard lists that are being downloaded right now, keyed `kind:region`. */
  channelsPending: new Map<string, Promise<Channel[]>>(),
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

/**
 * Drops every cached fetch.
 *
 * The local dev server can write new channel records into `data/` (the
 * subscription import), and the page has to read them back without a full
 * browser reload — so the cache must be clearable.
 */
export function resetDatasetCache(): void {
  cache.manifest = null;
  cache.channelManifest = null;
  cache.channelManifestPending = null;
  cache.summaries = null;
  cache.summariesByRegion.clear();
  cache.summariesPending.clear();
  cache.channelsByKind.clear();
  cache.channelsPending.clear();
  cache.shards.clear();
  cache.virtual = null;
  cache.real = null;
  cache.live = null;
  cache.upcoming = null;
  cache.items.clear();
  cache.packs.clear();
  cache.packRegions = null;
}

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
 * The channel list for the given regions.
 *
 * A summary is a **projection** of a full record, not a second copy of the
 * channel. The full record is downloaded anyway — the drawer opens it — so
 * the list is built from it: one fetch per region instead of two, and no way
 * for the card and the drawer to disagree about a name or an avatar.
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
      const pending = cache.summariesPending.get(region);
      if (pending) return pending;
      const promise = loadAllChannels([region]).then((channels) =>
        channels.map(toSummary),
      );
      cache.summariesPending.set(region, promise);
      const list = await promise;
      cache.summariesPending.delete(region);
      cache.summariesByRegion.set(region, list);
      return list;
    }),
  );

  const all = results.flat();
  if (regions === "all") cache.summaries = all;
  return all;
}

/** One kind of channel in one region, and the shards that hold it. */
export interface ChannelKindMeta {
  channels: number;
  buckets: string[];
}

/** One region in the channel manifest. */
export interface ChannelRegionMeta {
  code: RegionCode;
  channels: number;
  virtual: ChannelKindMeta;
  real: ChannelKindMeta;
}

/** The region list for the channel dataset. */
export async function loadChannelManifest(): Promise<ChannelRegionMeta[]> {
  if (cache.channelManifest) return cache.channelManifest;
  /**
   * One download, however many readers.
   *
   * The app asks for the list and the summaries together, and the summaries
   * have to resolve the region list first — without this the page fetched the
   * same manifest once per reader before any of them finished.
   */
  if (!cache.channelManifestPending) {
    cache.channelManifestPending = fetchJson<{ regions?: ChannelRegionMeta[] }>(
      "data/channels/manifest.json",
    ).then((parsed) => (cache.channelManifest = parsed?.regions ?? []));
  }
  return cache.channelManifestPending;
}

/**
 * The shard files that hold one kind's records for a region.
 *
 * The manifest lists them, so the browser never has to probe for files that
 * do not exist — which would fill the console with 404s. The two kinds have
 * their own lists: a region can have a `real` shard that no `virtual` file
 * matches, and fetching the wrong list would silently skip records.
 */
async function loadShards(
  kind: "virtual" | "real",
  region: RegionCode,
): Promise<string[]> {
  const key = `${kind}:${region}`;
  const cached = cache.shards.get(key);
  if (cached) return cached;

  const manifest = await loadChannelManifest();
  const entry = manifest.find((r) => r.code === region);
  const buckets = entry?.[kind]?.buckets ?? [];
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
    targets.map((region) => loadKind(kind, region)),
  );

  const all = results.flat();
  if (kind === "virtual") cache.virtual = all;
  else cache.real = all;
  return all;
}

/**
 * One kind of one region, cached and de-duplicated in flight.
 *
 * `loadSummaries()` and `loadAllChannels()` are called together by the app,
 * and both need these shards. Without the in-flight map the page would
 * download every shard twice and use whichever copy finished last.
 */
/** The defaults a compact shard leaves out, so a record is complete. */
const CHANNEL_DEFAULTS: Record<string, unknown> = {
  aliases: [],
  tags: [],
  statedLanguages: [],
  platforms: [],
  externals: {},
  banner: null,
  description: null,
  country: null,
  agency: null,
  handle: null,
  debutDate: null,
  graduateDate: null,
  uploadsPlaylistId: null,
  popularVideoId: null,
  verification: null,
  officialArtistCheckedAt: null,
  isOfficialArtist: false,
  isAi: false,
  isSinging: false,
  videoCount: null,
  viewCount: null,
};

/**
 * A shard record as a complete one.
 *
 * Shards are written one channel per line with the fields equal to their
 * default left out (`scripts/lib/dataset.ts` → `compactChannel()`), because a
 * pretty-printed shard made every one-record change a whole-file diff. The
 * browser has to put those fields back — the filters read `isSinging`,
 * `aliases` and `externals` directly.
 */
function expandChannel(raw: Channel): Channel {
  const channel = { ...raw } as Channel & Record<string, unknown>;
  for (const [key, value] of Object.entries(CHANNEL_DEFAULTS)) {
    if (channel[key] === undefined) channel[key] = value;
  }
  return channel as Channel;
}

async function loadKind(
  kind: "virtual" | "real",
  region: RegionCode,
): Promise<Channel[]> {
  const key = `${kind}:${region}`;
  const cached = cache.channelsByKind.get(key);
  if (cached) return cached;

  const pending = cache.channelsPending.get(key);
  if (pending) return pending;

  const promise = (async () => {
    const buckets = await loadShards(kind, region);
    const list: Channel[] = [];
    for (const bucket of buckets) {
      const parsed = await fetchJson<{ channels?: Channel[] }>(
        `data/channels/${kind}/${region}/${bucket}.json`,
      );
      for (const raw of parsed?.channels ?? []) {
        if (raw?.id) list.push(expandChannel(raw));
      }
    }
    return list;
  })();

  cache.channelsPending.set(key, promise);
  const list = await promise;
  cache.channelsPending.delete(key);
  cache.channelsByKind.set(key, list);
  return list;
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
  /** Platform whose content or channel identity must be present. */
  platform?: string | "all";
  /** Zero or more content categories. Empty means "all". */
  categories?: string[];
  status?: string | "all";
  /** Only items that are singing while playing an instrument. */
  acoustic?: boolean;
  /** Gender filter. */
  gender?: Gender | "all";
  /** Independent or signed to a business group. */
  affiliation?: Affiliation | "all";
  /** Only the channels that publish singing content. */
  singing?: "all" | "singing" | "not-singing";
  /** What the performer does — `vsinger`, `vtuber`, `singer`, `producer`. */
  role?: string | "all";
  /**
   * The two halves the dataset exists for. `vsinger` is role `vsinger` **or**
   * a published singing flag; `vtuber` is the remaining virtual performers.
   */
  vtuberOnly?: "all" | "vtuber" | "vsinger";
  /** A language the performer streams in. */
  language?: string | "all";
  /** `ai` shows only AI performers, `human` hides them, `all` shows both. */
  ai?: "ai" | "human" | "all";
  /** `oac` shows only channels with the 🎵 Official Artist badge. */
  oac?: "all" | "oac";
  /**
   * Upcoming content: an actual scheduled stream (`stream`) or a schedule
   * announcement (`schedule`) — 日程 / 週表 / スケジュール / timetable.
   */
  schedule?: "all" | "stream" | "schedule";
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
export function platformOfItem(item: Item): string {
  return (
    item.platform ??
    (item.channelId.includes(":")
      ? item.channelId.slice(0, item.channelId.indexOf(":"))
      : "youtube")
  );
}

export function filterItems(items: Item[], query: ItemQuery): Item[] {
  const kind = query.kind ?? "both";
  const region = query.region ?? "all";
  const platform = query.platform ?? "all";
  const categories = query.categories ?? [];
  const status = query.status ?? "all";
  const gender = query.gender ?? "all";
  const ai = query.ai ?? "all";
  const affiliation = query.affiliation ?? "all";
  const language = query.language ?? "all";
  const schedule = query.schedule ?? "all";
  const text = query.text?.trim().toLowerCase() ?? "";

  const filtered = items.filter((item) => {
    if (kind !== "both" && item.channelKind !== kind) return false;
    if (region !== "all" && item.region !== region) return false;
    if (platform !== "all" && platformOfItem(item) !== platform) return false;
    if (categories.length > 0 && !categories.includes(item.category)) {
      return false;
    }
    if (status !== "all" && item.status !== status) return false;
    if (query.acoustic && !item.isAcoustic) return false;
    if (gender !== "all" && item.gender !== gender) return false;
    if (ai === "ai" && !item.isAi) return false;
    if (ai === "human" && item.isAi) return false;
    if (schedule !== "all") {
      const isSchedule = isScheduleTitle(item.title);
      if (schedule === "schedule" && !isSchedule) return false;
      if (schedule === "stream" && isSchedule) return false;
    }
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
  const platform = query.platform ?? "all";
  const gender = query.gender ?? "all";
  const ai = query.ai ?? "all";
  const affiliation = query.affiliation ?? "all";
  const language = query.language ?? "all";
  const singing = query.singing ?? "all";
  const role = query.role ?? "all";
  const vtuberOnly = query.vtuberOnly ?? "all";
  const oac = query.oac ?? "all";
  const text = query.text?.trim().toLowerCase() ?? "";

  return channels.filter((channel) => {
    if (kind !== "both" && channel.kind !== kind) return false;
    if (region !== "all" && channel.region !== region) return false;
    if (
      platform !== "all" &&
      !channel.links.some((link) => link.p === platform) &&
      !channel.externals?.[platform]
    ) {
      return false;
    }
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
    if (singing === "singing" && !channel.isSinging) return false;
    if (singing === "not-singing" && channel.isSinging) return false;
    if (role === "producer") {
      if (channel.role !== "producer" && channel.role !== "composer") {
        return false;
      }
    } else if (role !== "all" && channel.role !== role) {
      return false;
    }
    /**
     * The two halves the dataset is about.
     *
     * A VSinger is `role = vsinger` **or** published singing: the subscription
     * groups set the flag, and the classifier can read a singer's role as
     * `vtuber` when the description never says 歌勢. Filtering on the role
     * alone would drop exactly the performers the group was telling us
     * about.
     */
    if (vtuberOnly === "vsinger" && !(channel.role === "vsinger" || channel.isSinging)) {
      return false;
    }
    if (
      vtuberOnly === "vtuber" &&
      (channel.kind !== "virtual" ||
        channel.role === "vsinger" ||
        channel.isSinging)
    ) {
      return false;
    }
    if (oac === "oac" && !channel.isOfficialArtist) return false;
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
/* Sorting                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Sorts the items for a view.
 *
 * Each tab has its own natural order — the live tab by how long the stream
 * has been running, the songs tab by when the cover was published — and the
 * user can override it.
 */
export function sortItems(
  items: Item[],
  order: string,
): Item[] {
  const byTime = (a: Item, b: Item) =>
    (b.scheduledStart ?? b.publishedAt ?? "").localeCompare(
      a.scheduledStart ?? a.publishedAt ?? "",
    );

  const sorted = [...items];
  switch (order) {
    case "oldest":
      return sorted.sort((a, b) => -byTime(a, b));
    case "title":
      return sorted.sort((a, b) => a.title.localeCompare(b.title));
    case "views":
      return sorted.sort((a, b) => (b.viewCount ?? 0) - (a.viewCount ?? 0));
    case "duration":
      return sorted.sort((a, b) => (b.duration ?? 0) - (a.duration ?? 0));
    case "viewers":
      return sorted.sort(
        (a, b) => (b.concurrentViewers ?? 0) - (a.concurrentViewers ?? 0),
      );
    case "subscribers":
      // The item does not carry the channel's subscriber count, so this
      // falls back to the item's own view count.
      return sorted.sort((a, b) => (b.viewCount ?? 0) - (a.viewCount ?? 0));
    case "soon":
      return sorted.sort((a, b) =>
        (a.scheduledStart ?? "9999").localeCompare(b.scheduledStart ?? "9999"),
      );
    case "recent":
    default:
      return sorted.sort(byTime);
  }
}

/**
 * Sorts the channels for a view.
 */
export function sortChannels(
  channels: ChannelSummary[],
  order: string,
): ChannelSummary[] {
  const sorted = [...channels];
  switch (order) {
    case "name":
      return sorted.sort((a, b) => a.name.localeCompare(b.name));
    case "recent":
      return sorted.sort((a, b) =>
        (b.addedAt ?? "").localeCompare(a.addedAt ?? ""),
      );
    case "region":
      return sorted.sort(
        (a, b) => a.region.localeCompare(b.region) || a.name.localeCompare(b.name),
      );
    case "subscribers":
    default:
      return sorted.sort((a, b) => (b.subscribers ?? 0) - (a.subscribers ?? 0));
  }
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
