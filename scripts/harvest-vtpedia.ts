#!/usr/bin/env tsx
/**
 * Harvest VTuber channels from VTuberpedia (vtpedia.com).
 *
 * vtpedia.com publishes VTuber channel data via a public API:
 *   https://vtpedia.com/api/channels?limit=200
 *
 * No authentication required.
 *
 *   npm run data:vtpedia                      # harvest all
 *   npm run data:vtpedia -- --limit 50        # sample for parser check
 *
 * The harvest writes to .cache/vtpedia.json.
 * Importing is a separate step: npm run data:vtpedia-import
 */

import fs from "node:fs";
import path from "node:path";
import { fetchJson } from "../scripts/lib/io";
import { classifyChannel } from "../scripts/lib/classify";

const CACHE_DIR = ".cache/vtpedia";
const OUT_PATH = path.join(CACHE_DIR, "vtpedia.json");

interface VtpediaChannel {
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
            "Usage: npm run data:vtpedia -- [options]",
            "",
            "  --limit <n>  stop after n channels in this pass",
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

  const res = await fetchJson<{ data?: VtpediaChannel[] }>(
    `https://vtpedia.com/api/channels?limit=${options.limit ?? 200}`
  );
  if (!res?.data) {
    console.error("vtpedia feed unavailable");
    process.exit(1);
  }

  const snapshot = {
    generatedAt: new Date().toISOString(),
    source: "vtpedia.com",
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
