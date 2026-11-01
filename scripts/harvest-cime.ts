#!/usr/bin/env tsx
/**
 * Harvest VTuber channels from CI.ME (ci.me).
 *
 * CI.ME publishes a public channel list at:
 *   https://ci.me/api/openapi/open/v1/channels
 *
 * No authentication required.
 *
 *   npm run data:cime                      # harvest all CI.ME channels
 *   npm run data:cive-harvest -- --limit 100   # sample for parser check
 *
 * Nothing is written to data/ — this only writes .cache/cime.json.
 * Importing is a separate step: npm run data:cime-import
 */

import { fetchJson } from "../scripts/lib/io";
import type { InnerTubeSource } from "../scripts/lib/youtubei";
import { readAllChannelRecords } from "../scripts/lib/dataset";

const CACHE_DIR = ".cache/cime";
const OUT_PATH = path.join(CACHE_DIR, "cime.json");

import fs from "node:fs";
import path from "node:path";

interface CimeChannel {
  id: string;
  name: string;
  bio?: string | null;
  avatar?: string | null;
  followers?: number;
  category?: string | null;
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
            "Usage: npm run data:cime -- [options]",
            "",
            "  --limit <n>  stop after n channels in this pass",
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

  const res = await fetchJson<{ data: CimeChannel[] }>(
    `https://ci.me/api/openapi/open/v1/channels?limit=${options.limit ?? 200}`
  );
  if (!res?.data) {
    console.error("CI.ME feed unavailable");
    process.exit(1);
  }

  const snapshot = {
    generatedAt: new Date().toISOString(),
    source: "ci.me",
    count: res.data.length,
    items: res.data,
  };
  fs.writeFileSync(OUT_PATH, JSON.stringify(snapshot, null, 2));
  console.log(`${res.data.length} CI.ME channel(s) harvested → ${OUT_PATH}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
