#!/usr/bin/env tsx
/**
 * Imports harvested InnerTube music data into item shards.
 *
 * Reads every shard snapshot from .cache/innertube-music/, converts each
 * upload and YouTube Music release into an Item record (through classifyItem
 * for song/cover/original detection), and writes them into volume shards
 * under .volumes/vol-N/data/items/.
 *
 *   npm run data:innertube-music-import              # report only
 *   npm run data:innertube-music-import -- --apply   # write item shards
 *   npm run data:innertube-music-import -- --shard 1/20 --apply  # one shard
 */

import fs from "node:fs";
import path from "node:path";
import { classifyItem, type ItemSignals } from "../scripts/lib/classify";
import { readAllChannelRecords, readAllItems, writeItemShards } from "../scripts/lib/dataset";
import {
  SCHEMA_VERSION,
  type Item,
  type RegionCode,
  type ItemCategory,
  type ArtistKind,
  type Gender,
  type Variant,
} from "../scripts/lib/types";
import { inShard, parseShard } from "../scripts/lib/shard";
import { ensureDir, writeJsonIfChanged } from "../scripts/lib/io";

const CACHE_DIR = ".cache/innertube-music";

interface MusicEntry {
  channelId: string;
  channelName: string;
  channelKind: ArtistKind;
  channelRegion: string | null;
  channelGender: Gender;
  channelVariant: Variant;
  channelLanguages: string | string[];
  channelIsAi: boolean;
  officialArtist: boolean;
  uploads: Array<{ id: string; title: string; thumbnail: string | null }>;
  releases: Array<{ id: string; title: string; thumbnail: string | null }>;
}

interface Options {
  apply: boolean;
  limit: number | null;
  shard: string | null;
}

function parseArgs(argv: string[]): Options {
  const options: Options = { apply: false, limit: null, shard: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const value = argv[i + 1];
    switch (arg) {
      case "--apply":
        options.apply = true;
        break;
      case "--limit":
        options.limit = Math.max(1, Number(value ?? 1));
        i++;
        break;
      case "--shard":
        options.shard = value ?? null;
        i++;
        break;
      case "--help":
      case "-h":
        console.log(
          [
            "Usage: npm run data:innertube-music-import [--apply] [--shard N/M] [--limit <n>]",
            "",
            "  (no flags)   report what would be imported, write nothing",
            "  --apply      write item shards into .volumes/vol-N/data/items/",
            "  --shard N/M  only import this shard (1-based), e.g. --shard 1/20",
            "  --limit <n>  import at most n channels",
          ].join("\n")
        );
        process.exit(0);
      default:
        if (arg.startsWith("-")) {
          console.error(`unknown option: ${arg}`);
          process.exit(1);
        }
    }
  }
  return options;
}

function snapshotFiles(): string[] {
  try {
    return fs
      .readdirSync(CACHE_DIR, { recursive: true, encoding: "utf8" })
      .filter(
        (f) => f.startsWith("innertube-music-") && f.endsWith(".json"),
      )
      .sort();
  } catch {
    return [];
  }
}

function readEntries(): MusicEntry[] {
  const entries: MusicEntry[] = [];
  const seen = new Set<string>();
  for (const file of snapshotFiles()) {
    try {
      const snapshot = JSON.parse(
        fs.readFileSync(path.join(CACHE_DIR, file), "utf8"),
      ) as { data?: MusicEntry[]; generatedAt?: string };
      for (const entry of snapshot.data || []) {
        if (!seen.has(entry.channelId)) {
          seen.add(entry.channelId);
          entries.push(entry);
        }
      }
    } catch (err) {
      console.error(
        `Failed to read ${file}: ${(err as Error).message}`,
      );
    }
  }
  return entries;
}

function uploadToItem(
  upload: { id: string; title: string; thumbnail: string | null },
  channel: MusicEntry,
  now: string,
): Item | null {
  if (!upload.id) return null;

  const classification = classifyItem({
    title: upload.title,
    description: null,
    tags: [],
    channelKind: channel.channelKind,
    status: "past",
    isShort: false,
    durationSeconds: null,
    channelRegion: (channel.channelRegion ?? "unknown") as unknown as RegionCode,
  });

  return {
    id: upload.id,
    platform: "youtube",
    type: "video",
    channelId: channel.channelId,
    channelName: channel.channelName,
    channelKind: channel.channelKind,
    region: (channel.channelRegion ?? "unknown") as unknown as RegionCode,
    gender: channel.channelGender,
    languages: channel.channelLanguages,
    isAi: channel.channelIsAi,
    variant: channel.channelVariant,
    title: upload.title || "Untitled",
    description: null,
    thumbnail: upload.thumbnail,
    publishedAt: null,
    scheduledStart: null,
    actualStart: null,
    actualEnd: null,
    duration: null,
    status: "past",
    category: classification.category as ItemCategory,
    songTitle: classification.songTitle ?? null,
    originalArtist: classification.originalArtist ?? null,
    isCollab: classification.isCollab,
    collaborators: [
      {
        channelId: channel.channelId,
        name: channel.channelName,
        kind: channel.channelKind,
        region: (channel.channelRegion ?? "unknown") as unknown as RegionCode,
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

function releaseToItem(
  release: { id: string; title: string; thumbnail: string | null },
  channel: MusicEntry,
  now: string,
): Item {
  return {
    id: release.id,
    platform: "youtube",
    url: `https://www.youtube.com/playlist?list=${encodeURIComponent(
      release.id,
    )}`,
    type: "playlist",
    channelId: channel.channelId,
    channelName: channel.channelName,
    channelKind: channel.channelKind,
    region: (channel.channelRegion ?? "unknown") as unknown as RegionCode,
    gender: channel.channelGender,
    languages: channel.channelLanguages,
    isAi: channel.channelIsAi,
    variant: channel.channelVariant,
    title: release.title,
    description: null,
    thumbnail: release.thumbnail,
    publishedAt: null,
    scheduledStart: null,
    actualStart: null,
    actualEnd: null,
    duration: null,
    status: "past",
    category: "other" as ItemCategory,
    songTitle: null,
    originalArtist: null,
    isCollab: false,
    collaborators: [
      {
        channelId: channel.channelId,
        name: channel.channelName,
        kind: channel.channelKind,
        region: (channel.channelRegion ?? "unknown") as unknown as RegionCode,
      },
    ],
    isAcoustic: false,
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

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  const entries = readEntries();
  if (entries.length === 0) {
    console.error(
      `no snapshot at ${CACHE_DIR}/innertube-music-*.json — run npm run data:innertube-music first`,
    );
    process.exit(1);
  }

  // Shard filter: only entries whose channel id lands in this shard.
  let targets = entries;
  if (options.shard) {
    const shard = parseShard(options.shard);
    targets = entries.filter((e) =>
      inShard(e.channelId, shard.index, shard.count),
    );
    console.log(
      `innertube-music-import: shard ${options.shard} — ${targets.length} of ${entries.length} channel(s)`,
    );
  } else {
    console.log(
      `innertube-music-import: ${entries.length} channel(s) total`,
    );
  }

  if (options.limit) {
    targets = targets.slice(0, options.limit);
  }

  // Count items that would be imported.
  let itemCount = 0;
  for (const e of targets) {
    itemCount += e.uploads.length + e.releases.length;
  }
  console.log(
    `innertube-music-import: ${itemCount} item(s) would be imported`,
  );

  if (!options.apply) {
    console.log("Nothing was written. Re-run with --apply.");
    return;
  }

  const now = new Date().toISOString();
  const items: Item[] = [];

  for (const entry of targets) {
    for (const upload of entry.uploads) {
      const item = uploadToItem(upload, entry, now);
      if (item) items.push(item);
    }
    for (const release of entry.releases) {
      items.push(releaseToItem(release, entry, now));
    }
  }

  // Sort by id for stable output (same as the sync's total order).
  items.sort((a, b) => a.id.localeCompare(b.id));

  if (items.length === 0) {
    console.log("innertube-music-import: no new items to import — nothing written");
    return;
  }

  // Write item shards into .volumes/vol-N/data/ — one file per volume job.
  // writeItemShards takes a root dir and writes items/{region}/{bucket}.json.
  // We pass a per-volume root so each job writes its own slice.
  if (options.shard) {
    const shard = parseShard(options.shard);
    const volIndex = shard.index - 1;
    const volRoot = path.join(
      process.cwd(),
      ".volumes",
      `vol-${volIndex}`,
      "data",
    );

    // Read existing items from this volume so we don't delete items in
    // buckets/regions this shard doesn't touch. Items are sharded by item-id
    // hash, not by channel shard, so two volume jobs can write items into the
    // same region/bucket file. We merge new items with existing ones before
    // writing, preserving everything already in the volume.
    const existingItems = readAllItems(volRoot);
    const merged = new Map<string, Item>();
    for (const item of existingItems) merged.set(item.id, item);
    for (const item of items) merged.set(item.id, item);
    const allItems = [...merged.values()];
    allItems.sort((a, b) => a.id.localeCompare(b.id));

    ensureDir(volRoot);
    writeItemShards(allItems, now, volRoot);
    console.log(
      `innertube-music-import: wrote ${allItems.length} item(s) (${items.length} new) into .volumes/vol-${volIndex}/data/items/`,
    );
  } else {
    // No shard: write into data/ directly.
    const volRoot = path.join(process.cwd(), "data");

    // Read existing items and merge with new ones, same as the sharded path.
    const existingItems = readAllItems(volRoot);
    const merged = new Map<string, Item>();
    for (const item of existingItems) merged.set(item.id, item);
    for (const item of items) merged.set(item.id, item);
    const allItems = [...merged.values()];
    allItems.sort((a, b) => a.id.localeCompare(b.id));

    writeItemShards(allItems, now, volRoot);
    console.log(
      `innertube-music-import: wrote ${allItems.length} item(s) (${items.length} new) into data/items/`,
    );
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
