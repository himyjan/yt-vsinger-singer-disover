#!/usr/bin/env tsx
/**
 * Harvest VTuber channels from CHZZK into a reviewable snapshot.
 *
 * CHZZK exposes channel listings:
 *   GET https://api.chzzk.naver.com/service/v1.0/channels?categoryCode=...&size=...
 * No authentication required for basic channel listing.
 *
 * Only VTuber / VSinger channels are harvested — keywords filter out real
 * singers. Multiple category codes are tried (GAME, MUSIC, ETC) so music
 * and variety VTubers are not missed.
 *
 *   npm run data:chzzk              # harvest CHZZK VTuber candidates
 *   npm run data:chzzk -- --limit 200
 *
 * Nothing here writes `data/` — adding the channels is a separate step
 * through `npm run data:chzzk-import`.
 */

import { fetchJson } from "../scripts/lib/io";
import fs from "node:fs";
import path from "node:path";

const CHZZK_API = "https://api.chzzk.naver.com/service/v1.0";
const CACHE_DIR = ".cache/chzzk";
const OUT_PATH = path.join(CACHE_DIR, "chzzk.json");

/** Category codes to harvest — GAME plus MUSIC/ETC for music VTubers. */
const CATEGORY_CODES = ["GAME", "MUSIC", "ETC"];

/** VTuber / VSinger keywords — only channels matching these are kept. */
const VTUBER_KEYWORDS = [
  "vtuber",
  "vsinger",
  "버튜버",
  "버추얼",
  "가상",
  "노래방",
  "노래",
  "음악",
  "라이브",
  "커버",
  "버추얼유튜버",
  "가상유튜버",
  "버츄얼",
  "virtual youtuber",
  "virtual singer",
];

interface ChzzkChannel {
  channelId: string;
  channelName: string;
  channelImageUrl?: string;
  followerCount?: number;
  categoryValue?: string;
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
            "Usage: npm run data:chzzk [--limit <n>]",
            "",
            "  --limit <n>   max channels per category (default 200)",
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

/** True when the channel looks like a VTuber / VSinger (not a real singer). */
function isVtuberChannel(ch: ChzzkChannel): boolean {
  const haystack = ch.channelName.toLowerCase();
  return VTUBER_KEYWORDS.some((kw) => haystack.includes(kw.toLowerCase()));
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const limit = options.limit ?? 200;

  fs.mkdirSync(CACHE_DIR, { recursive: true });

  const allChannels: ChzzkChannel[] = [];
  const seen = new Set<string>();

  for (const categoryCode of CATEGORY_CODES) {
    console.log(
      `chzzk: fetching category ${categoryCode} (limit ${limit})`,
    );
    const res = await fetchJson<{ content?: ChzzkChannel[] }>(
      `${CHZZK_API}/channels?categoryCode=${categoryCode}&size=${limit}`,
    );

    if (!res?.content) {
      console.log(`chzzk: category ${categoryCode} returned no data`);
      continue;
    }

    let added = 0;
    for (const ch of res.content) {
      if (!ch.channelId || seen.has(ch.channelId)) continue;
      seen.add(ch.channelId);
      allChannels.push(ch);
      added++;
    }
    console.log(`chzzk: category ${categoryCode} → ${added} new channel(s)`);
  }

  // Filter to VTuber/VSinger only — real singers are excluded.
  const vtuberChannels = allChannels.filter(isVtuberChannel);

  const snapshot = {
    generatedAt: new Date().toISOString(),
    count: vtuberChannels.length,
    totalScanned: allChannels.length,
    categories: CATEGORY_CODES,
    data: vtuberChannels,
    keywords: VTUBER_KEYWORDS,
  };

  fs.writeFileSync(OUT_PATH, JSON.stringify(snapshot, null, 2));
  console.log(
    `chzzk: ${vtuberChannels.length} VTuber channel(s) of ${allChannels.length} scanned → ${OUT_PATH}`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
