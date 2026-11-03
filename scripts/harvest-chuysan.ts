#!/usr/bin/env tsx
/**
 * Harvest VTuber channels from Chuysan (vtuber.chuysan.com).
 *
 * Chuysan is a Thai VTuber directory. Its website is a Next.js client-side
 * app that loads channel data from a public JSON API, so scraping the HTML
 * is brittle and unreliable. This script fetches the API directly:
 *
 *   https://storage.googleapis.com/thaivtuberranking.appspot.com/v2/channel_data/simple_list.json
 *
 * Each entry carries a YouTube channel id (`channel_id`), name (`title`),
 * debut date (`published_at`), subscriber/view counts, and thumbnail.
 *
 *   npm run data:chuysan              # harvest VTuber candidates
 *   npm run data:chuysan -- --limit 200   # maximum channels to extract
 *
 * Nothing here writes `data/` — adding the channels is a separate step
 * through `npm run data:chuysan-import`.
 */

import fs from "node:fs";
import path from "node:path";

const API_URL =
  "https://storage.googleapis.com/thaivtuberranking.appspot.com/v2/channel_data/simple_list.json";
const CACHE_DIR = ".cache/chuysan";
const OUT_PATH = path.join(CACHE_DIR, "chuysan.json");

interface ChuysanApiEntry {
  channel_id: string;
  title: string;
  thumbnail_icon_url?: string | null;
  subscribers?: number | null;
  views?: number | null;
  published_at?: string | null;
  last_published_video_at?: string | null;
  updated_at?: number | null;
  is_rebranded?: boolean | null;
}

interface ChuYsanChannel {
  channel_id?: string;
  name?: string;
  description?: string | null;
  thumbnail?: string | null;
  subscribers?: number | null;
  views?: number | null;
  published_at?: string | null;
  region?: string | null;
  gender?: string | null;
  languages?: string[] | null;
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
            "  --limit <n>  maximum number of channels to harvest",
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

  console.log(`chuysan: fetching ${API_URL}`);

  let entries: ChuysanApiEntry[];
  try {
    const res = await fetch(API_URL, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      console.error(`chuysan: HTTP ${res.status} — aborting`);
      process.exit(1);
    }
    const body = (await res.json()) as { result?: ChuysanApiEntry[] };
    entries = body.result ?? [];
  } catch (err) {
    console.error(
      `chuysan: fetch failed — ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }

  if (!entries.length) {
    console.error("chuysan: no entries found — leaving previous cache untouched");
    process.exit(0);
  }

  // Map API fields to the shape the importer expects (channel_id, name, etc.).
  const mapped: ChuYsanChannel[] = entries.map((e) => ({
    channel_id: e.channel_id,
    name: e.title,
    description: null,
    thumbnail: e.thumbnail_icon_url ?? null,
    subscribers: e.subscribers ?? null,
    views: e.views ?? null,
    published_at: e.published_at ?? null,
    region: null,
    gender: null,
    languages: null,
  }));

  let limited = mapped;
  if (options.limit) limited = mapped.slice(0, options.limit);

  console.log(`chuysan: ${entries.length} entr(y/ies) found → ${limited.length} harvested`);

  const snapshot = {
    generatedAt: new Date().toISOString(),
    source: "vtuber.chuysan.com",
    count: limited.length,
    total: entries.length,
    data: limited,
  };

  fs.writeFileSync(OUT_PATH, JSON.stringify(snapshot, null, 2));
  console.log(
    `chuysan: ${limited.length} entr(y/ies) harvested → ${OUT_PATH}`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
