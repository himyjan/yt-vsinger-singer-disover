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
  channelsIndex: path.join(DATA_DIR, "channels", "index.json"),
  channelsVirtual: (r: string) =>
    path.join(DATA_DIR, "channels", "virtual", `${r}.json`),
  channelsReal: (r: string) => path.join(DATA_DIR, "channels", "real", `${r}.json`),
  channelRegion: (r: string) =>
    path.join(DATA_DIR, "channels", "regions", `${r}.json`),
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
    handle: c.handle,
    kind: c.kind,
    role: c.role,
    region: c.region,
    agency: c.agency,
    avatar: c.avatar,
    subscribers: countValue(c.subscribers),
    isSinging: c.isSinging,
    activity: c.activity,
    subscribersHidden: countHidden(c.subscribers),
    twitchLogin: c.twitchLogin,
    gender: c.gender,
    isAi: c.isAi,
    variant: c.variant,
    links: c.platforms.map((p) => ({
      p: p.platform,
      u: p.url,
      h: p.handle,
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
  writeJson(layout.channelsIndex, {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: now,
    channels: summaries,
  } satisfies {
    schemaVersion: number;
    generatedAt: string;
    channels: ChannelSummary[];
  });

  /**
   * The full channel records are sharded by **kind and region**.
   *
   * A single `virtual.json` holding every VTuber in the catalogue overflows
   * the per-file budget as soon as the roster grows past a few thousand
   * channels, so the datasets are split the same way the items are.
   */
  const channelDirs: { dir: string; keep: Set<string> }[] = [
    { dir: path.join(DATA_DIR, "channels", "virtual"), keep: new Set() },
    { dir: path.join(DATA_DIR, "channels", "real"), keep: new Set() },
  ];
  for (const { dir } of channelDirs) ensureDir(dir);

  for (const [kind, dir] of [
    ["virtual", channelDirs[0]!.dir],
    ["real", channelDirs[1]!.dir],
  ] as const) {
    const list = channels.filter((c) => c.kind === kind);
    const byRegion = new Map<RegionCode, Channel[]>();
    for (const channel of list) {
      const region = channel.region ?? "unknown";
      const bucket = byRegion.get(region) ?? [];
      bucket.push(channel);
      byRegion.set(region, bucket);
    }

    const target = channelDirs.find((d) => d.dir === dir)!;
    for (const region of ALL_REGIONS) {
      const bucket = byRegion.get(region);
      if (!bucket?.length) continue;
      const file = `${region}.json`;
      target.keep.add(file);
      writeJson(
        kind === "virtual"
          ? layout.channelsVirtual(region)
          : layout.channelsReal(region),
        {
          schemaVersion: SCHEMA_VERSION,
          generatedAt: now,
          channels: bucket,
        } satisfies ChannelFile,
      );
    }
    removed.push(...pruneStale(dir, target.keep));
  }

  const regionSummaryDir = path.join(DATA_DIR, "channels", "regions");
  ensureDir(regionSummaryDir);
  const keepRegionFiles = new Set<string>();
  for (const region of ALL_REGIONS) {
    const list = summaries.filter((s) => s.region === region);
    if (!list.length) continue;
    const file = `${region}.json`;
    keepRegionFiles.add(file);
    writeJson(layout.channelRegion(region), {
      schemaVersion: SCHEMA_VERSION,
      generatedAt: now,
      channels: list,
    });
  }
  removed.push(...pruneStale(regionSummaryDir, keepRegionFiles));

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
    isAi: i.isAi,
    title: i.title,
    songTitle: i.songTitle,
    originalArtist: i.originalArtist,
    category: i.category,
    isCollab: i.isCollab,
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
    const dir = path.join(DATA_DIR, "channels", kind);
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith(".json")) continue;
      const parsed = readJson<{ channels?: Channel[] }>(
        path.join(dir, file),
        {},
      );
      out.push(...(parsed.channels ?? []));
    }
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
