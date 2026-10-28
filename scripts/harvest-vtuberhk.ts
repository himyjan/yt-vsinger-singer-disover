#!/usr/bin/env tsx
/**
 * Harvests the VtuberHK directory into a reviewable snapshot.
 *
 * `https://vtuber.hk` is a static PHP site — no challenge, no pagination — and
 * it is read as **five requests**, four of which are JSON:
 *
 * | Request | What it gives |
 * | --- | --- |
 * | `GET /channels/` | the roster and its state (活動中 / 準備中 / 己引退): 672 channels |
 * | `GET /data/channels.json` | a `channels.list` dump: description, country, handle and the three counts |
 * | `GET /data/live-hkv.json` | the live and upcoming schedule |
 * | `GET /data/archive-hkv.json` | the recently ended streams and uploads |
 * | `GET /twitch` | 235 Twitch logins for the same scene |
 *
 *   npm run data:vtuberhk                 # all five
 *   npm run data:vtuberhk -- --youtube    # the YouTube side only
 *   npm run data:vtuberhk -- --twitch     # the Twitch page only
 *   npm run data:vtuberhk -- --no-videos  # roster + metadata, no live/archive
 *
 * Nothing here writes `data/`: adding the channels is
 * `npm run data:vtuberhk-import`.
 */

import fs from "node:fs";
import {
  buildVtuberHkSnapshot,
  parseVtuberHkChannels,
  parseVtuberHkMeta,
  parseVtuberHkTwitch,
  parseVtuberHkVideos,
} from "./lib/vtuberhk";

const OUT = ".cache/vtuberhk-channels.json";
const BASE = "https://vtuber.hk";
const CHANNELS_PAGE = `${BASE}/channels/`;
const TWITCH_PAGE = `${BASE}/twitch`;
const CHANNELS_JSON = `${BASE}/data/channels.json`;
const LIVE_JSON = `${BASE}/data/live-hkv.json`;
const ARCHIVE_JSON = `${BASE}/data/archive-hkv.json`;

interface Options {
  youtube: boolean;
  twitch: boolean;
  videos: boolean;
}

function parseArgs(argv: string[]): Options {
  const options: Options = { youtube: true, twitch: true, videos: true };
  for (const arg of argv) {
    if (arg === "--youtube") {
      options.youtube = true;
      options.twitch = false;
    } else if (arg === "--twitch") {
      options.twitch = true;
      options.youtube = false;
    } else if (arg === "--no-videos") {
      options.videos = false;
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        [
          "Usage: npm run data:vtuberhk -- [options]",
          "",
          "  --youtube     harvest the YouTube roster and its metadata only",
          "  --twitch      harvest the Twitch page only",
          "  --no-videos   skip /data/live-hkv.json and /data/archive-hkv.json",
        ].join("\n"),
      );
      process.exit(0);
    }
  }
  return options;
}

/**
 * One request, with a timeout.
 *
 * The site is a small static host and every request has to have a deadline: a
 * `fetch` without one never rejects, it hangs, and a hung request in a
 * scheduled workflow stalls the job with no output (`AGENTS.md` rule 11).
 */
async function get(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(30_000),
      headers: {
        // The harvest is a reader, and says so.
        "user-agent": "vsinger-tracker/1.0 (+https://github.com/; roster harvest)",
        accept: "text/html,application/json",
      },
    });
    if (!response.ok) {
      console.error(`  ${url} answered ${response.status}`);
      return null;
    }
    return await response.text();
  } catch (error) {
    console.error(`  ${url} failed: ${(error as Error).message}`);
    return null;
  }
}

/** JSON, or `null` — a malformed body must not take the run down. */
async function getJson(url: string): Promise<unknown> {
  const body = await get(url);
  if (!body) return null;
  try {
    return JSON.parse(body) as unknown;
  } catch (error) {
    console.error(`  ${url} is not JSON: ${(error as Error).message}`);
    return null;
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const started = Date.now();
  console.log("[vtuberhk] reading the directory…");

  const channels = options.youtube
    ? parseVtuberHkChannels((await get(CHANNELS_PAGE)) ?? "")
    : [];
  if (options.youtube) {
    console.log(`  ${CHANNELS_PAGE} → ${channels.length} channel(s)`);
  }

  const meta = options.youtube
    ? parseVtuberHkMeta(await getJson(CHANNELS_JSON))
    : {};
  if (options.youtube) {
    console.log(`  ${CHANNELS_JSON} → ${Object.keys(meta).length} metadata row(s)`);
  }

  const live =
    options.youtube && options.videos
      ? parseVtuberHkVideos(await getJson(LIVE_JSON))
      : [];
  if (options.youtube && options.videos) {
    console.log(`  ${LIVE_JSON} → ${live.length} live/upcoming row(s)`);
  }

  const archive =
    options.youtube && options.videos
      ? parseVtuberHkVideos(await getJson(ARCHIVE_JSON))
      : [];
  if (options.youtube && options.videos) {
    console.log(`  ${ARCHIVE_JSON} → ${archive.length} archive row(s)`);
  }

  const twitch = options.twitch
    ? parseVtuberHkTwitch((await get(TWITCH_PAGE)) ?? "")
    : [];
  if (options.twitch) {
    console.log(`  ${TWITCH_PAGE} → ${twitch.length} Twitch channel(s)`);
  }

  if (!channels.length && !twitch.length) {
    console.error("nothing was read — the snapshot was not written");
    process.exit(1);
  }

  const now = new Date().toISOString();
  const snapshot = buildVtuberHkSnapshot(channels, twitch, meta, live, archive, now);
  fs.writeFileSync(OUT, JSON.stringify(snapshot, null, 0));

  const counts = snapshot.counts;
  console.log(
    `\n${counts.total} channel(s) · ` +
      Object.entries(counts.byStatus)
        .map(([status, count]) => `${count} ${status}`)
        .join(" · "),
  );
  console.log(
    `metadata ${counts.meta} · live/upcoming ${counts.live} · archive ${counts.archive} · ` +
      `Twitch ${counts.twitch}`,
  );
  console.log(`wrote ${OUT} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
  console.log("Next: npm run data:vtuberhk-import");
}

main();
