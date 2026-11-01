#!/usr/bin/env tsx
/**
 * Harvest VTuber channels from Twitch into a reviewable snapshot.
 *
 * Twitch exposes a public channel search API (Helix `search/channels`),
 * which requires `TWITCH_CLIENT_ID` and `TWITCH_CLIENT_SECRET` credentials.
 * Without them the harvest writes nothing and exits cleanly.
 *
 *   npm run data:twitch              # harvest VTuber candidates from Twitch
 *   npm run data:twitch -- --limit 100   # results per search term
 *
 * Nothing here writes `data/` — adding the channels is a separate step
 * through `npm run data:twitch-import`.
 */

import { TwitchClient } from "../scripts/lib/twitch";

const CACHE_DIR = ".cache/twitch";
const OUT_PATH = path.join(CACHE_DIR, "twitch.json");

import fs from "node:fs";
import path from "node:path";

const SEARCH_TERMS = [
  "VTuber",
  "VSinger",
  "歌枠",
  "バーチャル",
  "virtual youtuber",
];

interface Options {
  limit: number | null;
  pages: number | null;
}

function parseArgs(argv: string[]): Options {
  const options: Options = { limit: null, pages: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const value = argv[i + 1];
    switch (arg) {
      case "--limit":
        options.limit = Math.max(1, Number(value ?? 1));
        i++;
        break;
      case "--pages":
        options.pages = Math.max(1, Number(value ?? 1));
        i++;
        break;
      case "--help":
      case "-h":
        console.log(
          [
            "Usage: npm run data:twitch [options]",
            "",
            "  --limit <n>  max results per search term",
            "  --pages <n>  max pages per search term (default: all)",
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

  const client = TwitchClient.fromEnv(process.env, CACHE_DIR);
  if (!client) {
    console.log(
      "twitch: skipped — TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET not set",
    );
    process.exit(0);
  }

  fs.mkdirSync(CACHE_DIR, { recursive: true });

  const all: any[] = [];
  const seen = new Set<string>();
  const maxPages = options.pages ?? Infinity;
  const perPage = Math.min(options.limit ?? 100, 100);

  for (const term of SEARCH_TERMS) {
    console.log(`twitch: searching "${term}"`);
    let cursor: string | null = null;
    let pageNum = 1;

    for (;;) {
      if (pageNum > maxPages) break;
      try {
        const result = await client.searchChannels(term, perPage);
        for (const ch of result.data) {
          const id = String(ch.id);
          if (!id || seen.has(id)) continue;
          seen.add(id);
          all.push(ch);
        }
        cursor = result.cursor;
        if (!cursor || all.length >= (options.limit ?? Infinity)) break;
        pageNum++;
      } catch (error) {
        console.error(`twitch: search "${term}" page ${pageNum} failed: ${error}`);
        break;
      }
    }
    console.log(`  "${term}": ${pageNum} page(s), cursor=${cursor ?? "none"}`);
  }

  const snapshot = {
    generatedAt: new Date().toISOString(),
    count: all.length,
    data: all,
  };

  fs.writeFileSync(OUT_PATH, JSON.stringify(snapshot, null, 2));
  console.log(`twitch: ${all.length} channel(s) harvested → ${OUT_PATH}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
