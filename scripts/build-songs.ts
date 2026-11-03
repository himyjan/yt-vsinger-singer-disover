#!/usr/bin/env tsx
/**
 * Builds the songs projection from existing item shards.
 *
 * Reads all items from data/items/, filters for song categories
 * (cover/mv/original/performance), and writes data/songs/:
 *
 *   data/songs/{region}.json        — songs per region
 *   data/songs/categories/{category}.json  — songs per category
 *   data/songs/index.json           — all songs in id order
 *   data/songs/manifest.json        — counts and region table
 *
 *   npm run data:build-songs
 */

import fs from "node:fs";
import path from "node:path";
import { readAllItems } from "../scripts/lib/dataset";
import { ensureDir, writeJson } from "../scripts/lib/io";
import type { Item, ItemCategory } from "../scripts/lib/types";
import { SCHEMA_VERSION } from "../scripts/lib/types";

const DATA_DIR = path.join(process.cwd(), "data");
const ITEMS_DIR = path.join(DATA_DIR, "items");
const SONGS_DIR = path.join(DATA_DIR, "songs");

const SONG_CATEGORIES = ["cover", "mv", "original", "performance"] as const;

function main(): void {
  const items = readAllItems(ITEMS_DIR);

  const songItems = items.filter((i) =>
    SONG_CATEGORIES.includes(i.category as (typeof SONG_CATEGORIES)[number]),
  );

  const now = new Date().toISOString();

  // Group by region
  const songsByRegion = new Map<string, Item[]>();
  for (const song of songItems) {
    const region = song.region ?? "unknown";
    const list = songsByRegion.get(region) ?? [];
    list.push(song);
    songsByRegion.set(region, list);
  }

  // Write region files
  ensureDir(SONGS_DIR);
  const keepSongFiles = new Set<string>();
  for (const region of [...songsByRegion.keys()].sort()) {
    const list = songsByRegion.get(region)!;
    keepSongFiles.add(`${region}.json`);
    writeJson(path.join(SONGS_DIR, `${region}.json`), {
      schemaVersion: SCHEMA_VERSION,
      generatedAt: now,
      songs: list,
    });
  }

  // Remove stale region files
  for (const entry of fs.readdirSync(SONGS_DIR)) {
    if (!entry.endsWith(".json")) continue;
    if (entry === "index.json" || entry === "manifest.json") continue;
    if (!keepSongFiles.has(entry)) {
      fs.rmSync(path.join(SONGS_DIR, entry));
    }
  }

  // Category slices
  const songsCategoryDir = path.join(SONGS_DIR, "categories");
  ensureDir(songsCategoryDir);
  const keepCategoryFiles = new Set<string>();
  const categoryCounts: Record<string, number> = {};
  for (const category of SONG_CATEGORIES) {
    const list = songItems.filter((s) => s.category === category);
    categoryCounts[category as ItemCategory] = list.length;
    if (!list.length) continue;
    keepCategoryFiles.add(`${category}.json`);
    writeJson(path.join(songsCategoryDir, `${category}.json`), {
      schemaVersion: SCHEMA_VERSION,
      generatedAt: now,
      songs: list,
    });
  }

  // Remove stale category files
  for (const entry of fs.readdirSync(songsCategoryDir)) {
    if (!entry.endsWith(".json")) continue;
    if (!keepCategoryFiles.has(entry)) {
      fs.rmSync(path.join(songsCategoryDir, entry));
    }
  }

  // Index — all songs in id order
  const allSongs = [...songItems].sort((a, b) => a.id.localeCompare(b.id));
  writeJson(path.join(SONGS_DIR, "index.json"), {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: now,
    songs: allSongs,
  });

  // Manifest
  writeJson(path.join(SONGS_DIR, "manifest.json"), {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: now,
    total: allSongs.length,
    byCategory: categoryCounts,
    byRegion: Object.fromEntries(
      [...songsByRegion.entries()].map(([code, list]) => [code, list.length])
    ),
  });

  console.log(
    `build-songs: wrote ${allSongs.length} song(s) across ${songsByRegion.size} region(s)`
  );
}

try {
  main();
} catch (error: unknown) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
