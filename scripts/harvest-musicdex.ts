#!/usr/bin/env tsx
/**
 * Harvest song data from Musicdex (music.holodex.net).
 *
 * Musicdex is the music layer of Holodex — it provides song-level tagging
 * (song title, original artist, category) extracted from VTuber singing
 * streams. Each entry is keyed by a YouTube video id.
 *
 * Two harvest modes:
 *
 *   1. **API** (default when MUSICDEX_API_KEY / HOLODEX_API_KEY is set):
 *      pulls every song from https://music.holodex.net/api/v1/songs. This is
 *      the complete catalogue and the preferred path.
 *
 *   2. **Profile** (fallback when no key, or with --profile-only):
 *      uses Playwright to open each channel's Musicdex profile page
 *      (https://music.holodex.net/channel/{youtubeId}), waits for the page to
 *      load its song list, intercepts the channel discovery API response and
 *      scrapes the rendered song rows. This is best-effort: Musicdex profiles
 *      are keyed by Musicdex's own channel ids, so a YouTube channel id only
 *      yields songs when Musicdex has indexed that channel.
 *
 *   npm run data:musicdex              # API if a key is set, else profiles
 *   npm run data:musicdex -- --api-only     # force the API path
 *   npm run data:musicdex -- --profile-only # force the profile path
 *   npm run data:musicdex -- --limit 200    # bound the profile pass
 *
 * Nothing here writes data/ — importing the songs is a separate step
 * through `npm run data:musicdex-import`.
 */

import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import {
  fetchMusicdexDataset,
  musicdexApiKey,
  type MusicdexSongEntry,
} from "../scripts/lib/musicdex";
import { readAllChannelRecords } from "../scripts/lib/dataset";

const CACHE_DIR = ".cache/musicdex";
const OUT_PATH = path.join(CACHE_DIR, "musicdex.json");
const MUSICDEX_BASE = "https://music.holodex.net";

interface Options {
  limit: number | null;
  apiOnly: boolean;
  profileOnly: boolean;
}

function parseArgs(argv: string[]): Options {
  const options: Options = { limit: null, apiOnly: false, profileOnly: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const value = argv[i + 1];
    switch (arg) {
      case "--limit":
        options.limit = Math.max(1, Number(value ?? 1));
        i++;
        break;
      case "--api-only":
        options.apiOnly = true;
        break;
      case "--profile-only":
        options.profileOnly = true;
        break;
      case "--help":
      case "-h":
        console.log(
          [
            "Usage: npm run data:musicdex [options]",
            "",
            "  --api-only      force the API path (requires MUSICDEX_API_KEY / HOLODEX_API_KEY)",
            "  --profile-only  force the Playwright profile-page path",
            "  --limit <n>     stop after n channels in the profile pass",
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

/* -------------------------------------------------------------------------- */
/* API path                                                                   */
/* -------------------------------------------------------------------------- */

async function harvestViaApi(): Promise<MusicdexSongEntry[]> {
  const key = musicdexApiKey();
  if (!key) {
    console.log(
      "musicdex: no MUSICDEX_API_KEY or HOLODEX_API_KEY — API path unavailable",
    );
    return [];
  }
  const allSongs = await fetchMusicdexDataset(key);
  if (!allSongs?.length) {
    console.log("musicdex: no songs found via API");
    return [];
  }
  console.log(`musicdex: ${allSongs.length} song(s) harvested via API`);
  return allSongs;
}

/* -------------------------------------------------------------------------- */
/* Profile-page path (Playwright)                                             */
/* -------------------------------------------------------------------------- */

/** Shape of the Musicdex channel discovery response, best effort. */
interface MusicdexChannelPayload {
  songs?: MusicdexSongEntry[];
  data?: MusicdexSongEntry[] | { songs?: MusicdexSongEntry[] };
  channel?: { songs?: MusicdexSongEntry[] };
  [key: string]: unknown;
}

/** Extracts song entries from whatever shape the discovery response takes. */
function extractSongsFromPayload(payload: unknown): MusicdexSongEntry[] {
  if (!payload || typeof payload !== "object") return [];
  const p = payload as MusicdexChannelPayload;

  const candidates: unknown[] = [];
  if (Array.isArray(p.songs)) candidates.push(p.songs);
  if (Array.isArray(p.data)) candidates.push(p.data);
  else if (p.data && typeof p.data === "object" && Array.isArray((p.data as { songs?: unknown[] }).songs)) {
    candidates.push((p.data as { songs?: unknown[] }).songs);
  }
  if (p.channel && typeof p.channel === "object" && Array.isArray((p.channel as { songs?: unknown[] }).songs)) {
    candidates.push((p.channel as { songs?: unknown[] }).songs);
  }

  for (const cand of candidates) {
    const songs = cand as MusicdexSongEntry[];
    if (songs.length > 0 && typeof songs[0]?.id === "string") {
      return songs;
    }
  }
  return [];
}

async function harvestViaProfiles(
  channelIds: string[],
  limit: number | null,
): Promise<MusicdexSongEntry[]> {
  const ids = limit ? channelIds.slice(0, limit) : channelIds;
  if (!ids.length) {
    console.log("musicdex: no channels to fetch profiles for");
    return [];
  }

  console.log(`musicdex: fetching ${ids.length} channel profile page(s) via Playwright`);

  const browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-software-rasterizer",
      "--disable-features=site-per-process,VizDisplayCompositor",
      "--no-first-run",
      "--no-zygote",
      "--single-process",
      "--disable-accelerated-2d-canvas",
    ],
  });

  const allSongs: MusicdexSongEntry[] = [];
  const seen = new Set<string>();

  try {
    const page = await browser.newPage();
    await page.setExtraHTTPHeaders({
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    });

    // Intercept the channel discovery API response and capture any songs.
    const pending = new Map<string, Promise<MusicdexSongEntry[]>>();
    page.on("response", (response) => {
      const url = response.url();
      if (!url.includes("/api/v2/musicdex/discovery/channel/")) return;
      pending.set(url, (async () => {
        try {
          return extractSongsFromPayload(await response.json());
        } catch {
          return [];
        }
      })());
    });

    for (const channelId of ids) {
      const url = `${MUSICDEX_BASE}/channel/${channelId}`;
      try {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
        await page.waitForTimeout(2500);

        // Resolve any discovery responses captured during this navigation.
        for (const [apiUrl, promise] of pending) {
          if (!apiUrl.includes(channelId)) continue;
          const songs = await promise;
          for (const song of songs) {
            if (song.id && !seen.has(song.id)) {
              seen.add(song.id);
              allSongs.push(song);
            }
          }
          pending.delete(apiUrl);
        }

        // Fallback: scrape rendered song rows from the DOM.
        const domSongs = await page.evaluate(() => {
          const rows: Array<{
            id?: string;
            song?: string;
            originalArtist?: string;
            category?: string;
          }> = [];
          const links = Array.from(
            document.querySelectorAll<HTMLElement>('a[href*="youtube.com/watch?v="], a[href*="youtu.be/"]'),
          );
          for (const link of links) {
            const href = link.getAttribute("href") ?? "";
            const m = href.match(/[?&]v=([A-Za-z0-9_-]{11})/) || href.match(/youtu\.be\/([A-Za-z0-9_-]{11})/);
            if (!m) continue;
            const row = link.closest("[role=row], tr, .song, [class*='song']") ?? link;
            const rowEl = row as HTMLElement;
          const text = rowEl.innerText ?? "";
            const parts = text.split(/\n/).map((t: string) => t.trim()).filter(Boolean);
            rows.push({
              id: m[1],
              song: parts[0] ?? undefined,
              originalArtist: parts.length > 1 ? parts[1] : undefined,
            });
          }
          return rows;
        });
        for (const s of domSongs) {
          if (s.id && !seen.has(s.id)) {
            seen.add(s.id);
            allSongs.push({
              id: s.id,
              song: s.song ?? "",
              originalArtist: s.originalArtist,
              channelId: undefined,
              channelName: undefined,
            } as MusicdexSongEntry);
          }
        }

        process.stdout.write(`  ${channelId}: +${allSongs.length} total\r`);
      } catch {
        // page failed — skip this channel
      }
    }
    console.log(); // newline after progress
  } finally {
    await browser.close();
  }

  console.log(`musicdex: ${allSongs.length} unique song(s) harvested via profiles`);
  return allSongs;
}

/** YouTube channel ids from the dataset, singers first. */
function datasetChannelIds(): string[] {
  const records = readAllChannelRecords();
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const record of records) {
    for (const platform of record.platforms) {
      if (platform.platform !== "youtube" || !platform.id) continue;
      const id = platform.id.replace(/^youtube:/, "");
      if (!id.startsWith("UC") || seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }
  }
  // Singers first so the bounded pass harvests the most song-rich channels.
  ids.sort((a, b) => {
    const ra = records.find((r) => r.platforms.some((p) => p.platform === "youtube" && p.id === a));
    const rb = records.find((r) => r.platforms.some((p) => p.platform === "youtube" && p.id === b));
    const sa = ra?.isSinging ? 0 : 1;
    const sb = rb?.isSinging ? 0 : 1;
    return sa - sb;
  });
  return ids;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  fs.mkdirSync(CACHE_DIR, { recursive: true });

  const hasKey = !!musicdexApiKey();
  const useApi = hasKey && !options.profileOnly;
  const useProfile = (!hasKey || options.profileOnly) && !options.apiOnly;

  let songs: MusicdexSongEntry[] = [];

  if (useApi) {
    songs = await harvestViaApi();
  }
  if (useProfile && songs.length === 0) {
    const channelIds = datasetChannelIds();
    songs = await harvestViaProfiles(channelIds, options.limit);
  }

  if (!songs.length) {
    console.log("musicdex: no songs found — writing empty snapshot");
    const snapshot = {
      generatedAt: new Date().toISOString(),
      source: "musicdex",
      count: 0,
      data: [],
    };
    fs.writeFileSync(OUT_PATH, JSON.stringify(snapshot, null, 2));
    console.log("musicdex: 0 song(s) harvested → " + OUT_PATH);
    return;
  }

  let limited = songs;
  if (options.limit && !useApi) limited = songs.slice(0, options.limit);

  const snapshot = {
    generatedAt: new Date().toISOString(),
    source: "musicdex",
    count: limited.length,
    data: limited,
  };

  fs.writeFileSync(OUT_PATH, JSON.stringify(snapshot, null, 2));
  console.log(
    `musicdex: ${limited.length} song(s) harvested → ${OUT_PATH}`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
