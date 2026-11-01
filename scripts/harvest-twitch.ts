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
            "Usage: npm run data:twitch [--limit <n>]",
            "",
            "  --limit <n>   max results per search term (default 100)",
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

  for (const term of SEARCH_TERMS) {
    console.log(`twitch: searching "${term}"`);
    try {
      const results = await client.searchChannels(term, limit);
      for (const ch of results) {
        const id = String(ch.id);
        if (!id || seen.has(id)) continue;
        seen.add(id);
        all.push(ch);
      }
    } catch (error) {
      console.error(`twitch: search "${term}" failed: ${error}`);
    }
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
