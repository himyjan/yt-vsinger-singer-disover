#!/usr/bin/env tsx
/**
 * Harvest channel profiles and songs from Musicdex (music.holodex.net).
 *
 * Musicdex is the music layer of Holodex — it provides curated song-level
 * tagging (song title, original artist, category) extracted from VTuber
 * singing streams, plus channel profiles (name, org, avatar, subscriber
 * count, …). Each song is keyed by a YouTube video id; each channel by a
 * YouTube channel id.
 *
 * The public API at https://music.holodex.net/api/v2/ requires no key but
 * needs browser-like headers (User-Agent, Referer, Origin). When
 * MUSICDEX_API_KEY / HOLODEX_API_KEY is set, the legacy
 * https://music.holodex.net/api/v1/songs path is used instead (it returns
 * the full song catalogue).
 *
 *   npm run data:musicdex              # harvest via public API (or API key if set)
 *   npm run data:musicdex -- --api-key-only   # force the keyed API path
 *   npm run data:musicdex -- --public-only    # force the public API path
 *   npm run data:musicdex -- --limit-orgs 5   # only process n orgs (for testing)
 *
 * Nothing here writes data/ — importing is a separate step through
 * `npm run data:musicdex-import`.
 */

import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const BASE = "https://music.holodex.net";
const PUBLIC_API = `${BASE}/api/v2`;
const CACHE_DIR = ".cache/musicdex";
const OUT_PATH = path.join(CACHE_DIR, "musicdex.json");

const KNOWN_ORGS = [
  "Hololive",
  "Independents",
  "Nijisanji",
  "Riot Music",
  "KAMITSUBAKI",
  "774inc",
  "GuildCQ",
  "ReAcT",
];

const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept: "application/json",
  Referer: `${BASE}/`,
  Origin: BASE,
};

interface Options {
  limitOrgs: number | null;
  apiKeyOnly: boolean;
  publicOnly: boolean;
}

function parseArgs(argv: string[]): Options {
  const options: Options = { limitOrgs: null, apiKeyOnly: false, publicOnly: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const value = argv[i + 1];
    switch (arg) {
      case "--limit-orgs":
        options.limitOrgs = Math.max(1, Number(value ?? 1));
        i++;
        break;
      case "--api-key-only":
        options.apiKeyOnly = true;
        break;
      case "--public-only":
        options.publicOnly = true;
        break;
      case "--help":
      case "-h":
        console.log(
          [
            "Usage: npm run data:musicdex [options]",
            "",
            "  --api-key-only   force the keyed API path (requires MUSICDEX_API_KEY / HOLODEX_API_KEY)",
            "  --public-only    force the public API path (no key needed)",
            "  --limit-orgs <n> only process n orgs (testing)",
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
/* Legacy keyed API                                                           */
/* -------------------------------------------------------------------------- */

import {
  fetchMusicdexDataset,
  musicdexApiKey,
  type MusicdexSongEntry,
} from "../scripts/lib/musicdex";

async function harvestViaKeyedApi(): Promise<{
  channels: MusicdexChannel[];
  songs: MusicdexSong[];
}> {
  const key = musicdexApiKey();
  if (!key) {
    return { channels: [], songs: [] };
  }
  const songs = await fetchMusicdexDataset(key);
  // The keyed API returns songs only; derive channel profiles from song data.
  const byChannel = new Map<string, MusicdexChannel>();
  for (const s of songs) {
    const existing = byChannel.get(s.channelId);
    if (existing) continue;
    byChannel.set(s.channelId, {
      id: s.channelId,
      name: s.channelName ?? "",
      org: null,
      group: null,
      photo: null,
      twitter: null,
      videoCount: null,
      subscriberCount: null,
      topTopics: [],
      inactive: false,
      extraIds: [],
    });
  }
  return {
    channels: [...byChannel.values()],
    songs: songs.map((s) => ({
      videoId: s.id,
      channelId: s.channelId,
      name: s.song,
      originalArtist: s.originalArtist ?? null,
      isMv: s.category === "mv",
      availableAt: s.publishedAt ?? null,
    })),
  };
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

interface MusicdexChannel {
  id: string;
  name: string;
  englishName?: string | null;
  org?: string | null;
  group?: string | null;
  photo?: string | null;
  twitter?: string | null;
  videoCount?: number | null;
  subscriberCount?: number | null;
  topTopics?: string[];
  inactive?: boolean;
  extraIds?: string[];
}

interface MusicdexSong {
  videoId: string;
  channelId: string;
  name: string;
  originalArtist?: string | null;
  isMv?: boolean;
  availableAt?: string | null;
}

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: BROWSER_HEADERS,
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  return res.json();
}

async function fetchOrgs(): Promise<string[]> {
  // Try the org discovery endpoint first.
  try {
    const body = (await fetchJson(`${PUBLIC_API}/musicdex/discovery/org/`)) as any;
    if (body && Array.isArray(body.orgs)) {
      return body.orgs.map((o: any) => o.name || o.id || o).filter(Boolean);
    }
    if (body && typeof body === "object") {
      const keys = Object.keys(body);
      const orgs = keys.filter((k) => /[A-Za-z]/.test(k));
      if (orgs.length > 0) return orgs;
    }
  } catch {
    // fall through to homepage scraping
  }

  // Fallback: scrape org names from the homepage navigation.
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-software-rasterizer",
    ],
  });
  let discovered: string[] = [];
  try {
    const page = await browser.newPage();
    await page.setExtraHTTPHeaders({
      "User-Agent": BROWSER_HEADERS["User-Agent"]!,
    });
    await page.goto(`${BASE}/`, {
      waitUntil: "domcontentloaded",
      timeout: 45000,
    });
    await page.waitForTimeout(3000);

    discovered = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll<HTMLElement>("a"));
      const names = new Set<string>();
      for (const link of links) {
        const href = link.getAttribute("href") ?? "";
        // Real org links have the form /org/<org-name>
        const m = href.match(/^\/org\/([^/]+)/);
        if (m) {
          names.add(decodeURIComponent(m[1]));
        }
      }
      return [...names];
    });
  } finally {
    await browser.close();
  }

  // Merge discovered orgs with known orgs (deduped).
  const allOrgs = [...new Set([...KNOWN_ORGS, ...discovered])];
  return allOrgs;
}

async function fetchChannelsForOrg(org: string): Promise<MusicdexChannel[]> {
  const channels: MusicdexChannel[] = [];
  let offset = 0;
  const limit = 100;

  for (;;) {
    const url = `${PUBLIC_API}/channels?type=vtuber&org=${encodeURIComponent(org)}&limit=${limit}&offset=${offset}&sort=suborg`;
    const body = (await fetchJson(url)) as any[];
    if (!Array.isArray(body) || body.length === 0) break;

    for (const c of body) {
      channels.push({
        id: c.id,
        name: c.name ?? c.id,
        englishName: c.english_name ?? null,
        org: c.org ?? org,
        group: c.group ?? null,
        photo: c.photo ?? null,
        twitter: c.twitter ?? null,
        videoCount: c.video_count ?? null,
        subscriberCount: c.subscriber_count ?? null,
        topTopics: Array.isArray(c.top_topics) ? c.top_topics : [],
        inactive: c.inactive === true,
        extraIds: Array.isArray(c.extra_ids) ? c.extra_ids : [],
      });
    }

    if (body.length < limit) break;
    offset += limit;
  }

  return channels;
}

async function fetchSongsForOrg(org: string): Promise<MusicdexSong[]> {
  const url = `${PUBLIC_API}/songs/hot?org=${encodeURIComponent(org)}`;
  const body = (await fetchJson(url)) as any[];
  if (!Array.isArray(body)) return [];

  return body.map((s) => ({
    videoId: s.video_id,
    channelId: s.channel_id,
    name: s.name ?? "",
    originalArtist: s.original_artist ?? null,
    isMv: s.is_mv === true,
    availableAt: s.available_at ?? null,
  }));
}

async function harvestViaPublicApi(
  limitOrgs: number | null,
): Promise<{ channels: MusicdexChannel[]; songs: MusicdexSong[] }> {
  const orgs = await fetchOrgs();
  console.log(`musicdex: discovered ${orgs.length} org(s): ${orgs.join(", ")}`);

  const limitedOrgs = limitOrgs ? orgs.slice(0, limitOrgs) : orgs;

  const allChannels: MusicdexChannel[] = [];
  const allSongs: MusicdexSong[] = [];

  for (const org of limitedOrgs) {
    console.log(`musicdex: fetching channels for org "${org}"`);
    try {
      const channels = await fetchChannelsForOrg(org);
      console.log(`  ${channels.length} channel(s)`);
      allChannels.push(...channels);
    } catch (err) {
      console.error(
        `  failed to fetch channels for ${org}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    console.log(`musicdex: fetching songs for org "${org}"`);
    try {
      const songs = await fetchSongsForOrg(org);
      console.log(`  ${songs.length} song(s)`);
      allSongs.push(...songs);
    } catch (err) {
      console.error(
        `  failed to fetch songs for ${org}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Deduplicate channels by id.
  const channelMap = new Map<string, MusicdexChannel>();
  for (const c of allChannels) {
    if (!channelMap.has(c.id)) channelMap.set(c.id, c);
  }

  // Deduplicate songs by video_id.
  const songMap = new Map<string, MusicdexSong>();
  for (const s of allSongs) {
    if (!songMap.has(s.videoId)) songMap.set(s.videoId, s);
  }

  return {
    channels: [...channelMap.values()],
    songs: [...songMap.values()],
  };
}

/* -------------------------------------------------------------------------- */
/* Main                                                                       */
/* -------------------------------------------------------------------------- */

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  fs.mkdirSync(CACHE_DIR, { recursive: true });

  const useKeyed = !options.publicOnly && !!musicdexApiKey();
  const usePublic = !options.apiKeyOnly;

  let channels: MusicdexChannel[] = [];
  let songs: MusicdexSong[] = [];

  if (useKeyed) {
    console.log("musicdex: using keyed API (MUSICDEX_API_KEY / HOLODEX_API_KEY)");
    const result = await harvestViaKeyedApi();
    channels = result.channels;
    songs = result.songs;
  }

  if (usePublic && (channels.length === 0 || songs.length === 0)) {
    console.log("musicdex: using public API (no key or keyed path empty)");
    const result = await harvestViaPublicApi(options.limitOrgs);
    // Merge: public API takes precedence for channels (has full profiles),
    // keyed API songs are kept if public path returned none.
    if (result.channels.length > 0) channels = result.channels;
    if (result.songs.length > 0) songs = result.songs;
  }

  if (!channels.length && !songs.length) {
    console.log("musicdex: no data found — writing empty snapshot");
    const snapshot = {
      generatedAt: new Date().toISOString(),
      source: "musicdex",
      count: 0,
      channels: [],
      songs: [],
    };
    fs.writeFileSync(OUT_PATH, JSON.stringify(snapshot, null, 2));
    console.log("musicdex: 0 channel(s), 0 song(s) harvested → " + OUT_PATH);
    return;
  }

  const snapshot = {
    generatedAt: new Date().toISOString(),
    source: "musicdex",
    count: channels.length,
    channels,
    songs,
    songCount: songs.length,
  };

  fs.writeFileSync(OUT_PATH, JSON.stringify(snapshot, null, 2));
  console.log(
    `musicdex: ${channels.length} channel(s), ${songs.length} song(s) harvested → ${OUT_PATH}`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
