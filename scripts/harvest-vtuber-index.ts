#!/usr/bin/env tsx
/**
 * Harvest VTuber channels from VTuber-index (vtuber-index.com).
 *
 * vtuber-index.com publishes VTuber channel data via a public JSON API:
 *   POST https://www.vtuber-index.com/index.cgi with body `api=get_channels`
 *
 * Each entry carries a YouTube channel id, name, group, country, debut date,
 * subscriber count, video count, and more. No authentication required.
 *
 *   npm run data:vtuber-index              # harvest all
 *   npm run data:vtuber-index -- --limit 50   # sample for parser check
 *
 * Nothing here writes data/ — adding the channels is a separate step
 * through `npm run data:vtuber-index-import`.
 */

import fs from "node:fs";
import path from "node:path";

const API_URL = "https://www.vtuber-index.com/index.cgi";
const CACHE_DIR = ".cache/vtuber-index";
const OUT_PATH = path.join(CACHE_DIR, "vtuber-index.json");

interface VtuberIndexEntry {
  id: string;
  channel_id: string;
  name: string;
  group: string;
  subscriber: number;
  view_count: number;
  video_count: number;
  video_live_count: number;
  spc_data_count: number;
  country: string;
  member_fee: string;
  image_url: string;
  first_video_date: string;
  last_video_date: string | null;
  retirement_date: string | null;
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
            "Usage: npm run data:vtuber-index [--limit <n>]",
            "",
            "  --limit <n>  stop after n entries in this pass",
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

  console.log(`vtuber-index: fetching from ${API_URL}`);
  let data: VtuberIndexEntry[];
  try {
    const res = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "yt-vsinger-singer-tracker/1.0 (dataset builder)",
        Accept: "application/json",
      },
      body: "api=get_channels",
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      console.error(
        `vtuber-index: HTTP ${res.status} — leaving previous cache untouched`,
      );
      process.exit(0);
    }
    data = (await res.json()) as VtuberIndexEntry[];
  } catch {
    console.error(
      "vtuber-index: fetch failed — leaving previous cache untouched",
    );
    process.exit(0);
  }

  let vtubers = data as VtuberIndexEntry[];
  if (options.limit) vtubers = vtubers.slice(0, options.limit);

  const snapshot = {
    generatedAt: new Date().toISOString(),
    source: "vtuber-index.com",
    count: vtubers.length,
    data: vtubers,
  };

  fs.writeFileSync(OUT_PATH, JSON.stringify(snapshot, null, 2));
  console.log(
    `vtuber-index: ${vtubers.length} entr(y/ies) harvested → ${OUT_PATH}`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
