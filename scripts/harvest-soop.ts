#!/usr/bin/env tsx
/**
 * Harvest VTuber channels from SOOP into a reviewable snapshot.
 *
 * SOOP exposes live broadcast list:
 *   GET https://live.sooplive.co.kr/api/main_broad_list_api.php?main_category_code=...
 * No authentication required.
 *
 * Only VTuber/VSinger streams are harvested — keywords filter out real
 * singers. SOOP is live-only, so the broadcast title is the keyword target.
 *
 *   npm run data:soop              # harvest SOOP VTuber candidates
 *   npm run data:soop -- --limit 200
 *
 * Nothing here writes `data/` — adding the channels is a separate step
 * through `npm run data:soop-import`.
 */

import { fetchJson } from "../scripts/lib/io";
import fs from "node:fs";
import path from "node:path";

const SOOP_API = "https://live.sooplive.co.kr/api/main_broad_list_api.php";
const CACHE_DIR = ".cache/soop";
const OUT_PATH = path.join(CACHE_DIR, "soop.json");

/** VTuber / VSinger keywords — only broadcasts matching these are kept. */
const VTUBER_KEYWORDS = [
  "vtuber",
  "vsinger",
  "virtual youtuber",
  "버추얼",
  "노래방",
  "가상",
  "virtual singer",
];

interface SoopStream {
  station_id?: string;
  channel_id?: string;
  broadcaster_id?: string;
  title?: string;
  broadcaster_name?: string;
  viewer_count?: number;
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
            "Usage: npm run data:soop [--limit <n>]",
            "",
            "  --limit <n>   max streams (default 200)",
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

/** True when the broadcast looks like a VTuber/VSinger (not a real singer). */
function isVtuberStream(s: SoopStream): boolean {
  const haystack = [s.title, s.broadcaster_name].join(" ").toLowerCase();
  return VTUBER_KEYWORDS.some((kw) => haystack.includes(kw.toLowerCase()));
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const limit = options.limit ?? 200;

  fs.mkdirSync(CACHE_DIR, { recursive: true });

  console.log("soop: fetching VTuber live broadcast list");
  const res = await fetchJson<{ data?: SoopStream[] }>(
    `${SOOP_API}?main_category_code=GAME&sub_category_code=&sort=popular&rows=${limit}`,
  );

  if (!res?.data) {
    console.log("soop: no stream data returned");
    process.exit(0);
  }

  // Filter to VTuber/VSinger only — real singers are excluded.
  const vtuberStreams = res.data.filter(isVtuberStream);

  const snapshot = {
    generatedAt: new Date().toISOString(),
    count: vtuberStreams.length,
    data: vtuberStreams,
    keywords: VTUBER_KEYWORDS,
  };

  fs.writeFileSync(OUT_PATH, JSON.stringify(snapshot, null, 2));
  console.log(
    `soop: ${vtuberStreams.length} VTuber stream(s) of ${res.data.length} → ${OUT_PATH}`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
