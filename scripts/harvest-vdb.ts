#!/usr/bin/env tsx
/**
 * Harvest VTuber channels from vtuber-database.wikiru.jp (vdb).
 *
 * vtuber-database.wikiru.jp is a Japanese VTuber database wiki.
 * It publishes a public JSON API:
 *   https://vtuber-database.wikiru.jp/api/channels
 *
 * No authentication required.
 *
 *   npm run data:vtuber-db                      # harvest all
 *   npm run data:vtuber-db -- --limit 50        # sample for parser check
 *
 * Nothing here writes `data/` — adding the channels is
 * `npm run data:vtuber-db-import`.
 */

import { fetchJson } from "../scripts/lib/io";
import fs from "node:fs";
import path from "node:path";

const API_BASE = "https://vtuber-database.wikiru.jp";
const CACHE_DIR = ".cache/vdb";
const OUT_PATH = path.join(CACHE_DIR, "vdb.json");

interface VdbChannel {
  channel_id?: string;
  name?: string;
  description?: string;
  thumbnail?: string | null;
  subscribers?: number;
  views?: number;
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
            "Usage: npm run data:vtuber-db -- [options]",
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

  const res = await fetchJson<{ data?: VdbChannel[] }>(
    `${API_BASE}/api/channels?limit=${options.limit ?? 200}`
  );
  if (!res?.data) {
    console.error("vtuber-database.wikiru.jp feed unavailable");
    process.exit(1);
  }

  const snapshot = {
    generatedAt: new Date().toISOString(),
    source: "vtuber-database.wikiru.jp",
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
