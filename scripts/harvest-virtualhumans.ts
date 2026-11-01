#!/usr/bin/env tsx
/**
 * Harvest VTuber channels from VirtualHumans (virtualhumans.org/vtubers).
 *
 * virtualhumans.org/vtubers is a VTuber directory that lists VTubers
 * with their YouTube channel information.
 *
 * No authentication required.
 */

import { fetchJson } from "../scripts/lib/io";
import fs from "node:fs";
import path from "node:path";

const API_BASE = "https://virtualhumans.org";
const CACHE_DIR = ".cache/virtualhumans";
const OUT_PATH = path.join(CACHE_DIR, "virtualhumans.json");

interface VirtualHumansChannel {
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
            "Usage: npm run data:virtualhumans -- [options]",
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

  const res = await fetchJson<{ data?: VirtualHumansChannel[] }>(
    `${API_BASE}/api/vtubers?limit=${options.limit ?? 200}`
  );
  if (!res?.data) {
    console.error("virtualhumans feed unavailable");
    process.exit(1);
  }

  const snapshot = {
    generatedAt: new Date().toISOString(),
    source: "virtualhumans.org",
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
