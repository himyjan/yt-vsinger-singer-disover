#!/usr/bin/env tsx
/**
 * Imports harvested Innertube music data directly into data/songs/ — never
 * touches data/items/.
 *
 * Reads every shard snapshot from .cache/innertube-music/, converts each
 * upload and YouTube Music release into a SongRecord, and writes them into
 * .volumes/vol-N/data/songs/{region}/{bucket}.json.
 *
 * By default every upload and release is imported. With --music-only, uploads
 * are filtered to only YouTube category ID "10" (Music) by calling InnerTube's
 * getInfo() per video — this costs one extra InnerTube request per upload, so
 * it is slower but keeps non-music uploads (gaming streams, podcasts, etc.)
 * out of the songs dataset. Official Artist Channel releases always pass.
 *
 *   npm run data:innertube-music-import              # report only
 *   npm run data:innertube-music-import -- --apply   # write song shards
 *   npm run data:innertube-music-import -- --shard 1/20 --apply  # one shard
 *   npm run data:innertube-music-import -- --apply --music-only  # only category ID 10
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
import { InnerTubeSource } from "../scripts/lib/youtubei";
import { inShard, parseShard } from "../scripts/lib/shard";
import { bucketFor } from "../scripts/lib/dataset";
import { SIZE_BUDGET } from "./lib/io";
import { SCHEMA_VERSION, ALL_REGIONS } from "./lib/types";
import { ensureDir, readJson, writeJsonIfChanged } from "./lib/io";

const CACHE_DIR = ".cache/innertube-music";
const PROGRESS_DIR = path.join(process.cwd(), "data", "innertube-music-import-progress");
const DEAD_CHANNELS_DIR = path.join(process.cwd(), "data", "innertube-music-dead");

function progressPath(shard: string | null): string {
  return path.join(
    PROGRESS_DIR,
    `import-progress-${shard?.replace("/", "-") ?? "all"}.json`,
  );
}

function readProgress(shard: string | null): Set<string> {
  try {
    const data = JSON.parse(
      fs.readFileSync(progressPath(shard), "utf8"),
    ) as { processed?: string[] };
    return new Set(data.processed ?? []);
  } catch {
    return new Set();
  }
}

function writeProgress(shard: string | null, processed: Set<string>): void {
  fs.mkdirSync(PROGRESS_DIR, { recursive: true });
  fs.writeFileSync(
    progressPath(shard),
    JSON.stringify({ processed: [...processed] }, null, 2),
  );
}

function deadPath(shard: string | null): string {
  return path.join(
    DEAD_CHANNELS_DIR,
    `dead-${shard?.replace("/", "-") ?? "all"}.json`,
  );
}

function readDead(shard: string | null): Set<string> {
  try {
    const data = JSON.parse(
      fs.readFileSync(deadPath(shard), "utf8"),
    ) as { dead?: string[] };
    return new Set(data.dead ?? []);
  } catch {
    return new Set();
  }
}

function writeDead(shard: string | null, dead: Set<string>): void {
  fs.mkdirSync(DEAD_CHANNELS_DIR, { recursive: true });
  fs.writeFileSync(
    deadPath(shard),
    JSON.stringify({ dead: [...dead] }, null, 2),
  );
}

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
  musicOnly: boolean;
  channelTimeoutMs: number;
  retryDead: boolean;
  maxUploads: number;
  delayMs: number;
  budgetMinutes: number;
  retryDeadTimeoutMs: number;
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    apply: false,
    limit: null,
    shard: null,
    musicOnly: false,
    channelTimeoutMs: 1_200_000, // 20 minutes per channel
    retryDead: false,
    maxUploads: 3000, // Channels with more uploads than this are auto-skipped
    delayMs: 100, // ms between InnerTube requests; lower = faster, riskier
    budgetMinutes: 330, // overall time budget per job (leaves buffer before 360-min job timeout)
    retryDeadTimeoutMs: 6_000, // per-upload timeout for --retry-dead channels (6s default)
  };
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
      case "--music-only":
        options.musicOnly = true;
        break;
      case "--channel-timeout":
        options.channelTimeoutMs = Math.max(10_000, Number(value ?? 1_200_000));
        i++;
        break;
      case "--retry-dead":
        options.retryDead = true;
        break;
      case "--retry-dead-timeout-ms":
        options.retryDeadTimeoutMs = Math.max(50, Number(value ?? 15_000));
        i++;
        break;
      case "--max-uploads":
        options.maxUploads = Math.max(1, Number(value ?? 3000));
        i++;
        break;
      case "--delay-ms":
        options.delayMs = Math.max(50, Number(value ?? 350));
        i++;
        break;
      case "--budget-minutes":
        options.budgetMinutes = Math.max(10, Number(value ?? 330));
        i++;
        break;
      case "--help":
      case "-h":
        console.log(
          [
            "Usage: npm run data:innertube-music-import [--apply] [--shard N/M] [--limit <n>] [--music-only] [--channel-timeout <ms>] [--retry-dead] [--retry-dead-timeout-ms <n>] [--max-uploads <n>] [--delay-ms <n>] [--budget-minutes <n>]",
            "",
            "  (no flags)   report what would be imported, write nothing",
            "  --apply      write song shards into data/songs/",
            "  --shard N/M  only import this shard (1-based), e.g. --shard 1/20",
            "  --limit <n>  import at most n channels",
            "  --music-only only import uploads whose YouTube category ID is '10' (Music).",
            "               Requires one InnerTube getInfo() call per upload.",
            "  --channel-timeout <ms>  per-channel timeout in ms (default: 1200000 = 20 min)",
            "               Channels taking longer are marked dead and skipped.",
            "  --retry-dead   retry channels that previously timed out (dead-channels.json)",
            "  --retry-dead-timeout-ms  per-upload timeout for --retry-dead channels in ms (default: 6000 = 6s; only used with --retry-dead)",
            "  --max-uploads  skip channels with more than this many uploads (default: 3000 ≈ 17 min at 350ms each)",
            "  --delay-ms     ms between InnerTube requests (default: 100; lower = faster, higher rate-limit risk)",
            "  --budget-minutes  overall time budget per job in minutes (default: 330; stops early and writes partial results)",
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

  // Resume: skip channels already processed in a previous run of this shard.
  const alreadyProcessed = readProgress(options.shard);
  const alreadyDead = readDead(options.shard);
  const previouslyProcessed = targets.filter((e) =>
    alreadyProcessed.has(e.channelId),
  ).length;
  targets = targets.filter((e) => !alreadyProcessed.has(e.channelId));
  // Also skip previously dead channels unless --apply --retry-dead is used
  if (options.retryDead) {
    console.log(
      `innertube-music-import: ${alreadyDead.size} previously dead channel(s) will be retried`,
    );
  } else {
    targets = targets.filter((e) => !alreadyDead.has(e.channelId));
    if (alreadyDead.size > 0) {
      console.log(
        `innertube-music-import: skipping ${alreadyDead.size} previously dead channel(s) (re-run with --retry-dead to retry)`,
      );
    }
  }

  if (options.limit) {
    targets = targets.slice(0, options.limit);
  }

  // Count songs that would be imported.
  let songCount = 0;
  for (const e of targets) {
    songCount += e.uploads.length + e.releases.length;
  }
  if (options.musicOnly) {
    console.log(
      `innertube-music-import: ${songCount} song(s) would be imported from ${targets.length} channel(s) (music-only: uploads filtered by category ID '10')`,
    );
  } else {
    console.log(
      `innertube-music-import: ${songCount} song(s) would be imported from ${targets.length} channel(s)`,
    );
  }

  if (!options.apply) {
    console.log("Nothing was written. Re-run with --apply.");
    return;
  }

  const now = new Date().toISOString();
  const songs: SongRecord[] = [];
  const startTime = Date.now();
  const budgetMs = options.budgetMinutes * 60_000;
  const WRITE_EVERY_CHANNELS = 100;

  // InnerTube source for per-video category lookup (music-only mode).
  let source: InnerTubeSource | null = null;
  if (options.musicOnly) {
    source = new InnerTubeSource({ delayMs: options.delayMs });
    await source.connect();
    console.log(
      "innertube-music-import: music-only mode — filtering uploads by YouTube category ID '10'",
    );
  }

  let musicFiltered = 0;
  // Channels that timed out or errored during this run — written to dead file
  // so they're skipped on subsequent runs unless --retry-dead is used.
  const deadChannels = readDead(options.shard);
  let channelsProcessed = 0;
  let lastWriteAt = startTime;

  /** Write the songs collected so far, merged with existing volume songs. */
  async function writePartialSongs(label: string): Promise<void> {
    if (songs.length === 0) return;
    songs.sort((a, b) => a.id.localeCompare(b.id));
    let volRoot: string;
    if (options.shard) {
      const shard = parseShard(options.shard);
      const volIndex = shard.index - 1;
      volRoot = path.join(
        process.cwd(),
        ".volumes",
        `vol-${volIndex}`,
        "data",
      );
    } else {
      volRoot = path.join(process.cwd(), "data");
    }
    const existingSongs = readAllSongs(volRoot);
    const merged = new Map<string, SongRecord>();
    for (const song of existingSongs) merged.set(song.id, song);
    for (const song of songs) merged.set(song.id, song);
    const allSongs = [...merged.values()];
    allSongs.sort((a, b) => a.id.localeCompare(b.id));
    ensureDir(volRoot);
    writeSongShards(allSongs, now, volRoot);
    console.log(
      `innertube-music-import: ${label} wrote ${allSongs.length} song(s) (${songs.length} new this run)`,
    );
  }

  for (const entry of targets) {
    // Overall time budget: stop early if we're running out of time so
    // partial results are saved before the job timeout kills the run.
    const elapsed = Date.now() - startTime;
    if (elapsed >= budgetMs) {
      // Budget exhausted: every remaining target is unprocessed — record them
      // as dead so they can be retried with --retry-dead.
      const remainingIndex = targets.indexOf(entry);
      for (const remaining of targets.slice(remainingIndex)) {
        deadChannels.add(remaining.channelId);
        console.log(
          `  BUDGET: ${remaining.channelId} (${remaining.channelName}) not processed — budget exhausted, saved to dead list`,
        );
      }
      console.log(
        `innertube-music-import: budget of ${options.budgetMinutes} min exhausted after ${channelsProcessed}/${targets.length} channels — writing partial results`,
      );
      break;
    }

    // Skip channels with too many uploads - they will always time out
    // because each upload requires a getBasicInfo() call (~350ms each).
    if (entry.uploads.length > options.maxUploads) {
      deadChannels.add(entry.channelId);
      console.log(
        `  SKIPPED: ${entry.channelId} (${entry.channelName}) has ${entry.uploads.length} uploads, exceeds max of ${options.maxUploads}`,
      );
      continue;
    }

    // Wrap each channel's processing in a timeout so a slow/dead channel
    // doesn't block the entire run indefinitely. Timeout scales with the
    // number of uploads: base timeout + 30s per upload (each upload needs a
    // getBasicInfo() call for category checking). Channels taking longer
    // than this are marked as dead and skipped.
    // Per-upload timeout: each getBasicInfo() call gets its own timeout
    // so one stuck upload doesn't block the whole channel.
    const perUploadTimeoutMs = 30_000;

    // Channel timeout scales with number of uploads: base 10 min + 10s per
    // upload, capped at 30 minutes. A channel with 1000 uploads gets
    // 10 min + 10000s ≈ 176 min, but capped at 30 min.
    const channelTimeoutMs = Math.min(
      options.channelTimeoutMs + entry.uploads.length * 10_000,
      30 * 60_000,
      // Never let one channel burn past the remaining budget:
      // cap at remaining time minus a 2-minute buffer for writing.
      Math.max(0, budgetMs - (Date.now() - startTime) - 2 * 60_000),
    );
    if (channelTimeoutMs <= 0) {
      // Not enough time left for even one channel — save the rest to dead.
      const remainingIndex = targets.indexOf(entry);
      for (const remaining of targets.slice(remainingIndex)) {
        deadChannels.add(remaining.channelId);
        console.log(
          `  BUDGET: ${remaining.channelId} (${remaining.channelName}) not processed — budget exhausted, saved to dead list`,
        );
      }
      console.log(
        `innertube-music-import: budget of ${options.budgetMinutes} min exhausted after ${channelsProcessed}/${targets.length} channels — writing partial results`,
      );
      break;
    }
    const channelTimeout = new Promise<never>((_resolve, reject) =>
      setTimeout(
        () =>
          reject(
            new Error(
              `channel ${entry.channelId} (${entry.channelName}) timed out after ${channelTimeoutMs / 1000}s`,
            ),
          ),
        channelTimeoutMs,
      ),
    );

    let channelProcessed = false;
    try {
      await Promise.race([
        (async () => {
          for (const upload of entry.uploads) {
            // Budget check inside the upload loop: if we're running out of
            // time, stop mid-channel so partial results can be saved.
            const elapsed = Date.now() - startTime;
            if (elapsed >= budgetMs) {
              deadChannels.add(entry.channelId);
              console.log(
                `  BUDGET: ${entry.channelId} (${entry.channelName}) stopped mid-channel — budget exhausted, saved to dead list`,
              );
              return;
            }

            // Per-upload timeout: each getBasicInfo() call gets its own
            // timeout so one stuck upload doesn't block the whole channel.
            // When --retry-dead is set, use the retry-dead-specific timeout
            // (default 15s instead of 30s) since these channels are already
            // known to be slow/problematic.
            const uploadTimeoutMs = options.retryDead
              ? options.retryDeadTimeoutMs
              : perUploadTimeoutMs;
            const uploadTimeout = new Promise<never>((_resolve, reject) =>
              setTimeout(
                () =>
                  reject(
                    new Error(
                      `upload ${upload.id} timed out after ${uploadTimeoutMs / 1000}s`,
                    ),
                  ),
                uploadTimeoutMs,
              ),
            );

            if (options.musicOnly && source) {
              try {
                const info = await Promise.race([
                  source.getBasicInfo(upload.id),
                  uploadTimeout,
                ]);
                const categoryId = info?.category_id;
                if (categoryId !== "10") {
                  musicFiltered += 1;
                  continue;
                }
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                console.error(`    category check failed ${upload.id}: ${msg}`);
                // On failure, skip the upload — we cannot verify it is music.
                musicFiltered += 1;
                continue;
              }
            }
            const song = uploadToSong(upload, entry, now);
            if (song) songs.push(song);
          }
          for (const release of entry.releases) {
            songs.push(releaseToSong(release, entry, now));
          }
          channelProcessed = true;
        })(),
        channelTimeout,
      ]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`    channel ${entry.channelId} (${entry.channelName}): ${msg}`);
      // Mark as dead so it's not retried next run unless --retry-dead is used
      deadChannels.add(entry.channelId);
      continue;
    }

    if (channelProcessed) {
      alreadyProcessed.add(entry.channelId);
      writeProgress(options.shard, alreadyProcessed);
      channelsProcessed++;

      // Write partial results periodically so progress isn't lost if
      // the job is canceled or times out.
      if (channelsProcessed % WRITE_EVERY_CHANNELS === 0) {
        await writePartialSongs(
          `after ${channelsProcessed}/${targets.length} channels`,
        );
      }
    }
  }

  // Write dead channels report
  if (deadChannels.size > 0) {
    writeDead(options.shard, deadChannels);
    console.log(
      `innertube-music-import: ${deadChannels.size} channel(s) timed out or failed — written to dead-channels.json`,
    );
  }

  if (options.musicOnly) {
    console.log(
      `innertube-music-import: filtered out ${musicFiltered} non-music upload(s)`,
    );
    try {
      await source?.disconnect();
    } catch {
      /* ignore disconnect errors */
    }
  }

  // Final write of all songs collected this run.
  await writePartialSongs("final");

  if (songs.length === 0) {
    console.log("innertube-music-import: no new songs to import — nothing written");
    return;
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
