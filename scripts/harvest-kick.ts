#!/usr/bin/env tsx
/**
 * Harvest VTuber channels from KICK into a reviewable snapshot.
 *
 * KICK exposes a channel directory API:
 *   GET https://kick.com/api/v2/channels?category=...&limit=...
 * No authentication required for basic channel listing.
 *
 * Only VTuber/VSinger channels are harvested — keywords filter the
 * directory to virtual performers, not real singers.
 *
 *   npm run data:kick              # harvest KICK VTuber candidates
 *   npm run data:kick -- --limit 200
 *
 * Nothing here writes `data/` — adding the channels is a separate step
 * through `npm run data:kick-import`.
 */

import { fetchJson } from "../scripts/lib/io";
import fs from "node:fs";
import path from "node:path";

const KICK_API = "https://kick.com/api/v2";
const CACHE_DIR = ".cache/kick";
const OUT_PATH = path.join(CACHE_DIR, "kick.json");

/** VTuber / VSinger keywords — only channels matching these are kept. */
const VTUBER_KEYWORDS = [
  "vtuber",
  "vsinger",
  "virtual youtuber",
  "バーチャル",
  "歌枠",
  "virtual singer",
];

interface KickChannel {
  id: string;
  username: string;
  title: string;
  description: string | null;
  viewer_count: number | null;
  categories: Array<{ name: string }>;
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
            "Usage: npm run data:kick [--limit <n>]",
            "",
            "  --limit <n>   max channels (default 200)",
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

/** True when the channel looks like a VTuber/VSinger (not a real singer). */
function isVtuberChannel(ch: KickChannel): boolean {
  const haystack = [
    ch.title,
    ch.description,
    ...ch.categories.map((c) => c.name),
  ]
    .join(" ")
    .toLowerCase();
  return VTUBER_KEYWORDS.some((kw) => haystack.includes(kw.toLowerCase()));
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const limit = options.limit ?? 200;

  fs.mkdirSync(CACHE_DIR, { recursive: true });

  console.log("kick: fetching VTuber channel directory");
  const res = await fetchJson<{ data?: KickChannel[] }>(
    `${KICK_API}/channels?limit=${limit}`,
  );

  if (!res?.data) {
    console.log("kick: no channel data returned");
    process.exit(0);
  }

  // Filter to VTuber/VSinger only — real singers are excluded.
  const vtuberChannels = res.data.filter(isVtuberChannel);

  const snapshot = {
    generatedAt: new Date().toISOString(),
    count: vtuberChannels.length,
    data: vtuberChannels,
    keywords: VTUBER_KEYWORDS,
  };

  fs.writeFileSync(OUT_PATH, JSON.stringify(snapshot, null, 2));
  console.log(
    `kick: ${vtuberChannels.length} VTuber channel(s) of ${res.data.length} → ${OUT_PATH}`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
