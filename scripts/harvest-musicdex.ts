#!/usr/bin/env tsx
/**
 * Harvest song data from Musicdex (music.holodex.net).
 *
 * Musicdex is the music layer of Holodex — it provides song-level tagging
 * (song title, original artist, category) extracted from VTuber singing
 * streams. Each entry is keyed by a YouTube video id.
 *
 * Musicdex is a client-side SPA — its HTML pages contain no song data.
 * All data comes from the API at https://music.holodex.net/api/v1/songs,
 * which requires MUSICDEX_API_KEY or HOLODEX_API_KEY. Without a key the
 * harvest writes an empty snapshot so the import step can proceed
 * cleanly instead of failing.
 *
 *   npm run data:musicdex              # harvest song metadata from Musicdex
 *   npm run data:musicdex -- --limit 500   # sample for parser check
 *
 * Nothing here writes data/ — importing the songs is a separate step
 * through `npm run data:musicdex-import`.
 */

import fs from "node:fs";
import path from "node:path";
import {
  fetchMusicdexDataset,
  musicdexApiKey,
  type MusicdexSongEntry,
} from "../scripts/lib/musicdex";

const CACHE_DIR = ".cache/musicdex";
const OUT_PATH = path.join(CACHE_DIR, "musicdex.json");

interface Options {
  limit: number | null;
}

function parseArgs(argv: string[]): Options {
  const options: Options = { limit: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const value = argv[i + 1];
    switch (arg) {
      case "--limit":
        options.limit = Math.max(1, Number(value ?? 1));
        i++;
        break;
      case "--help":
      case "-h":
        console.log(
          [
            "Usage: npm run data:musicdex [--limit <n>]",
            "",
            "  --limit <n>  stop after n songs in this pass",
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
  fs.mkdirSync(CACHE_DIR, { recursive: true });

  const key = musicdexApiKey();
  if (!key) {
    console.log(
      "musicdex: no MUSICDEX_API_KEY or HOLODEX_API_KEY — writing empty snapshot",
    );
    const snapshot = {
      generatedAt: new Date().toISOString(),
      source: "musicdex",
      count: 0,
      data: [],
    };
    fs.writeFileSync(OUT_PATH, JSON.stringify(snapshot, null, 2));
    console.log("musicdex: 0 song(s) harvested (no API key) → " + OUT_PATH);
    return;
  }

  const allSongs = await fetchMusicdexDataset(key);
  if (!allSongs?.length) {
    console.log("musicdex: no songs found — writing empty snapshot");
    const snapshot = {
      generatedAt: new Date().toISOString(),
      source: "musicdex",
      count: 0,
      data: [],
    };
    fs.writeFileSync(OUT_PATH, JSON.stringify(snapshot, null, 2));
    console.log("musicdex: 0 song(s) harvested → " + OUT_PATH);
    return;
  }

  let limited = allSongs;
  if (options.limit) limited = allSongs.slice(0, options.limit);

  console.log(`musicdex: harvesting ${limited.length} song(s)`);

  const snapshot = {
    generatedAt: new Date().toISOString(),
    source: "musicdex",
    count: limited.length,
    data: limited,
  };

  fs.writeFileSync(OUT_PATH, JSON.stringify(snapshot, null, 2));
  console.log(
    `musicdex: ${limited.length} song(s) harvested → ${OUT_PATH}`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
