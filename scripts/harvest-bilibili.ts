#!/usr/bin/env tsx
/**
 * Harvest VTuber channels from Bilibili into a reviewable snapshot.
 *
 * Bilibili's 虚拟主播 (VTuber) partition ranking (`rid=160`) publishes the
 * top VTuber channels on the platform. No authentication required.
 *
 *   npm run data:bilibili              # harvest VTuber candidates from Bilibili
 *   npm run data:bilibili -- --limit 100   # max ranking entries
 *
 * Nothing here writes `data/` — adding the channels is a separate step
 * through `npm run data:bilibili-import`.
 */

import { fetchJson } from "../scripts/lib/io";
import fs from "node:fs";
import path from "node:path";

const API = "https://api.bilibili.com";
const VTUBER_PARTITION = 160;
const CACHE_DIR = ".cache/bilibili";
const OUT_PATH = path.join(CACHE_DIR, "bilibili.json");

interface BiliRankingEntry {
  mid: number;
  uname: string;
  face?: string;
  sign?: string;
  pts?: number;
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
            "Usage: npm run data:bilibili [--limit <n>]",
            "",
            "  --limit <n>   max ranking entries (default 100)",
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
  const limit = options.limit ?? 100;

  fs.mkdirSync(CACHE_DIR, { recursive: true });

  console.log(`bilibili: fetching VTuber ranking (rid=${VTUBER_PARTITION})`);
  const res = await fetchJson<{
    data?: { list?: BiliRankingEntry[] };
  }>(
    `${API}/x/web-interface/ranking/v2?rid=${VTUBER_PARTITION}&type=1&arc_type=0&jsonp=jsonp`,
  );

  if (!res?.data?.list) {
    console.log("bilibili: no ranking data returned");
    process.exit(0);
  }

  const all = res.data.list.slice(0, limit);

  const snapshot = {
    generatedAt: new Date().toISOString(),
    count: all.length,
    data: all,
  };

  fs.writeFileSync(OUT_PATH, JSON.stringify(snapshot, null, 2));
  console.log(`bilibili: ${all.length} channel(s) harvested → ${OUT_PATH}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
