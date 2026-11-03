#!/usr/bin/env tsx
/**
 * Harvest VTuber / streamer profiles from vt.rita.moe (/vt/list).
 *
 * vt.rita.moe is a live tracker of VTubers based on /vt/ generals. It
 * publishes a JSON API at /api/list which carries each streamer's name,
 * avatar, platform links (YouTube, Twitch, Bilibili, CHZZK, Kick, RPlay,
 * Fansly, SOOP), social links, tags (language, country, group, genre, model,
 * thread) and live status — a full profile for every entry.
 *
 * The webapp paginates the list and only loads every profile when the "Show
 * all" button is pressed, so the harvest requests `showAll=true` to get the
 * complete catalogue in one request rather than a single page.
 *
 *   npm run data:rita               # harvest every profile
 *   npm run data:rita -- --limit 50   # sample for a parser check
 *
 * No authentication required.
 *
 * The harvest writes to .cache/rita/rita.json.
 * Importing is a separate step: npm run data:rita-import
 */

import fs from "node:fs";
import path from "node:path";

const SOURCE_URL = "https://vt.rita.moe";
const CACHE_DIR = ".cache/rita";
const OUT_PATH = path.join(CACHE_DIR, "rita.json");

interface RitaTag {
  id: number;
  group: string;
  title: string;
  color: string;
}

interface RitaLink {
  title: string;
  url: string;
}

interface RitaEntry {
  id: number;
  name: string;
  avatar: string | null;
  avatar_proxied: string | null;
  avatar_proxied2x: string | null;
  twitch: string | null;
  twitch_id: string | null;
  youtube: string | null;
  youtube_id: string | null;
  bilibili: string | null;
  chzzk: string | null;
  kick: string | null;
  kick_id: string | null;
  rplay: string | null;
  rplay_id: string | null;
  fansly: string | null;
  soopkr: string | null;
  links: RitaLink[];
  tags: RitaTag[];
  last_live: number | null;
  last_check: Record<string, number | null>;
  last_seen: Record<string, number | null>;
  is_live: number;
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
            "Usage: npm run data:rita [options]",
            "",
            "  --limit <n>  max profiles to harvest",
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

  // `showAll=true` is the "Show all" button: the webapp paginates the list and
  // only loads every profile when it is pressed, so this is the single request
  // that returns the whole catalogue with profile data.
  const url = `${SOURCE_URL}/api/list?showAll=true`;
  console.log(`rita: fetching ${url}`);
  let entries: RitaEntry[];
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      console.error(`rita: HTTP ${res.status} — aborting`);
      process.exit(1);
    }
    const body = (await res.json()) as { list?: RitaEntry[] };
    entries = body.list ?? [];
  } catch (err) {
    console.error(
      `rita: list fetch failed — ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }

  if (!entries.length) {
    console.error("rita: no profiles found — leaving previous cache untouched");
    process.exit(0);
  }

  let limited = entries;
  if (options.limit) limited = entries.slice(0, options.limit);

  console.log(
    `rita: ${entries.length} profile(s) found → ${limited.length} harvested`,
  );

  const snapshot = {
    generatedAt: new Date().toISOString(),
    source: "vt.rita.moe",
    count: limited.length,
    total: entries.length,
    data: limited,
  };

  fs.writeFileSync(OUT_PATH, JSON.stringify(snapshot, null, 2));
  console.log(`rita: ${limited.length} profile(s) harvested → ${OUT_PATH}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
