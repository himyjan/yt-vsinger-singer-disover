#!/usr/bin/env tsx
/**
 * Merges the per-volume song shards back into `data/songs/`.
 *
 * Each import job wrote its volume's songs into
 * `.volumes/vol-N/data/songs/{region}/{bucket}.json` (sharded by song id).
 * Volumes are disjoint by channel id — hence by song id — so the merge is a
 * union keyed by song id and no two volumes hold the same song.
 *
 * Writes the canonical sharded layout:
 *   data/songs/{region}.json, {region}.1.json, …   songs per region, size-chunked
 *   data/songs/categories/{category}.json   cover / mv / original / performance
 *   data/songs/index.json             every song, in id order
 *   data/songs/manifest.json          totals and the region table
 *
 *   npx oxnode scripts/merge-songs.ts --count 20
 */

import fs from "node:fs";
import path from "node:path";

import {
  ensureDir,
  readJson,
  writeJsonIfChanged,
} from "./lib/io";
import { ALL_REGIONS, SCHEMA_VERSION } from "./lib/types";
import { writeSongShards } from "./lib/dataset";
import type { ItemCategory, RegionCode, SongFile, SongRecord } from "./lib/types";

const VOLUMES_ROOT = path.join(process.cwd(), ".volumes");
const SONGS_ROOT = path.join(process.cwd(), "data", "songs");

const SONG_CATEGORIES: ItemCategory[] = [
  "cover",
  "mv",
  "original",
  "performance",
];

interface Shard {
  schemaVersion?: number;
  generatedAt?: string;
  songs?: SongRecord[];
}

function parseCount(argv: string[]): number {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg.startsWith("--count=")) {
      const n = Number(arg.slice("--count=".length));
      if (Number.isFinite(n) && n > 0) return Math.floor(n);
    }
    if (arg === "--count") {
      const n = Number(argv[i + 1]);
      if (Number.isFinite(n) && n > 0) return Math.floor(n);
    }
  }
  return 10;
}

/** Reads every song shard one volume wrote. */
function readVolumeSongs(volDir: string): SongRecord[] {
  const out: SongRecord[] = [];
  const songsRoot = path.join(volDir, "songs");
  if (!fs.existsSync(songsRoot)) return out;
  for (const region of fs.readdirSync(songsRoot)) {
    const dir = path.join(songsRoot, region);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith(".json")) continue;
      const parsed = readJson<Shard>(path.join(dir, file), {});
      out.push(...(parsed.songs ?? []));
    }
  }
  return out;
}

function main(): void {
  const count = parseCount(process.argv.slice(2));

  const volDirs: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const dir = path.join(VOLUMES_ROOT, `vol-${i}`, "data");
    if (fs.existsSync(dir)) volDirs.push(dir);
  }
  if (!volDirs.length) {
    console.error(`No volumes found under ${VOLUMES_ROOT}`);
    process.exit(1);
  }

  /* --- union every volume's songs by id -------------------------------- */
  const songsById = new Map<string, SongRecord>();
  let raw = 0;
  for (const dir of volDirs) {
    const volumeSongs = readVolumeSongs(dir);
    raw += volumeSongs.length;
    for (const song of volumeSongs) {
      const prev = songsById.get(song.id);
      if (prev) {
        console.error(
          `merge-songs: duplicate song id ${song.id} across volumes — keeping the first`,
        );
        continue;
      }
      songsById.set(song.id, song);
    }
  }
  if (raw !== songsById.size) {
    console.log(
      `merge-songs: deduplicated ${raw - songsById.size} song(s) across volumes`,
    );
  }

  const allSongs = [...songsById.values()].sort((a, b) =>
    a.id.localeCompare(b.id),
  );

  ensureDir(SONGS_ROOT);

  /* --- region files: data/songs/{region}.json, {region}.1.json, … ------- */
  const byRegion = new Map<RegionCode, SongRecord[]>();
  for (const song of allSongs) {
    const region = song.region ?? "unknown";
    const list = byRegion.get(region) ?? [];
    list.push(song);
    byRegion.set(region, list);
  }

  const keepRegionFiles = new Set<string>();
  const now = new Date().toISOString();
  for (const region of ALL_REGIONS) {
    const list = byRegion.get(region);
    if (!list?.length) continue;
    const shards = writeSongShards(SONGS_ROOT, region, list, now);
    for (const shard of shards) keepRegionFiles.add(shard);
  }

  /* --- category slices -------------------------------------------------- */
  const songsCategoryDir = path.join(SONGS_ROOT, "categories");
  ensureDir(songsCategoryDir);
  const keepCategoryFiles = new Set<string>();
  const categoryCounts: Record<ItemCategory, number> = {} as Record<
    ItemCategory,
    number
  >;
  for (const category of SONG_CATEGORIES) {
    const list = allSongs.filter((s) => s.category === category);
    categoryCounts[category] = list.length;
    if (!list.length) continue;
    const shards = writeSongShards(songsCategoryDir, category, list, now);
    for (const shard of shards) keepCategoryFiles.add(shard);
  }

  /* --- index: every song in id order ----------------------------------- */
  const indexShards = writeSongShards(SONGS_ROOT, "index", allSongs, now);
  for (const shard of indexShards) keepRegionFiles.add(shard);

  /* --- manifest -------------------------------------------------------- */
  const byRegionCounts: Record<RegionCode, number> = {} as Record<
    RegionCode,
    number
  >;
  for (const code of ALL_REGIONS) byRegionCounts[code] = 0;
  for (const song of allSongs) {
    const region = (song.region ?? "unknown") as RegionCode;
    byRegionCounts[region] += 1;
  }
  const byRegionOut: Record<string, number> = {};
  for (const [code, n] of Object.entries(byRegionCounts)) {
    if (n > 0) byRegionOut[code] = n;
  }
  writeJsonIfChanged(path.join(SONGS_ROOT, "manifest.json"), {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    total: allSongs.length,
    byCategory: categoryCounts,
    byRegion: byRegionOut,
  });

  /* --- prune stale files ------------------------------------------------- */
  const keepFiles = new Set<string>(keepRegionFiles);
  keepFiles.add("index.json");
  keepFiles.add("manifest.json");
  if (fs.existsSync(SONGS_ROOT)) {
    for (const entry of fs.readdirSync(SONGS_ROOT)) {
      if (!entry.endsWith(".json")) continue;
      if (keepFiles.has(entry)) continue;
      fs.rmSync(path.join(SONGS_ROOT, entry), { force: true });
    }
  }
  if (fs.existsSync(songsCategoryDir)) {
    for (const entry of fs.readdirSync(songsCategoryDir)) {
      if (!entry.endsWith(".json")) continue;
      if (keepCategoryFiles.has(entry)) continue;
      fs.rmSync(path.join(songsCategoryDir, entry), { force: true });
    }
  }

  console.log(
    `merge-songs: merged ${allSongs.length} song(s) from ${volDirs.length} volume(s) into data/songs/`,
  );
}

try {
  main();
} catch (error: unknown) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
