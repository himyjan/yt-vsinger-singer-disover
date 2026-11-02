#!/usr/bin/env tsx
/**
 * Harvest VTuber channels from Chuysan (vtuber.chuysan.com).
 *
 * Chuysan publishes channel data via a JSON API at
 * `https://vtuber.chuysan.com/api/channels`. Each row carries a YouTube
 * channel id (`channel_id`), so matching against the dataset is direct
 * (no search required).
 *
 *   npm run data:chuysan              # harvest VTuber candidates
 *   npm run data:chuysan -- --limit 200   # page size for the listing API
 *
 * Nothing here writes `data/` — adding the channels is a separate step
 * through `npm run data:chuysan-import`.
 */

import fs from "node:fs";
import path from "node:path";

const API_BASE = "https://vtuber.chuysan.com/api";
const CACHE_DIR = ".cache/chuysan";
const OUT_PATH = path.join(CACHE_DIR, "chuysan.json");

interface ChuYsanChannel {
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
            "Usage: npm run data:chuysan [--limit <n>]",
            "",
            "  --limit <n>  page size for the channels API (default 200)",
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

  const limit = options.limit ?? 200;
  const url = `${API_BASE}/channels?limit=${limit}`;
  console.log(`chuysan: fetching ${url}`);

  const res = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "yt-vsinger-singer-tracker/1.0 (dataset builder)",
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    console.error(`chuysan: HTTP ${res.status}`);
    process.exit(1);
  }

  const data = (await res.json()) as { data?: ChuYsanChannel[] };
  const entries: ChuYsanChannel[] = data.data || [];

  const snapshot = {
    generatedAt: new Date().toISOString(),
    source: "vtuber.chuysan.com",
    count: entries.length,
    data: entries,
  };

  fs.writeFileSync(OUT_PATH, JSON.stringify(snapshot, null, 2));
  console.log(
    `chuysan: ${entries.length} entr(y/ies) harvested → ${OUT_PATH}`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
