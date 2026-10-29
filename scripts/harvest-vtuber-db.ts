#!/usr/bin/env tsx
/**
 * Harvests VtuberDB (vtuberdb.com) Cargo tables into a reviewable snapshot.
 *
 * vtuberdb.com is a Japanese VTuber database wiki running MediaWiki with the
 * Cargo extension. The `Vtubers` table carries name, kana, affiliation and
 * debut date; `StatusHistory` carries activity status. No social media links
 * are published, so every entry needs a YouTube name search to find its
 * channel — that happens at import time, not harvest time.
 *
 *   npm run data:vtuber-db              # the whole roster
 *   npm run data:vtuber-db -- --limit 100   # a sample, for a parser check
 *
 * Nothing here writes `data/` — adding the channels is a separate step.
 */

import fs from "node:fs";
import path from "node:path";
import { harvestVtuberDb } from "./lib/vtuber-db";

const CACHE_DIR = ".cache/vtuber-db";
const OUT_PATH = path.join(CACHE_DIR, "vtuber-db.json");

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
            "Usage: npm run data:vtuber-db -- [options]",
            "",
            "  --limit <n>  stop after n entries in this pass",
          ].join("\n"),
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

  const entries = await harvestVtuberDb(options.limit ?? 10_000);
  const snapshot = {
    generatedAt: new Date().toISOString(),
    source: "vtuberdb.com",
    count: entries.length,
    entries,
  };
  fs.writeFileSync(OUT_PATH, JSON.stringify(snapshot, null, 2));
  console.log(`${entries.length} entr(y/ies) harvested → ${OUT_PATH}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
