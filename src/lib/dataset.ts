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
import { markRaw } from "vue";
import type { SearchPack, SearchHit } from "@shared/lib/search";
import { searchPacks } from "@shared/lib/search";
import { canonicalAgency } from "@shared/lib/regions";
import { toSummary } from "@shared/lib/summary";
import { isScheduleTitle } from "@shared/lib/classify";

import { filterChannelList } from "./filter-index";
import { fetchUrl, loadOrigins, resetOrigins, type DatasetOrigin } from "./origins";

/* -------------------------------------------------------------------------- */
/* Fetching                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * One file, from one origin.
 *
 * Every loader below asks for the same relative path on **every** origin and
 * merges the answers. With one origin — no `data/volumes.json`, which is the
 * normal deployment — that is exactly the single request it always was.
 */
function fetchJson<T>(origin: DatasetOrigin, path: string): Promise<T | null> {
  return fetchUrl<T>(origin.url(path));
}

/**
 * Marks a loaded record as immutable.
 *
 * The app keeps the dataset in a `ref`, and a `ref` deep-proxies everything it
 * is given: every `channel.name`, `channel.region` and `channel.isSinging` in
 * a filter pass becomes a proxy trap. On 72,698 records that is the difference
 * between a 7 ms filter and a 43 ms one — measured — and the same reason the
 * search packs are kept out of `reactive()` below.
 *
 * Nothing mutates a loaded record: a rename arrives as a new array from the
 * loader, and the views build new objects when they need to override a field
 * (`badgeAwareSummaries` in `App.vue`). So marking them raw is what the data
 * already was — immutable — and Vue skips the proxy it would never need.
 */
function immutable<T extends object>(value: T): T {
  return markRaw(value);
}

/** Items arrive from several volumes; an id is still an id. */
function uniqueById<T extends { id: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
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
  /** Each volume's own shard map — a merged map cannot say who has what. */
  channelManifestByOrigin: new Map<number, ChannelRegionMeta[]>(),
  itemsManifestByOrigin: new Map<number, { code: RegionCode; buckets: string[] }[]>(),
  summaries: null as ChannelSummary[] | null,
  summariesByRegion: new Map<RegionCode, ChannelSummary[]>(),
  /** Regions whose summary is being built right now. */
  summariesPending: new Map<RegionCode, Promise<ChannelSummary[]>>(),
  channelsByKind: new Map<string, Channel[]>(),
  /** Shard lists that are being downloaded right now, keyed `kind:region`. */
  channelsPending: new Map<string, Promise<Channel[]>>(),
  virtual: null as Channel[] | null,
  real: null as Channel[] | null,
  live: null as Item[] | null,
  upcoming: null as Item[] | null,
  items: new Map<string, Item[]>(),
  packs: new Map<string, SearchPack[]>(),
  /** Packs that actually exist per origin, in the order they belong together. */
  packFilesByOrigin: new Map<number, { region: RegionCode; shard: number }[]>(),
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
  cache.channelManifestByOrigin.clear();
  cache.itemsManifestByOrigin.clear();
  resetOrigins();
  cache.summaries = null;
  cache.summariesByRegion.clear();
  cache.summariesPending.clear();
  cache.channelsByKind.clear();
  cache.channelsPending.clear();
  cache.virtual = null;
  cache.real = null;
  cache.live = null;
  cache.upcoming = null;
  cache.items.clear();
  cache.packs.clear();
  cache.packFilesByOrigin.clear();
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

export async function loadManifest(): Promise<Manifest | null> {
  if (cache.manifest) return cache.manifest;
  const origins = await loadOrigins();
  const manifests = await Promise.all(
    origins.map((origin) => fetchJson<Manifest>(origin, "data/manifest.json")),
  );
  const found = manifests.filter((m): m is Manifest => !!m);
  if (!found.length) return null;
  cache.manifest = found.length === 1 ? found[0] : mergeManifests(found);
  return cache.manifest;
}

/**
 * Adds up the manifests of several volumes.
 *
 * The counts are the **catalogue's**, not one volume's — that is what the
 * header and the footer mean when they say how many channels there are. The
 * quota is the one number that is not a sum: every volume's workflow spends
 * from the same project allowance, so the total spent adds up while the limit
 * stays where it is.
 */
function mergeManifests(manifests: Manifest[]): Manifest {
  const first = manifests[0];
  const counts = { ...first.counts };
  for (const key of Object.keys(counts) as (keyof Manifest["counts"])[]) {
    counts[key] = manifests.reduce((sum, m) => sum + (m.counts[key] ?? 0), 0);
  }

  const regions = new Map<RegionCode, Manifest["regions"][number]>();
  for (const manifest of manifests) {
    for (const region of manifest.regions ?? []) {
      const seen = regions.get(region.code);
      if (!seen) {
        regions.set(region.code, { ...region });
        continue;
      }
      seen.channels = (seen.channels ?? 0) + (region.channels ?? 0);
      seen.items = (seen.items ?? 0) + (region.items ?? 0);
    }
  }

  const used = manifests.reduce((sum, m) => sum + (m.quota?.used ?? 0), 0);
  return {
    ...first,
    counts,
    regions: [...regions.values()],
    quota: first.quota
      ? {
          used,
          limit: first.quota.limit,
          remaining: Math.max(0, first.quota.limit - used),
        }
      : first.quota,
  };
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

  const targets = regions === "all" ? (await loadChannelManifest()).map((r) => r.code) : regions;

  const results = await Promise.all(
    targets.map(async (region) => {
      const cached = cache.summariesByRegion.get(region);
      if (cached) return cached;
      const pending = cache.summariesPending.get(region);
      if (pending) return pending;
      const promise = loadAllChannels([region]).then((channels) =>
        channels.map((channel) => immutable(toSummary(channel))),
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

/**
 * The region list for the whole catalogue.
 *
 * When the dataset is split, this is the **union** of the volumes' maps: the
 * app needs the regions, and a region may be spread over several of them. The
 * per-volume maps are kept separately, because a merged bucket list does not
 * say which origin holds the file — and a shard fetched from the wrong origin
 * is a 404, not a record.
 */
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
    cache.channelManifestPending = (async () => {
      const origins = await loadOrigins();
      const perOrigin = await Promise.all(
        origins.map((origin) => loadOriginChannelManifest(origin)),
      );
      cache.channelManifest = mergeChannelManifests(perOrigin);
      return cache.channelManifest;
    })();
  }
  return cache.channelManifestPending;
}

/** One origin's own shard map, exactly as that volume wrote it. */
async function loadOriginChannelManifest(origin: DatasetOrigin): Promise<ChannelRegionMeta[]> {
  const cached = cache.channelManifestByOrigin.get(origin.index);
  if (cached) return cached;
  const parsed = await fetchJson<{ regions?: ChannelRegionMeta[] }>(
    origin,
    "data/channels/manifest.json",
  );
  const regions = parsed?.regions ?? [];
  cache.channelManifestByOrigin.set(origin.index, regions);
  return regions;
}

function mergeChannelManifests(list: ChannelRegionMeta[][]): ChannelRegionMeta[] {
  const byRegion = new Map<RegionCode, ChannelRegionMeta>();
  const add = (target: ChannelKindMeta, source: ChannelKindMeta) => {
    target.channels += source.channels;
    for (const bucket of source.buckets) {
      if (!target.buckets.includes(bucket)) target.buckets.push(bucket);
    }
  };

  for (const regions of list) {
    for (const region of regions) {
      const seen = byRegion.get(region.code);
      if (!seen) {
        byRegion.set(region.code, {
          code: region.code,
          channels: region.channels,
          virtual: {
            channels: region.virtual.channels,
            buckets: [...region.virtual.buckets],
          },
          real: { channels: region.real.channels, buckets: [...region.real.buckets] },
        });
        continue;
      }
      seen.channels += region.channels;
      add(seen.virtual, region.virtual);
      add(seen.real, region.real);
    }
  }

  for (const region of byRegion.values()) {
    region.virtual.buckets.sort();
    region.real.buckets.sort();
  }
  return [...byRegion.values()];
}

/** Full channel records for one artist kind, in the given regions. */
export async function loadChannels(
  kind: "virtual" | "real",
  regions: RegionCode[] | "all" = "all",
): Promise<Channel[]> {
  const targets = regions === "all" ? (await loadChannelManifest()).map((r) => r.code) : regions;

  const results = await Promise.all(targets.map((region) => loadKind(kind, region)));

  const all = results.flat();
  if (kind === "virtual") cache.virtual = all;
  else cache.real = all;
  return all;
}

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
  reincarnationOf: null,
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
  /**
   * One agency is one string, whatever the shard says.
   *
   * The pipeline canonicalises an agency when it writes a record, but a shard
   * written before a spelling was added still holds the old one —
   * `NIJISANJI` beside `nijisanji`, `HOLOSTARS` beside `holostars`. The list
   * views group by this value, so the same fold runs on read, from the one
   * definition in `scripts/lib/regions.ts`.
   */
  channel.agency = canonicalAgency(channel.agency as string | null);
  return channel as Channel;
}

/**
 * One kind of one region.
 *
 * With volumes this is a fan-out: every origin is asked whether it holds that
 * region, and only the ones that do are downloaded from. That is why the
 * merged manifest is not used here — it answers "who has this region", not
 * "which of them has bucket 07".
 */
async function loadKind(kind: "virtual" | "real", region: RegionCode): Promise<Channel[]> {
  const key = `${kind}:${region}`;
  const cached = cache.channelsByKind.get(key);
  if (cached) return cached;

  const pending = cache.channelsPending.get(key);
  if (pending) return pending;

  const promise = (async () => {
    const origins = await loadOrigins();
    const lists = await Promise.all(
      origins.map(async (origin) => {
        const manifest = await loadOriginChannelManifest(origin);
        const buckets = manifest.find((entry) => entry.code === region)?.[kind]?.buckets ?? [];
        const shards = await Promise.all(
          buckets.map((bucket) =>
            fetchJson<{ channels?: Channel[] }>(
              origin,
              `data/channels/${kind}/${region}/${bucket}.json`,
            ),
          ),
        );
        const list: Channel[] = [];
        for (const parsed of shards) {
          for (const raw of parsed?.channels ?? []) {
            if (raw?.id) list.push(immutable(expandChannel(raw)));
          }
        }
        return list;
      }),
    );
    return lists.flat();
  })();

  cache.channelsPending.set(key, promise);
  const list = await promise;
  cache.channelsPending.delete(key);
  cache.channelsByKind.set(key, list);
  return list;
}

/** Every channel record, both kinds. */
export async function loadAllChannels(regions: RegionCode[] | "all" = "all"): Promise<Channel[]> {
  const [virtual, real] = await Promise.all([
    loadChannels("virtual", regions),
    loadChannels("real", regions),
  ]);
  return [...virtual, ...real];
}

/** Currently live streams, from every volume. */
export async function loadLive(): Promise<Item[]> {
  if (cache.live) return cache.live;
  const origins = await loadOrigins();
  const pages = await Promise.all(
    origins.map((origin) => fetchJson<{ items?: Item[] }>(origin, "data/items/live.json")),
  );
  cache.live = uniqueById(pages.flatMap((page) => page?.items ?? [])).map(immutable);
  return cache.live;
}

/** Scheduled streams and premieres, from every volume. */
export async function loadUpcoming(): Promise<Item[]> {
  if (cache.upcoming) return cache.upcoming;
  const origins = await loadOrigins();
  const pages = await Promise.all(
    origins.map((origin) => fetchJson<{ items?: Item[] }>(origin, "data/items/upcoming.json")),
  );
  cache.upcoming = uniqueById(pages.flatMap((page) => page?.items ?? [])).map(immutable);
  return cache.upcoming;
}

/** One origin's items shard map. */
async function loadOriginItemsManifest(
  origin: DatasetOrigin,
): Promise<{ code: RegionCode; buckets: string[] }[]> {
  const cached = cache.itemsManifestByOrigin.get(origin.index);
  if (cached) return cached;
  const parsed = await fetchJson<{ regions?: { code: RegionCode; buckets: string[] }[] }>(
    origin,
    "data/items/manifest.json",
  );
  const regions = parsed?.regions ?? [];
  cache.itemsManifestByOrigin.set(origin.index, regions);
  return regions;
}

/**
 * Loads every item for the given regions.
 * `region: "all"` loads every region that the items manifest knows about.
 */
export async function loadItems(regions: RegionCode[] | "all"): Promise<Item[]> {
  const origins = await loadOrigins();
  const manifests = await Promise.all(origins.map((origin) => loadOriginItemsManifest(origin)));

  const targets =
    regions === "all"
      ? [...new Set(manifests.flatMap((regions) => regions.map((r) => r.code)))]
      : regions;

  const results = await Promise.all(
    targets.map(async (region) => {
      const cached = cache.items.get(region);
      if (cached) return cached;

      const perOrigin = await Promise.all(
        origins.map(async (origin, position) => {
          const buckets = manifests[position].find((entry) => entry.code === region)?.buckets ?? [];
          const shards = await Promise.all(
            buckets.map((bucket) =>
              fetchJson<{ items?: Item[] }>(origin, `data/items/${region}/${bucket}.json`),
            ),
          );
          return shards.flatMap((parsed) => parsed?.items ?? []);
        }),
      );

      const items = uniqueById(perOrigin.flat()).map(immutable);
      cache.items.set(region, items);
      return items;
    }),
  );

  return results.flat();
}

/**
 * The file a pack is written to.
 *
 * A region used to be one file. Ten thousand records of tokens and postings
 * are more than a file should be, so a region may now be several packs:
 * `<region>.json` is the first, `<region>.1.json` the second, and so on.
 */
function packFile(region: string, shard: number): string {
  return shard === 0 ? `data/search/${region}.json` : `data/search/${region}.${shard}.json`;
}

/** One origin's list of packs, from its own search manifest. */
async function loadOriginSearchPacks(
  origin: DatasetOrigin,
): Promise<{ region: RegionCode; shard: number }[]> {
  const cached = cache.packFilesByOrigin.get(origin.index);
  if (cached) return cached;
  const manifest = await fetchJson<{
    regions?: { code: RegionCode; shard?: number }[];
  }>(origin, "data/search/manifest.json");
  const files = (manifest?.regions ?? []).map((row) => ({
    region: row.code,
    shard: row.shard ?? 0,
  }));
  cache.packFilesByOrigin.set(origin.index, files);
  return files;
}

/**
 * Loads every pack of a region, from every volume that has one.
 *
 * The pack carries its own inverted index, so two packs of one region are not
 * a problem: a query looks up each of them and the hits are merged. What must
 * stay true is the *order*, because the app ranks hits by score across packs
 * anyway — the order only decides which region is fetched first.
 */
export async function loadSearchPack(region: RegionCode): Promise<SearchPack[]> {
  const cached = cache.packs.get(region);
  if (cached) return cached;

  const origins = await loadOrigins();
  const perOrigin = await Promise.all(
    origins.map(async (origin) => {
      const files = await loadOriginSearchPacks(origin);
      const shards = files.filter((file) => file.region === region).map((file) => file.shard);
      const packs = await Promise.all(
        shards.map((shard) => fetchJson<SearchPack>(origin, packFile(region, shard))),
      );
      return packs.filter((pack): pack is SearchPack => !!pack);
    }),
  );

  const found = perOrigin.flat();
  cache.packs.set(region, found);
  return found;
}

/** Loads the search index for every region (or a subset). */
export async function loadSearchPacks(
  regions: RegionCode[] | "all" = "all",
): Promise<SearchPack[]> {
  if (regions === "all") {
    /**
     * Only regions that actually have a pack, so the browser does not log
     * 404s for regions with no data. With volumes, that is the union of the
     * volumes' manifests — a region may live in one volume and not another.
     */
    const origins = await loadOrigins();
    const perOrigin = await Promise.all(origins.map((origin) => loadOriginSearchPacks(origin)));
    const wanted = [
      ...new Set(
        perOrigin
          .flat()
          .filter((file) => file.region !== "unknown")
          .map((file) => file.region),
      ),
    ];
    const packs = await Promise.all(wanted.map((region) => loadSearchPack(region)));
    return packs.flat();
  }
  const packs = await Promise.all(regions.map((region) => loadSearchPack(region)));
  return packs.flat();
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
  /** An exact agency, e.g. `Hololive EN` — the members of that group. */
  agency?: string;
  /** An exact declared tag — the channels that carry it. */
  tag?: string;
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
  const role = query.role ?? "all";
  const vtuberOnly = query.vtuberOnly ?? "all";
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
    // Items don't carry `role` directly (it's a channel-level field), so
    // use `channelKind` (virtual / real) as the best available signal:
    // virtual performers → vsinger / vtuber, real → singer / producer.
    if (role === "singer" || role === "producer") {
      if (item.channelKind !== "real") return false;
    }
    if (role === "vsinger" || role === "vtuber") {
      if (item.channelKind !== "virtual") return false;
    }
    // vtuberOnly splits virtual performers; items can't distinguish vsinger
    // from vtuber without role, so both reduce to virtual vs real.
    if (vtuberOnly === "vsinger" || vtuberOnly === "vtuber") {
      if (item.channelKind !== "virtual") return false;
    }
    if (text) {
      const haystack = `${item.title} ${item.songTitle ?? ""} ${
        item.originalArtist ?? ""
      } ${item.channelName}`.toLowerCase();
      if (!haystack.includes(text)) return false;
    }
    return true;
  });

  const filteredSorted = filtered.sort((a, b) => {
    const at = Date.parse(a.scheduledStart ?? a.publishedAt ?? "") || 0;
    const bt = Date.parse(b.scheduledStart ?? b.publishedAt ?? "") || 0;
    return bt - at;
  });
  return query.limit === undefined ? filteredSorted : filteredSorted.slice(0, query.limit);
}

/**
 * Filters channel summaries.
 *
 * The predicate itself lives in `filter-index.ts`, beside the per-record
 * facets it reads: the text haystack, the platform keys, the languages and
 * the tags are computed once per record instead of once per keystroke, which
 * is the difference between ~17 ms and ~1 ms on a 72,698-channel catalogue.
 * The scope switch is enforced there and only there.
 *
 * `query.limit` is deliberately **not** applied here. Sorting happens after
 * filtering (`sortChannels()` in the view), so a limit taken at this point
 * would keep the first 240 records in shard order rather than the first 240
 * of the user's chosen order — the wrong page. The view sorts first and then
 * mounts a page; see `visibleChannels` in `App.vue`.
 */
export function filterChannels(channels: ChannelSummary[], query: ItemQuery): ChannelSummary[] {
  return filterChannelList(channels, query);
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
export function sortItems(items: Item[], order: string): Item[] {
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
      return sorted.sort((a, b) => (b.concurrentViewers ?? 0) - (a.concurrentViewers ?? 0));
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
export function sortChannels(channels: ChannelSummary[], order: string): ChannelSummary[] {
  const sorted = [...channels];
  switch (order) {
    case "name":
      return sorted.sort((a, b) => a.name.localeCompare(b.name));
    case "recent":
      return sorted.sort((a, b) => (b.addedAt ?? "").localeCompare(a.addedAt ?? ""));
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
