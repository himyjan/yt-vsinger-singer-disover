#!/usr/bin/env tsx
/**
 * Enriches dataset items with Musicdex song metadata.
 *
 * `scripts/harvest-musicdex.ts` produces a snapshot in
 * `.cache/musicdex/musicdex.json`; this script reads that snapshot, matches
 * each song to a dataset item by YouTube video id, and enriches the item
 * with Musicdex's curated song title, original artist, and category.
 *
 * Precedence (curated data wins over heuristic extraction):
 *   1. VTuber Music Dataset (curated CSV — highest quality)
 *   2. Musicdex (curated API data)
 *   3. Heuristic extraction from titles/tags (classify.ts)
 *
 * Musicdex only enriches items where the field is currently null or where
 * the item's category is "other"/"live" — it never overwrites a confirmed
 * song title or original artist from a stronger source.
 *
 *   npm run data:musicdex-import                     # report only
 *   npm run data:musicdex-import -- --apply          # write enriched items
 *
 * Musicdex needs MUSICDEX_API_KEY or HOLODEX_API_KEY to harvest. Without
 * a key the harvest writes an empty snapshot, so there is nothing to import.
 */

import fs from "node:fs";
import path from "node:path";
import {
  readAllChannelRecords,
  writeItemShards,
} from "../scripts/lib/dataset";
import {
  MUSICDEX_CATEGORY_MAP,
  OVERWRITABLE_ITEM_CATEGORIES,
  type MusicdexSongEntry,
} from "../scripts/lib/musicdex";
import type { Channel, Item } from "../scripts/lib/types";

const SNAPSHOT = ".cache/musicdex/musicdex.json";

interface MusicdexSong extends MusicdexSongEntry {}

interface Options {
  apply: boolean;
  limit: number | null;
}

function parseArgs(argv: string[]): Options {
  const options: Options = { apply: false, limit: null };
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
      case "--help":
      case "-h":
        console.log(
          [
            "Usage: npm run data:musicdex-import -- [options]",
            "",
            "  --apply         write enriched items to data/items/",
            "  --limit <n>     enrich at most n items",
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

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(SNAPSHOT)) {
    console.error(
      `no snapshot at ${SNAPSHOT} — run npm run data:musicdex first`,
    );
    process.exit(1);
  }

  const snapshot: {
    data?: MusicdexSong[];
    generatedAt: string;
    count: number;
  } = JSON.parse(fs.readFileSync(SNAPSHOT, "utf8"));
  const songs = snapshot.data || [];

  if (!songs.length) {
    console.log("snapshot has no songs — nothing to import");
    return;
  }

  console.log(
    `snapshot ${snapshot.generatedAt} · ${songs.length} song(s) from musicdex`,
  );

  // Build a map from YouTube video id to Musicdex song.
  const byVideoId = new Map<string, MusicdexSong>();
  for (const song of songs) {
    if (!byVideoId.has(song.id)) byVideoId.set(song.id, song);
  }

  // Load the dataset: channels and items.
  const channels = readAllChannelRecords();

  // Load all item shards from data/items/<region>/<bucket>.json
  const items: Item[] = [];
  const regions = [
    "cn", "en", "hk", "id", "jp", "kr", "live", "my", "sea", "tw", "unknown",
  ];
  for (const region of regions) {
    const dir = path.join("data", "items", region);
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith(".json")) continue;
      try {
        const data = JSON.parse(
          fs.readFileSync(path.join(dir, file), "utf8"),
        ) as { items?: Item[] };
        if (data?.items) items.push(...data.items);
      } catch {
        // skip unreadable shard
      }
    }
  }

  const byItemId = new Map(items.map((i) => [i.id, i]));

  // Build a channel map: channelId -> channel, for OAC badge lookup.
  const byChannelId = new Map<string, Channel>();
  for (const channel of channels) {
    byChannelId.set(channel.id, channel);
  }

  // Pair each song with its dataset item, then sort so OAC (Official Artist
  // Channel) badge holders are enriched first. OAC channels are verified
  // artists on YouTube — their song metadata is the most authoritative, so
  // when the --limit budget runs out, OAC items get priority.
  const songItems: Array<{ song: MusicdexSong; item: Item; isOac: boolean }> = [];
  let matched = 0;
  let enriched = 0;
  let skipped = 0;
  for (const song of songs) {
    const item = byItemId.get(song.id);
    if (!item) {
      skipped++;
      continue;
    }
    matched++;
    const channel = byChannelId.get(item.channelId);
    const isOac = channel?.isOfficialArtist === true;
    songItems.push({ song, item, isOac });
  }

  // Sort: OAC first, then by song id for determinism.
  songItems.sort((a, b) => {
    if (b.isOac && !a.isOac) return 1;
    if (a.isOac && !b.isOac) return -1;
    return a.song.id.localeCompare(b.song.id);
  });
  const now = new Date().toISOString();

  for (const { song, item } of songItems) {
    let changed = false;

    // Enrich song title — only when null or item is unclassified.
    if (song.song && (!item.songTitle || item.category === "other")) {
      item.songTitle = song.song;
      changed = true;
    }

    // Enrich original artist — only when null or item is unclassified.
    if (song.originalArtist && !item.originalArtist) {
      item.originalArtist = song.originalArtist;
      changed = true;
    }

    // Enrich category — only when item is "other" or "live".
    if (
      song.category &&
      MUSICDEX_CATEGORY_MAP[song.category] &&
      OVERWRITABLE_ITEM_CATEGORIES.has(item.category)
    ) {
      item.category = MUSICDEX_CATEGORY_MAP[song.category]!;
      changed = true;
    }

    // Enrich publishedAt — only when null.
    if (song.publishedAt && !item.publishedAt) {
      item.publishedAt = song.publishedAt;
      changed = true;
    }

    // Enrich duration — only when null.
    if (
      song.duration !== undefined &&
      song.duration !== null &&
      !item.duration
    ) {
      item.duration = song.duration;
      changed = true;
    }

    // Enrich viewCount — only when null.
    if (
      song.viewCount !== undefined &&
      song.viewCount !== null &&
      !item.viewCount
    ) {
      item.viewCount = song.viewCount;
      changed = true;
    }

    // Enrich thumbnail — only when null.
    if (song.thumbnail && !item.thumbnail) {
      item.thumbnail = song.thumbnail;
      changed = true;
    }

    // Mark as collaboration.
    if (song.isCollab && !item.isCollab) {
      item.isCollab = true;
      changed = true;
    }

    if (changed) {
      enriched++;
    }

    if (options.limit && enriched >= options.limit) break;
  }

  console.log(
    `matched ${matched} item(s), enriched ${enriched}, skipped ${skipped} (not in dataset)`,
  );

  if (!options.apply) {
    console.log("Nothing was written. Re-run with --apply.");
    return;
  }

  // Write enriched item shards.
  writeItemShards(items, now);

  console.log(
    `${enriched} item(s) written to data/items/ — run npm run data:index next.`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
