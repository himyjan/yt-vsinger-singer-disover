#!/usr/bin/env tsx
/**
 * Imports harvested USADA music data directly into data/songs/ — never touches
 * data/items/.
 *
 * Reads every shard snapshot from .cache/innertube-music/, converts each
 * upload and YouTube Music release into a SongRecord, and writes them into
 * .volumes/vol-N/data/songs/{region}/{bucket}.json.
 *
 *   npm run data:innertube-music-import              # report only
 *   npm run data:innertube-music-import -- --apply   # write song shards
 *   npm run data:innertube-music-import -- --shard 1/20 --apply  # one shard
 *
 * USADA publishes a YouTube channel id for each entry, so matching against
 * the dataset is direct (no search required).
 */

import fs from "node:fs";
import path from "node:path";
import { classifyItem } from "../scripts/lib/classify";
import { readAllChannelRecords } from "../scripts/lib/dataset";
import type {
  Channel as ChannelType,
  ItemCategory,
  RegionCode,
  SongFile,
  SongRecord,
} from "../scripts/lib/types";
import { inShard, parseShard } from "../scripts/lib/shard";
import { bucketFor } from "../scripts/lib/dataset";
import { SIZE_BUDGET } from "./lib/io";
import { SCHEMA_VERSION, ALL_REGIONS } from "./lib/types";
import { ensureDir, readJson, writeJsonIfChanged } from "./lib/io";

const CACHE_DIR = ".cache/innertube-music";

interface MusicEntry {
  channelId: string;
  channelName: string;
  channelKind: ChannelType["kind"];
  channelRegion: string | null;
  channelGender: ChannelType["gender"];
  channelVariant: ChannelType["variant"];
  channelLanguages: ChannelType["languages"];
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
            "  --apply      write song shards into data/songs/",
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

function uploadToSong(
  upload: { id: string; title: string; thumbnail: string | null },
  channel: MusicEntry,
  now: string,
): SongRecord | null {
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
    channelId: channel.channelId,
    channelName: channel.channelName,
    channelKind: channel.channelKind,
    region: (channel.channelRegion ?? "unknown") as RegionCode,
    gender: channel.channelGender,
    languages: channel.channelLanguages,
    isAi: channel.channelIsAi,
    variant: channel.channelVariant,
    title: upload.title || "Untitled",
    thumbnail: upload.thumbnail,
    publishedAt: null,
    duration: null,
    category: classification.category as ItemCategory,
    songTitle: classification.songTitle ?? null,
    originalArtist: classification.originalArtist ?? null,
    isCollab: classification.isCollab,
    collaborators: [
      {
        channelId: channel.channelId,
        name: channel.channelName,
        kind: channel.channelKind,
        region: (channel.channelRegion ?? "unknown") as RegionCode,
      },
    ],
    isAcoustic: classification.isAcoustic,
    viewCount: null,
    url: `https://www.youtube.com/watch?v=${upload.id}`,
  };
}

function releaseToSong(
  release: { id: string; title: string; thumbnail: string | null },
  channel: MusicEntry,
  now: string,
): SongRecord {
  return {
    id: release.id,
    channelId: channel.channelId,
    channelName: channel.channelName,
    channelKind: channel.channelKind,
    region: (channel.channelRegion ?? "unknown") as RegionCode,
    gender: channel.channelGender,
    languages: channel.channelLanguages,
    isAi: channel.channelIsAi,
    variant: channel.channelVariant,
    title: release.title,
    thumbnail: release.thumbnail,
    publishedAt: null,
    duration: null,
    category: "other" as ItemCategory,
    songTitle: null,
    originalArtist: null,
    isCollab: false,
    collaborators: [
      {
        channelId: channel.channelId,
        name: channel.channelName,
        kind: channel.channelKind,
        region: (channel.channelRegion ?? "unknown") as RegionCode,
      },
    ],
    isAcoustic: false,
    viewCount: null,
    url: `https://www.youtube.com/playlist?list=${release.id}`,
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

  // Count songs that would be imported.
  let songCount = 0;
  for (const e of targets) {
    songCount += e.uploads.length + e.releases.length;
  }
  console.log(
    `innertube-music-import: ${songCount} song(s) would be imported`,
  );

  if (!options.apply) {
    console.log("Nothing was written. Re-run with --apply.");
    return;
  }

  const now = new Date().toISOString();
  const songs: SongRecord[] = [];

  for (const entry of targets) {
    for (const upload of entry.uploads) {
      const song = uploadToSong(upload, entry, now);
      if (song) songs.push(song);
    }
    for (const release of entry.releases) {
      songs.push(releaseToSong(release, entry, now));
    }
  }

  // Sort by id for stable output (same as the sync's total order).
  songs.sort((a, b) => a.id.localeCompare(b.id));

  if (songs.length === 0) {
    console.log("innertube-music-import: no new songs to import — nothing written");
    return;
  }

  // Write song shards into .volumes/vol-N/data/songs/ — one file per volume job.
  // writeSongShards takes a root dir and writes songs/{region}/{bucket}.json.
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

    // Read existing songs from this volume so we don't delete songs in
    // buckets/regions this shard doesn't touch. Songs are sharded by song-id
    // hash, not by channel shard, so two volume jobs can write songs into the
    // same region/bucket file. We merge new songs with existing ones before
    // writing, preserving everything already in the volume.
    const existingSongs = readAllSongs(volRoot);
    const merged = new Map<string, SongRecord>();
    for (const song of existingSongs) merged.set(song.id, song);
    for (const song of songs) merged.set(song.id, song);
    const allSongs = [...merged.values()];
    allSongs.sort((a, b) => a.id.localeCompare(b.id));

    ensureDir(volRoot);
    writeSongShards(allSongs, now, volRoot);
    console.log(
      `innertube-music-import: wrote ${allSongs.length} song(s) (${songs.length} new) into .volumes/vol-${volIndex}/data/songs/`,
    );
  } else {
    // No shard: write into data/ directly.
    const volRoot = path.join(process.cwd(), "data");

    // Read existing songs and merge with new ones, same as the sharded path.
    const existingSongs = readAllSongs(volRoot);
    const merged = new Map<string, SongRecord>();
    for (const song of existingSongs) merged.set(song.id, song);
    for (const song of songs) merged.set(song.id, song);
    const allSongs = [...merged.values()];
    allSongs.sort((a, b) => a.id.localeCompare(b.id));

    writeSongShards(allSongs, now, volRoot);
    console.log(
      `innertube-music-import: wrote ${allSongs.length} song(s) (${songs.length} new) into data/songs/`,
    );
  }
}

function readAllSongs(root: string): SongRecord[] {
  const out: SongRecord[] = [];
  const songsRoot = path.join(root, "songs");
  if (!fs.existsSync(songsRoot)) return out;
  for (const region of fs.readdirSync(songsRoot)) {
    const dir = path.join(songsRoot, region);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith(".json")) continue;
      const parsed = readJson<{ songs?: SongRecord[] }>(
        path.join(dir, file),
        {},
      );
      out.push(...(parsed.songs ?? []));
    }
  }
  return out;
}

function writeSongShards(
  songs: SongRecord[],
  now: string,
  root: string,
): void {
  const songsByRegion = new Map<RegionCode, Map<string, SongRecord[]>>();
  for (const song of songs) {
    const region = song.region ?? "unknown";
    let byBucket = songsByRegion.get(region);
    if (!byBucket) {
      byBucket = new Map();
      songsByRegion.set(region, byBucket);
    }
    const bucket = bucketFor(song.id);
    const list = byBucket.get(bucket) ?? [];
    list.push(song);
    byBucket.set(bucket, list);
  }

  const songsRoot = path.join(root, "songs");
  const keepItemDirs = new Set<string>();

  for (const region of ALL_REGIONS) {
    const byBucket = songsByRegion.get(region);
    if (!byBucket || byBucket.size === 0) continue;
    keepItemDirs.add(region);
    const dir = path.join(songsRoot, region);
    ensureDir(dir);
    const keepFiles = new Set<string>();
    const buckets = [...byBucket.keys()].sort();
    const extraParts: string[] = [];
    for (const bucket of buckets) {
      const list = (byBucket.get(bucket) ?? []).sort((a, b) => {
        const byDate = (b.publishedAt ?? "").localeCompare(a.publishedAt ?? "");
        return byDate !== 0 ? byDate : a.id.localeCompare(b.id);
      });

      const chunks: SongRecord[][] = [];
      let current: SongRecord[] = [];
      let bytes = 32;
      for (const song of list) {
        const size = Buffer.byteLength(JSON.stringify(song, null, 2), "utf8") + 1;
        if (current.length && bytes + size > SIZE_BUDGET.maxFileBytes) {
          chunks.push(current);
          current = [];
          bytes = 32;
        }
        current.push(song);
        bytes += size;
      }
      chunks.push(current);

      for (let index = 0; index < chunks.length; index++) {
        const name = index === 0 ? bucket : `${bucket}.${index}`;
        writeJsonIfChanged(path.join(root, "songs", region, `${name}.json`), {
          schemaVersion: SCHEMA_VERSION,
          generatedAt: now,
          songs: chunks[index],
        } satisfies SongFile);
        keepFiles.add(`${name}.json`);
        if (index > 0) extraParts.push(name);
      }
      buckets.push(...extraParts);
    }

    // Remove region directories that no longer hold data.
    if (fs.existsSync(dir)) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (keepItemDirs.has(entry.name)) continue;
        fs.rmSync(path.join(dir, entry.name), { recursive: true, force: true });
      }
    }
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
