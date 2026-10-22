/**
 * Dataset layout and writers.
 *
 * ## Why the dataset is sharded
 *
 * The dataset is committed to git and served from GitHub Pages. GitHub Free
 * allows ~1 GB of repository content (hard limit 2 GB) and Git LFS accepts
 * files up to 2 GB — but a single 1 GB JSON blob is useless to a browser
 * anyway. So the dataset is split into many small files:
 *
 *   data/
 *     manifest.json               counts, quota, region table
 *     channels/
 *       index.json                ChannelSummary[]  (all channels, light)
 *       virtual.json              Channel[]         (virtual dataset)
 *       real.json                 Channel[]         (real human artist dataset)
 *       regions/<region>.json     ChannelSummary[]  (region listing, light)
 *     items/
 *       manifest.json             shard map + counts
 *       <region>/<bucket>.json    Item[]            (sharded by region)
 *       live.json                 Item[]            (currently live)
 *       upcoming.json             Item[]            (scheduled / premiere)
 *     search/
 *       manifest.json             shard map
 *       <region>.json             SearchEntry[]     (sharded by region)
 *
 * Every file is kept well under the per-file budget (see SIZE_BUDGET) and the
 * web app can load exactly the slice it needs — e.g. only the `jp` region, or
 * only the live items — instead of the whole corpus.
 */

import fs from "node:fs";
import path from "node:path";
import {
  DATA_DIR,
  ROOT,
  SIZE_BUDGET,
  directorySize,
  ensureDir,
  formatBytes,
  readJson,
  writeJson,
} from "./io";
import { ALL_REGIONS, SCHEMA_VERSION } from "./types";
import type {
  Channel,
  ChannelFile,
  ChannelSummary,
  Item,
  ItemFile,
  Manifest,
  RegionCode,
  SongFile,
  SongRecord,
} from "./types";
import { countHidden, countValue } from "./types";

/* -------------------------------------------------------------------------- */
/* Sharding                                                                   */
/* -------------------------------------------------------------------------- */

/** Number of shards per region. 16 keeps each shard comfortably small. */
export const SHARD_COUNT = 16;

/* -------------------------------------------------------------------------- */
/* Paths                                                                      */
/* -------------------------------------------------------------------------- */

export const layout = {
  manifest: path.join(DATA_DIR, "manifest.json"),
  channelsManifest: path.join(DATA_DIR, "channels", "manifest.json"),
  channelsIndex: path.join(DATA_DIR, "channels", "index.json"),
  channelsSummary: (r: string, b: string) =>
    path.join(DATA_DIR, "channels", "summaries", r, `${b}.json`),
  channelsVirtual: (r: string, b: string) =>
    path.join(DATA_DIR, "channels", "virtual", r, `${b}.json`),
  channelsReal: (r: string, b: string) =>
    path.join(DATA_DIR, "channels", "real", r, `${b}.json`),
  channelRegion: (r: string, b: string) =>
    path.join(DATA_DIR, "channels", "regions", r, `${b}.json`),
  itemsManifest: path.join(DATA_DIR, "items", "manifest.json"),
  itemsRegion: (r: string, b: string) =>
    path.join(DATA_DIR, "items", r, `${b}.json`),
  itemsLive: path.join(DATA_DIR, "items", "live.json"),
  itemsUpcoming: path.join(DATA_DIR, "items", "upcoming.json"),
  songsManifest: path.join(DATA_DIR, "songs", "manifest.json"),
  songsIndex: path.join(DATA_DIR, "songs", "index.json"),
  songsRegion: (r: string) => path.join(DATA_DIR, "songs", `${r}.json`),
  songsCategory: (c: string) =>
    path.join(DATA_DIR, "songs", "categories", `${c}.json`),
  searchManifest: path.join(DATA_DIR, "search", "manifest.json"),
  searchRegion: (r: string) => path.join(DATA_DIR, "search", `${r}.json`),
  overrides: path.join(DATA_DIR, "overrides.json"),
} as const;

/** FNV-1a hash → bucket index in `[0, SHARD_COUNT)`. */
export function bucketFor(id: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return (hash % SHARD_COUNT).toString(16).padStart(2, "0");
}

/** All shard names, in stable order. */
export const ALL_BUCKETS: string[] = Array.from(
  { length: SHARD_COUNT },
  (_, i) => i.toString(16).padStart(2, "0"),
);

/* -------------------------------------------------------------------------- */
/* Projections                                                                */
/* -------------------------------------------------------------------------- */

export function toSummary(c: Channel): ChannelSummary {
  return {
    id: c.id,
    name: c.name,
    aliases: c.aliases ?? [],
    handle: c.handle,
    kind: c.kind,
    role: c.role,
    region: c.region,
    regionSource: c.regionSource,
    languages: c.languages,
    agency: c.agency,
    affiliation: c.affiliation,
    avatar: c.avatar,
    subscribers: countValue(c.subscribers),
    isSinging: c.isSinging,
    activity: c.activity,
    subscribersHidden: countHidden(c.subscribers),
    twitchLogin:
      c.platforms.find((p) => p.platform === "twitch")?.handle ?? null,
    gender: c.gender,
    isAi: c.isAi,
    variant: c.variant,
    verification: c.verification,
    links: c.platforms.map((p) => ({
      p: p.platform,
      u: p.url,
      h: p.handle,
    })),
    addedAt: c.addedAt,
    followers: c.platforms.map((p) => ({
      p: p.platform,
      n: p.subscribers.tag === "has" ? p.subscribers.count : null,
      hidden: p.subscribers.tag === "hidden",
      v: p.videoCount ?? null,
    })),
  };
}

/* -------------------------------------------------------------------------- */
/* Writers                                                                    */
/* -------------------------------------------------------------------------- */

/** Removes stale shard files so a shrinking dataset does not leave orphans. */
function pruneStale(dir: string, keep: Set<string>): string[] {
  const removed: string[] = [];
  if (!fs.existsSync(dir)) return removed;
  for (const entry of fs.readdirSync(dir)) {
    if (!entry.endsWith(".json")) continue;
    if (keep.has(entry)) continue;
    fs.rmSync(path.join(dir, entry), { force: true });
    removed.push(entry);
  }
  return removed;
}

export interface ChannelRegionMeta {
  code: RegionCode;
  channels: number;
  /** The shard files that hold this region's records. */
  buckets: string[];
}

export interface ChannelsManifest {
  schemaVersion: number;
  generatedAt: string;
  total: number;
  regions: ChannelRegionMeta[];
}

export interface ItemsManifest {
  schemaVersion: number;
  generatedAt: string;
  regions: {
    code: RegionCode;
    label: string;
    badge: string;
    buckets: string[];
    items: number;
  }[];
  counts: {
    total: number;
    live: number;
    upcoming: number;
  };
}

export interface SearchManifest {
  schemaVersion: number;
  generatedAt: string;
  regions: { code: RegionCode; entries: number }[];
  total: number;
}

export interface WriteResult {
  files: number;
  bytes: number;
  removed: string[];
}

/** Writes the whole dataset. */
export function writeDataset(
  channels: Channel[],
  items: Item[],
  manifest: Manifest,
  now: string,
): WriteResult {
  const removed: string[] = [];

  /* --- channels ------------------------------------------------------- */
  const summaries = channels.map(toSummary).sort((a, b) => a.id.localeCompare(b.id));

  /**
   * Every channel dataset is sharded by **region and then by id bucket**.
   *
   * With a roster of more than 14,000 performers a single JSON file goes
   * over the per-file budget, and the browser would have to download the
   * whole catalogue to show one region. Sharding solves both: every file
   * stays small, and the web app loads exactly the region the user is
   * looking at.
   */
  const shardChannels = (
    list: Channel[],
    fileFor: (region: string, bucket: string) => string,
  ): { files: number } => {
    const byRegion = new Map<string, Map<string, Channel[]>>();
    for (const channel of list) {
      const region = channel.region ?? "unknown";
      let byBucket = byRegion.get(region);
      if (!byBucket) {
        byBucket = new Map();
        byRegion.set(region, byBucket);
      }
      const bucket = bucketFor(channel.id);
      const bucketList = byBucket.get(bucket) ?? [];
      bucketList.push(channel);
      byBucket.set(bucket, bucketList);
    }

    let files = 0;
    for (const [region, byBucket] of byRegion) {
      const dir = path.dirname(fileFor(region, "00"));
      ensureDir(dir);
      const keep = new Set<string>();
      for (const [bucket, bucketList] of byBucket) {
        const file = `${bucket}.json`;
        keep.add(file);
        writeJson(fileFor(region, bucket), {
          schemaVersion: SCHEMA_VERSION,
          generatedAt: now,
          channels: bucketList,
        } satisfies ChannelFile);
        files++;
      }
      removed.push(...pruneStale(dir, keep));
    }
    return { files };
  };

  // The summaries, per region and per bucket — what the list views read.
  const summariesDir = path.join(DATA_DIR, "channels", "summaries");
  ensureDir(summariesDir);
  const keepSummaryFiles = new Set<string>();
  const channelRegionMeta: ChannelRegionMeta[] = [];
  for (const region of ALL_REGIONS) {
    const list = summaries.filter((s) => s.region === region);
    if (!list.length) continue;

    const dir = path.join(summariesDir, region);
    ensureDir(dir);
    const byBucket = new Map<string, ChannelSummary[]>();
    const regionBuckets: string[] = [];
    for (const summary of list) {
      const bucket = bucketFor(summary.id);
      const bucketList = byBucket.get(bucket) ?? [];
      bucketList.push(summary);
      byBucket.set(bucket, bucketList);
    }

    const keep = new Set<string>();
    for (const [bucket, bucketList] of byBucket) {
      const file = `${bucket}.json`;
      keep.add(file);
      regionBuckets.push(bucket);
      writeJson(layout.channelsSummary(region, bucket), {
        schemaVersion: SCHEMA_VERSION,
        generatedAt: now,
        channels: bucketList,
      } satisfies {
        schemaVersion: number;
        generatedAt: string;
        channels: ChannelSummary[];
      });
    }
    removed.push(...pruneStale(dir, keep));
    channelRegionMeta.push({
      code: region,
      channels: list.length,
      buckets: regionBuckets.sort(),
    });
  }

  // These roots now hold only sub-directories; any stray JSON file left
  // behind by an earlier layout is an orphan and must go.
  for (const root of [
    path.join(DATA_DIR, "channels", "virtual"),
    path.join(DATA_DIR, "channels", "real"),
    path.join(DATA_DIR, "channels", "summaries"),
    path.join(DATA_DIR, "channels", "regions"),
  ]) {
    if (!fs.existsSync(root)) continue;
    for (const entry of fs.readdirSync(root)) {
      if (!entry.endsWith(".json")) continue;
      fs.rmSync(path.join(root, entry), { force: true });
      removed.push(entry);
    }
  }

  // Remove the summary directories of regions that no longer have channels.
  for (const entry of fs.readdirSync(summariesDir)) {
    const dir = path.join(summariesDir, entry);
    if (!fs.statSync(dir).isDirectory()) continue;
    if (channelRegionMeta.some((r) => r.code === entry)) continue;
    fs.rmSync(dir, { recursive: true, force: true });
    removed.push(`summaries/${entry}/`);
  }

  // The full records, per region and per kind.
  shardChannels(channels, (region, bucket) => layout.channelRegion(region, bucket));
  shardChannels(
    channels.filter((c) => c.kind === "virtual"),
    (region, bucket) => layout.channelsVirtual(region, bucket),
  );
  shardChannels(
    channels.filter((c) => c.kind === "real"),
    (region, bucket) => layout.channelsReal(region, bucket),
  );

  // The previous flat layout is no longer used; remove it so the dataset
  // does not carry two copies of the same records.
  for (const legacy of [
    path.join(DATA_DIR, "channels", "index.json"),
    path.join(DATA_DIR, "channels", "virtual.json"),
    path.join(DATA_DIR, "channels", "real.json"),
  ]) {
    if (fs.existsSync(legacy)) {
      fs.rmSync(legacy, { force: true });
      removed.push(path.basename(legacy));
    }
  }
  const legacyRegionDir = path.join(DATA_DIR, "channels", "regions");
  if (fs.existsSync(legacyRegionDir)) {
    for (const entry of fs.readdirSync(legacyRegionDir)) {
      if (!entry.endsWith(".json")) continue;
      fs.rmSync(path.join(legacyRegionDir, entry), { force: true });
      removed.push(`regions/${entry}`);
    }
  }

  writeJson(layout.channelsManifest, {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: now,
    total: channels.length,
    regions: channelRegionMeta,
  } satisfies ChannelsManifest);

  /**
   * The full channel records are sharded by **kind and region**.
   *
   * A single `virtual.json` holding every VTuber in the catalogue overflows
   * the per-file budget as soon as the roster grows past a few thousand
   * channels, so the datasets are split the same way the items are.
   */
  /* --- items, sharded by region then bucket --------------------------- */
  const itemsByRegion = new Map<RegionCode, Map<string, Item[]>>();
  for (const item of items) {
    const region = item.region ?? "unknown";
    let byBucket = itemsByRegion.get(region);
    if (!byBucket) {
      byBucket = new Map();
      itemsByRegion.set(region, byBucket);
    }
    const bucket = bucketFor(item.id);
    const list = byBucket.get(bucket) ?? [];
    list.push(item);
    byBucket.set(bucket, list);
  }

  const itemsRoot = path.join(DATA_DIR, "items");
  const keepItemDirs = new Set<string>();
  const regionMeta: ItemsManifest["regions"] = [];

  for (const region of ALL_REGIONS) {
    const byBucket = itemsByRegion.get(region);
    if (!byBucket || byBucket.size === 0) continue;
    keepItemDirs.add(region);
    const dir = path.join(itemsRoot, region);
    ensureDir(dir);
    const keepFiles = new Set<string>();
    let regionCount = 0;
    const buckets = [...byBucket.keys()].sort();
    for (const bucket of buckets) {
      const list = (byBucket.get(bucket) ?? []).sort((a, b) =>
        b.publishedAt?.localeCompare(a.publishedAt ?? "") ??
        a.id.localeCompare(b.id),
      );
      keepFiles.add(`${bucket}.json`);
      writeJson(layout.itemsRegion(region, bucket), {
        schemaVersion: SCHEMA_VERSION,
        generatedAt: now,
        items: list,
      } satisfies ItemFile);
      regionCount += list.length;
    }
    removed.push(...pruneStale(dir, keepFiles));
    regionMeta.push({
      code: region,
      label: manifest.regions.find((r) => r.code === region)?.label ?? region,
      badge: manifest.regions.find((r) => r.code === region)?.badge ?? "",
      buckets,
      items: regionCount,
    });
  }

  // Remove region directories that no longer hold data.
  if (fs.existsSync(itemsRoot)) {
    for (const entry of fs.readdirSync(itemsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (keepItemDirs.has(entry.name)) continue;
      fs.rmSync(path.join(itemsRoot, entry.name), { recursive: true, force: true });
      removed.push(`${entry.name}/`);
    }
  }

  const live = items.filter((i) => i.status === "live");
  const upcoming = items.filter((i) => i.status === "upcoming");
  writeJson(layout.itemsLive, {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: now,
    items: live,
  } satisfies ItemFile);
  writeJson(layout.itemsUpcoming, {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: now,
    items: upcoming,
  } satisfies ItemFile);

  writeJson(layout.itemsManifest, {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: now,
    regions: regionMeta,
    counts: {
      total: items.length,
      live: live.length,
      upcoming: upcoming.length,
    },
  } satisfies ItemsManifest);

  /* --- songs: the music-centric projection --------------------------- */
  /**
   * The `items` dataset is raw; the `songs` dataset is the musical view —
   * one record per performance, carrying the song, the original artist, and
   * whether it is a collaboration or an acoustic performance.
   */
  const songItems = items.filter((i) =>
    ["cover", "mv", "original", "performance"].includes(i.category),
  );
  const songs: SongRecord[] = songItems.map((i) => ({
    id: i.id,
    channelId: i.channelId,
    channelName: i.channelName,
    channelKind: i.channelKind,
    region: i.region,
    variant: i.variant,
    gender: i.gender,
    languages: i.languages,
    isAi: i.isAi,
    title: i.title,
    songTitle: i.songTitle,
    originalArtist: i.originalArtist,
    category: i.category,
    isCollab: i.isCollab,
    collaborators: i.collaborators,
    isAcoustic: i.isAcoustic,
    publishedAt: i.publishedAt,
    duration: i.duration,
    thumbnail: i.thumbnail,
    viewCount: i.viewCount,
    url:
      i.type === "playlist"
        ? `https://www.youtube.com/playlist?list=${i.id}`
        : `https://www.youtube.com/watch?v=${i.id}`,
  }));

  const songsByRegion = new Map<RegionCode, SongRecord[]>();
  for (const song of songs) {
    const list = songsByRegion.get(song.region) ?? [];
    list.push(song);
    songsByRegion.set(song.region, list);
  }

  const songsDir = path.join(DATA_DIR, "songs");
  ensureDir(songsDir);
  const keepSongFiles = new Set<string>();
  for (const region of ALL_REGIONS) {
    const list = songsByRegion.get(region);
    if (!list?.length) continue;
    keepSongFiles.add(`${region}.json`);
    writeJson(layout.songsRegion(region), {
      schemaVersion: SCHEMA_VERSION,
      generatedAt: now,
      songs: list,
    } satisfies SongFile);
  }
  removed.push(...pruneStale(songsDir, keepSongFiles));

  // Per-category slices make "every cover" a single cheap fetch.
  const songsCategoryDir = path.join(songsDir, "categories");
  ensureDir(songsCategoryDir);
  const keepCategoryFiles = new Set<string>();
  const categoryCounts: Record<string, number> = {};
  for (const category of ["cover", "mv", "original", "performance"]) {
    const list = songs.filter((s) => s.category === category);
    categoryCounts[category] = list.length;
    if (!list.length) continue;
    keepCategoryFiles.add(`${category}.json`);
    writeJson(layout.songsCategory(category), {
      schemaVersion: SCHEMA_VERSION,
      generatedAt: now,
      songs: list,
    } satisfies SongFile);
  }
  removed.push(...pruneStale(songsCategoryDir, keepCategoryFiles));

  writeJson(layout.songsIndex, {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: now,
    songs,
  } satisfies SongFile);
  writeJson(layout.songsManifest, {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: now,
    total: songs.length,
    byCategory: categoryCounts,
    byRegion: Object.fromEntries(
      [...songsByRegion.entries()].map(([code, list]) => [code, list.length]),
    ),
  });

  /* --- manifest ------------------------------------------------------- */
  writeJson(layout.manifest, manifest);

  const bytes = directorySize(DATA_DIR);
  return { files: countFiles(DATA_DIR), bytes, removed };
}

function countFiles(dir: string): number {
  if (!fs.existsSync(dir)) return 0;
  let n = 0;
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(path.join(current, entry.name));
      else if (entry.isFile()) n++;
    }
  };
  walk(dir);
  return n;
}

/* -------------------------------------------------------------------------- */
/* Readers                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Reads every full channel record, from both kind datasets.
 */
export function readAllChannelRecords(): Channel[] {
  const out: Channel[] = [];
  for (const kind of ["virtual", "real"] as const) {
    const root = path.join(DATA_DIR, "channels", kind);
    if (!fs.existsSync(root)) continue;
    for (const region of fs.readdirSync(root)) {
      const dir = path.join(root, region);
      if (!fs.statSync(dir).isDirectory()) continue;
      for (const file of fs.readdirSync(dir)) {
        if (!file.endsWith(".json")) continue;
        const parsed = readJson<{ channels?: Channel[] }>(
          path.join(dir, file),
          {},
        );
        out.push(...(parsed.channels ?? []));
      }
    }
  }
  return out;
}

/** Reads the full channel records for one region. */
export function readChannelRecords(region: RegionCode): Channel[] {
  const out: Channel[] = [];
  const dir = path.join(DATA_DIR, "channels", "regions", region);
  if (!fs.existsSync(dir)) return out;
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;
    const parsed = readJson<{ channels?: Channel[] }>(path.join(dir, file), {});
    out.push(...(parsed.channels ?? []));
  }
  return out;
}

export function readChannelSummaries(): ChannelSummary[] {
  const file = readJson<{ channels?: ChannelSummary[] }>(
    layout.channelsIndex,
    {},
  );
  return file.channels ?? [];
}

export function readItemsManifest(): ItemsManifest {
  return readJson<ItemsManifest>(layout.itemsManifest, {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: "",
    regions: [],
    counts: { total: 0, live: 0, upcoming: 0 },
  });
}

/** Reports the on-disk size of the dataset and whether it fits the budget. */
export function datasetSizeReport(): {
  bytes: number;
  withinBudget: boolean;
  files: number;
} {
  const bytes = directorySize(DATA_DIR);
  return {
    bytes,
    files: countFiles(DATA_DIR),
    withinBudget: bytes <= SIZE_BUDGET.maxDataBytes,
  };
}

/** Human-readable summary used by the CLI. */
export function describeDatasetSize(): string {
  const report = datasetSizeReport();
  return `${report.files} files · ${formatBytes(report.bytes)} / ${formatBytes(
    SIZE_BUDGET.maxDataBytes,
  )} budget${report.withinBudget ? "" : " — OVER BUDGET"}`;
}

export { ROOT, DATA_DIR };
