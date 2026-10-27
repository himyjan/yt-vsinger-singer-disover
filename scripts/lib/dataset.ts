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
 *       manifest.json             counts + the shard map, per kind
 *       virtual/<region>/<b>.json Channel[]         (virtual dataset)
 *       real/<region>/<b>.json    Channel[]         (real human artist dataset)
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
  shardContentChanged,
  writeJson,
  writeJsonIfChanged,
  writeTextShard,
} from "./io";
import { ALL_REGIONS, SCHEMA_VERSION } from "./types";
import { buildRegionMeta, canonicalAgency } from "./regions";
import type {
  Channel,
  ChannelFile,
  Item,
  ItemFile,
  Manifest,
  RegionCode,
  SongFile,
  SongRecord,
} from "./types";

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
  channelsVirtual: (r: string, b: string) =>
    path.join(DATA_DIR, "channels", "virtual", r, `${b}.json`),
  channelsReal: (r: string, b: string) =>
    path.join(DATA_DIR, "channels", "real", r, `${b}.json`),
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

/**
 * The list projection lives in its own module: the browser builds the list
 * from the records it has already downloaded, and it cannot import this file
 * — `node:fs` is not a browser module.
 */
export { toSummary } from "./summary";

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

export interface ChannelKindMeta {
  channels: number;
  /** The shard files that hold this kind's records for the region. */
  buckets: string[];
}

export interface ChannelRegionMeta {
  code: RegionCode;
  channels: number;
  virtual: ChannelKindMeta;
  real: ChannelKindMeta;
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
  options: { scope?: "all" | "live" } = {},
): WriteResult {
  /**
   * `live` writes the media side only.
   *
   * The ten-minute live refresh owns the live and upcoming broadcasts and
   * nothing else, so it must not rewrite channel and song files: their
   * records pick up re-derived fields on the way through the pipeline, and
   * writing them back made every frequent run churn the whole dataset.
   */
  const scope = options.scope ?? "all";
  const removed: string[] = [];
  channels = channels.map(withCanonicalAgency);

  /* --- channels ------------------------------------------------------- */
  /**
   * Every channel dataset is sharded by **region and then by id bucket**.
   *
   * With a roster of more than 14,000 performers a single JSON file goes
   * over the per-file budget, and the browser would have to download the
   * whole catalogue to show one region. Sharding solves both: every file
   * stays small, and the web app loads exactly the region the user is
   * looking at.
   *
   * A channel is written **once**, into the dataset of its kind. There is no
   * third copy and no separate summary projection: the list views are built
   * from the records the app has already fetched, so there is nothing that
   * can drift.
   */
  const shardChannels = (
    list: Channel[],
    root: string,
    fileFor: (region: string, bucket: string) => string,
  ): Map<string, ChannelKindMeta> => {
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

    const meta = new Map<string, ChannelKindMeta>();
    for (const [region, byBucket] of byRegion) {
      const dir = path.dirname(fileFor(region, "00"));
      ensureDir(dir);
      const keep = new Set<string>();
      const buckets: string[] = [];
      let count = 0;
      for (const [bucket, bucketList] of byBucket) {
        const file = `${bucket}.json`;
        keep.add(file);
        buckets.push(bucket);
        count += bucketList.length;
        bucketList.sort((a, b) => a.id.localeCompare(b.id));
        writeShardFile(fileFor(region, bucket), bucketList, now);
      }
      removed.push(...pruneStale(dir, keep));
      meta.set(region, { channels: count, buckets: buckets.sort() });
    }

    // A region that lost its last channel must not keep its directory.
    if (fs.existsSync(root)) {
      for (const entry of fs.readdirSync(root)) {
        const dir = path.join(root, entry);
        if (!fs.statSync(dir).isDirectory()) continue;
        if (byRegion.has(entry)) continue;
        fs.rmSync(dir, { recursive: true, force: true });
        removed.push(`${path.basename(root)}/${entry}/`);
      }
    }
    return meta;
  };

  const virtualMeta = scope === "all"
    ? shardChannels(
        channels.filter((c) => c.kind === "virtual"),
        path.join(DATA_DIR, "channels", "virtual"),
        layout.channelsVirtual,
      )
    : new Map<string, ChannelKindMeta>();
  const realMeta = scope === "all"
    ? shardChannels(
        channels.filter((c) => c.kind === "real"),
        path.join(DATA_DIR, "channels", "real"),
        layout.channelsReal,
      )
    : new Map<string, ChannelKindMeta>();

  const channelRegionMeta: ChannelRegionMeta[] = [];
  for (const code of ALL_REGIONS) {
    const virtual = virtualMeta.get(code);
    const real = realMeta.get(code);
    if (!virtual && !real) continue;
    channelRegionMeta.push({
      code,
      channels: (virtual?.channels ?? 0) + (real?.channels ?? 0),
      virtual: virtual ?? { channels: 0, buckets: [] },
      real: real ?? { channels: 0, buckets: [] },
    });
  }

  // These roots now hold only sub-directories; any stray JSON file left
  // behind by an earlier layout is an orphan and must go.
  for (const root of [
    path.join(DATA_DIR, "channels", "virtual"),
    path.join(DATA_DIR, "channels", "real"),
  ]) {
    if (!fs.existsSync(root)) continue;
    for (const entry of fs.readdirSync(root)) {
      if (!entry.endsWith(".json")) continue;
      fs.rmSync(path.join(root, entry), { force: true });
      removed.push(entry);
    }
  }

  // The previous layout is no longer used; remove it so the dataset does not
  // carry two copies of the same records.
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
  for (const legacyDir of [
    path.join(DATA_DIR, "channels", "regions"),
    path.join(DATA_DIR, "channels", "summaries"),
  ]) {
    if (!fs.existsSync(legacyDir)) continue;
    fs.rmSync(legacyDir, { recursive: true, force: true });
    removed.push(`${path.basename(legacyDir)}/`);
  }

  if (scope === "all") writeJsonIfChanged(layout.channelsManifest, {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: now,
    total: channels.length,
    regions: channelRegionMeta,
  } satisfies ChannelsManifest);

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
      writeJsonIfChanged(layout.itemsRegion(region, bucket), {
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
  writeJsonIfChanged(layout.itemsLive, {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: now,
    items: live,
  } satisfies ItemFile);
  writeJsonIfChanged(layout.itemsUpcoming, {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: now,
    items: upcoming,
  } satisfies ItemFile);

  writeJsonIfChanged(layout.itemsManifest, {
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
      i.url ??
      (i.type === "playlist"
        ? `https://www.youtube.com/playlist?list=${i.id}`
        : `https://www.youtube.com/watch?v=${i.id}`),
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
    if (scope === "all") writeJsonIfChanged(layout.songsRegion(region), {
      schemaVersion: SCHEMA_VERSION,
      generatedAt: now,
      songs: list,
    } satisfies SongFile);
  }
  // The prune only edits the directory it is given, and it treats every file it
  // was not told to keep as stale — including the index and the manifest that
  // sit in this same directory. A full run rewrites them straight away; a
  // live-only run does not, so pruning is the full run's to do.
  if (scope === "all") removed.push(...pruneStale(songsDir, keepSongFiles));

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
    if (scope === "all") writeJsonIfChanged(layout.songsCategory(category), {
      schemaVersion: SCHEMA_VERSION,
      generatedAt: now,
      songs: list,
    } satisfies SongFile);
  }
  if (scope === "all") {
    removed.push(...pruneStale(songsCategoryDir, keepCategoryFiles));
  }

  if (scope === "all") writeJsonIfChanged(layout.songsIndex, {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: now,
    songs,
  } satisfies SongFile);
  if (scope === "all") writeJsonIfChanged(layout.songsManifest, {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: now,
    total: songs.length,
    byCategory: categoryCounts,
    byRegion: Object.fromEntries(
      [...songsByRegion.entries()].map(([code, list]) => [code, list.length]),
    ),
  });

  /* --- manifest ------------------------------------------------------- */
  writeJsonIfChanged(layout.manifest, manifest);

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
/* Shard writers                                                              */
/* -------------------------------------------------------------------------- */

/** A shard file, one channel per line. */
interface ShardFile {
  schemaVersion: number;
  generatedAt: string;
  channels: Channel[];
}

/**
 * The fields a record must have to be worth writing.
 *
 * `null`, `false`, `0`, `""` and `[]` are the defaults the reader supplies,
 * so writing them only makes the file longer and the diff noisier.
 */
const CHANNEL_DEFAULTS: Partial<Record<keyof Channel, unknown>> = {
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
  isAi: false,
  isSinging: false,
  videoCount: null,
  viewCount: null,
};

/**
 * Drops the fields that equal their default.
 *
 * A channel has forty fields; a Bilibili-only record uses twenty. Writing the
 * twenty nulls is what made a one-record removal show up as a diff across
 * every shard in the region — thousands of lines of `"banner": null` for one
 * record that changed.
 */
function compactChannel(channel: Channel): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(channel)) {
    if (key in CHANNEL_DEFAULTS && CHANNEL_DEFAULTS[key as keyof Channel] === value) {
      continue;
    }
    if (Array.isArray(value) && value.length === 0) continue;
    out[key] = value;
  }
  return out;
}

/**
 * Writes a shard: JSON for tools and the browser, one channel per line.
 *
 * `writeJson()` serialises the whole value, which is right for a manifest and
 * wrong for a shard: a three-hundred-channel file becomes one diff block.
 * The budget check is kept — a shard that grows past the per-file limit has
 * to fail here, not in CI.
 */
function writeShardFile(file: string, channels: Channel[], now: string): void {
  /**
   * Compare the **compact** rows, because that is what the file holds.
   *
   * The shard is read back with the defaults restored, so comparing the
   * expanded records with the file always differed and every writer rewrote
   * every shard — the `generatedAt` churn this file is supposed to avoid.
   */
  if (!shardContentChanged(file, channels.map(compactChannel))) return;
  writeTextShard(file, compactChannelFile(channels, now));
}

/** Puts the defaults back, so a compacted record is a complete one. */
function expandChannel(raw: Partial<Channel> & { id: string }): Channel {
  const channel = { ...raw } as Channel;
  for (const [key, value] of Object.entries(CHANNEL_DEFAULTS)) {
    if (channel[key as keyof Channel] === undefined) {
      (channel as unknown as Record<string, unknown>)[key] = value;
    }
  }
  channel.aliases ??= [];
  channel.tags ??= [];
  channel.statedLanguages ??= [];
  channel.platforms ??= [];
  channel.externals ??= {};
  channel.agency = canonicalAgency(channel.agency);
  return channel;
}

/**
 * A record with its agency in the dataset's canonical spelling.
 *
 * `canonicalAgency()` is applied on read and on write: a producer that has
 * not been taught the new name yet still writes it, and a record written
 * before the rule is corrected the next time it passes through here.
 */
function withCanonicalAgency(channel: Channel): Channel {
  const agency = canonicalAgency(channel.agency);
  return agency === channel.agency ? channel : { ...channel, agency };
}

/**
 * One channel **per line**.
 *
 * A shard of three hundred channels written as one `JSON.stringify` is a
 * multi-thousand-line file where every object is diffed as a block: touching
 * one record rewrites the file and git shows the whole thing. With a record
 * per line, adding or removing a channel is a handful of `+`/`-` lines and
 * every other record stays untouched — which is the difference between a
 * reviewable dataset and an unreadable one.
 */
function compactChannelFile(channels: Channel[], now: string): string {
  const head = `  "schemaVersion": ${SCHEMA_VERSION},\n  "generatedAt": ${JSON.stringify(now)},\n  "channels": [`;
  const body = channels
    .map((channel) => `    ${JSON.stringify(compactChannel(channel))}`)
    .join(",\n");
  return `{\n${head}\n${body}\n  ]\n}\n`;
}

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
        const parsed = readJson<{ channels?: Partial<Channel>[] }>(
          path.join(dir, file),
          {},
        );
        // A shard written before the compact format carries every field;
        // `expandChannel()` fills the ones a compact shard leaves out.
        for (const raw of parsed.channels ?? []) {
          if (raw?.id) out.push(expandChannel(raw as Partial<Channel> & { id: string }));
        }
      }
    }
  }
  return out;
}

/** Reads the region shards; root live/upcoming files are projections. */
export function readAllItems(): Item[] {
  const out: Item[] = [];
  const root = path.join(DATA_DIR, "items");
  if (!fs.existsSync(root)) return out;
  for (const region of fs.readdirSync(root)) {
    const dir = path.join(root, region);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith(".json")) continue;
      const parsed = readJson<{ items?: Item[] }>(
        path.join(dir, file),
        {},
      );
      out.push(...(parsed.items ?? []));
    }
  }
  return out;
}

/**
 * Writes the full channel records, each into the dataset of its kind.
 *
 * There are two stores and no more: `virtual/` and `real/`. A channel is
 * written to exactly one of them, which is also the one the pipeline reads
 * back through `readAllChannelRecords()` — so there is no second copy that a
 * later run could leave stale.
 *
 * The records are grouped by region and sharded by id, so the same id always
 * lands in the same file.
 */
export function writeChannelShards(
  channels: Channel[],
  now: string,
): { records: number; files: number } {
  channels = channels.map(withCanonicalAgency);
  let files = 0;
  const write = (
    list: Channel[],
    root: string,
    fileFor: (r: string, b: string) => string,
  ) => {
    const byRegion = new Map<string, Map<string, Channel[]>>();
    for (const channel of list) {
      const bucket = bucketFor(channel.id);
      const region = byRegion.get(channel.region) ?? new Map();
      byRegion.set(channel.region, region);
      const bucketList = region.get(bucket) ?? [];
      bucketList.push(channel);
      region.set(bucket, bucketList);
    }
    for (const [region, byBucket] of byRegion) {
      const dir = path.dirname(fileFor(region, "00"));
      ensureDir(dir);
      const keep = new Set<string>();
      for (const [bucket, bucketList] of byBucket) {
        keep.add(`${bucket}.json`);
        bucketList.sort((a, b) => a.id.localeCompare(b.id));
        /**
         * An unchanged shard is not rewritten.
         *
         * A details run touches a few hundred channels out of fourteen
         * thousand, and rewriting every shard would change `generatedAt` in
         * every file and bury the real change in the diff.
         */
        const file = fileFor(region, bucket);
        if (!shardContentChanged(file, bucketList.map(compactChannel))) continue;
        writeShardFile(file, bucketList, now);
        files++;
      }
      // A re-keyed or deleted record must not survive in the shard it left.
      pruneStale(dir, keep);
    }

    // The same for a region that lost its last channel.
    if (fs.existsSync(root)) {
      for (const entry of fs.readdirSync(root)) {
        const dir = path.join(root, entry);
        if (!fs.statSync(dir).isDirectory()) continue;
        if (byRegion.has(entry)) continue;
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  };

  write(
    channels.filter((c) => c.kind === "virtual"),
    path.join(DATA_DIR, "channels", "virtual"),
    layout.channelsVirtual,
  );
  write(
    channels.filter((c) => c.kind === "real"),
    path.join(DATA_DIR, "channels", "real"),
    layout.channelsReal,
  );
  return { records: channels.length, files };
}

/**
 * Rebuilds `data/channels/manifest.json` from the records on disk.
 *
 * `writeChannelShards()` writes only the records; the shard **map** is what
 * tells the browser which files exist. A producer that adds a channel without
 * a full sync — the subscription import, for instance — therefore has to
 * rebuild the map, or `validate.ts` fails on a shard the manifest does not
 * name and the app never downloads it.
 *
 * The shape is identical to the one `writeDataset()` writes.
 */
export function rebuildChannelsManifest(
  channels: Channel[],
  now: string,
): ChannelsManifest {
  const byRegion = new Map<
    string,
    { virtual: Map<string, number>; real: Map<string, number> }
  >();

  for (const channel of channels) {
    const region = channel.region ?? "unknown";
    let entry = byRegion.get(region);
    if (!entry) {
      entry = { virtual: new Map(), real: new Map() };
      byRegion.set(region, entry);
    }
    const buckets = channel.kind === "real" ? entry.real : entry.virtual;
    const bucket = bucketFor(channel.id);
    buckets.set(bucket, (buckets.get(bucket) ?? 0) + 1);
  }

  const regions: ChannelRegionMeta[] = [];
  for (const code of ALL_REGIONS) {
    const entry = byRegion.get(code);
    if (!entry) continue;
    const virtualBuckets = [...entry.virtual.keys()].sort();
    const realBuckets = [...entry.real.keys()].sort();
    regions.push({
      code,
      channels:
        [...entry.virtual.values()].reduce((a, b) => a + b, 0) +
        [...entry.real.values()].reduce((a, b) => a + b, 0),
      virtual: {
        channels: [...entry.virtual.values()].reduce((a, b) => a + b, 0),
        buckets: virtualBuckets,
      },
      real: {
        channels: [...entry.real.values()].reduce((a, b) => a + b, 0),
        buckets: realBuckets,
      },
    });
  }

  const manifest: ChannelsManifest = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: now,
    total: channels.length,
    regions,
  };
  writeJson(layout.channelsManifest, manifest);
  return manifest;
}

/**
 * Refreshes the channel counts in the root manifest after an incremental
 * write. The item counts and the notes are left exactly as the last sync
 * wrote them — this function did not touch any items.
 */
export function refreshManifestChannelCounts(
  channels: Channel[],
  now: string,
): void {
  const manifest = readJson<Manifest | null>(layout.manifest, null);
  if (!manifest) return;

  const counts = new Map<RegionCode, { channels: number; items: number }>();
  for (const region of manifest.regions) {
    counts.set(region.code, { channels: 0, items: region.items ?? 0 });
  }
  for (const channel of channels) {
    const entry = counts.get(channel.region) ?? { channels: 0, items: 0 };
    entry.channels++;
    counts.set(channel.region, entry);
  }

  manifest.generatedAt = now;
  manifest.counts.channels = channels.length;
  manifest.counts.channelsVirtual = channels.filter(
    (c) => c.kind === "virtual",
  ).length;
  manifest.counts.channelsReal = channels.filter((c) => c.kind === "real").length;
  manifest.counts.channelsSinging = channels.filter((c) => c.isSinging).length;
  manifest.regions = buildRegionMeta(counts);
  writeJsonIfChanged(layout.manifest, manifest);
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
