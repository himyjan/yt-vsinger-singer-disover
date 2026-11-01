#!/usr/bin/env tsx
/**
 * Harvest VTuber channels from V-SLive (v-sai.com/vtuber).
 *
 * v-sai.com/vtuber is a Vietnamese VTuber directory that publishes channel
 * data via a public JSON API.
 *
 * No authentication required.
 */

import { fetchJson } from "../scripts/lib/io";
import fs from "node:fs";
import path from "node:path";

const API_BASE = "https://www.v-sai.com/api";
const CACHE_DIR = ".cache/v-sai";
const OUT_PATH = path.join(CACHE_DIR, "v-sai.json");

interface VSaiChannel {
  channel_id?: string;
  name?: string;
  description?: string;
  thumbnail?: string | null;
  subscribers?: number;
  published_at?: string;
  region?: string | null;
  gender?: string | null;
  languages?: string[];
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
            "Usage: npm run data:v-sai -- [options]",
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

  const res = await fetchJson<{ data?: VSaiChannel[] }>(
    `${API_BASE}/channels?limit=${options.limit ?? 200}`
  );
  if (!res?.data) {
    // A source that is unreachable must not fail the run — leave the
    // previous cache in place and exit cleanly so the workflow continues.
    console.error("V-SLive feed unavailable — leaving previous cache untouched");
    process.exit(0);
  }

  const snapshot = {
    generatedAt: new Date().toISOString(),
    source: "v-sai.com",
    count: res.data.length,
    items: res.data,
  };
  fs.writeFileSync(OUT_PATH, JSON.stringify(snapshot, null, 2));
  console.log(`${res.data.length} channel(s) harvested → ${OUT_PATH}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
