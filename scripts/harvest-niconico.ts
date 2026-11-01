#!/usr/bin/env tsx
/**
 * Harvest VTuber channels from Niconico into a reviewable snapshot.
 *
 * Niconico's Content Search API v2 lists live streams and videos:
 *   GET https://api.search.nicovideo.jp/api/v2/search?query=&type=video&filters[liveStatus]=onair
 * No authentication required.
 *
 * Only VTuber/VSinger videos are harvested — keywords filter out real
 * singers.
 *
 *   npm run data:niconico              # harvest Niconico VTuber candidates
 *   npm run data:niconico -- --limit 200
 *
 * Nothing here writes `data/` — adding the channels is a separate step
 * through `npm run data:niconico-import`.
 */

import { fetchJson } from "../scripts/lib/io";
import fs from "node:fs";
import path from "node:path";

const SEARCH_API = "https://api.search.nicovideo.jp/api/v2/search";
const CACHE_DIR = ".cache/niconico";
const OUT_PATH = path.join(CACHE_DIR, "niconico.json");

/** VTuber / VSinger keywords — only videos matching these are kept. */
const VTUBER_KEYWORDS = [
  "vtuber",
  "vsinger",
  "バーチャル",
  "歌枠",
  "ボーカロイド",
  "virtual youtuber",
  "virtual singer",
];

interface NicoVideo {
  contentId: string;
  title?: string;
  description?: string;
  viewCounter?: number;
  startTime?: number;
  userId?: string;
  userNickname?: string;
}

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
            "Usage: npm run data:niconico [--limit <n>]",
            "",
            "  --limit <n>   max videos (default 200)",
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

/** True when the video looks like a VTuber/VSinger (not a real singer). */
function isVtuberVideo(v: NicoVideo): boolean {
  const haystack = [v.title, v.description].join(" ").toLowerCase();
  return VTUBER_KEYWORDS.some((kw) => haystack.includes(kw.toLowerCase()));
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const limit = options.limit ?? 200;

  fs.mkdirSync(CACHE_DIR, { recursive: true });

  console.log("niconico: fetching VTuber on-air videos");
  const res = await fetchJson<{ data: NicoVideo[] }>(
    `${SEARCH_API}?query=&type=video&filters%5BliveStatus%5D%5B0%5D=onair&_sort=-viewCounter&_limit=${limit}`,
  );

  if (!res?.data) {
    console.log("niconico: no video data returned");
    process.exit(0);
  }

  // Filter to VTuber/VSinger only — real singers are excluded.
  const vtuberVideos = res.data.filter(isVtuberVideo);

  const snapshot = {
    generatedAt: new Date().toISOString(),
    count: vtuberVideos.length,
    data: vtuberVideos,
    keywords: VTUBER_KEYWORDS,
  };

  fs.writeFileSync(OUT_PATH, JSON.stringify(snapshot, null, 2));
  console.log(
    `niconico: ${vtuberVideos.length} VTuber video(s) of ${res.data.length} → ${OUT_PATH}`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
