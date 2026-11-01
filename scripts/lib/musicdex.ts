/**
 * Musicdex (music.holodex.net) — curated song metadata from VTuber singing streams.
 *
 * Musicdex provides song-level tagging (song title, original artist, category)
 * extracted from VTuber singing streams. Each entry is keyed by a YouTube
 * video id.
 *
 * Musicdex is a client-side SPA — its HTML pages contain no song data. All
 * data comes from the API at https://music.holodex.net/api/v1/songs, which
 * requires MUSICDEX_API_KEY or HOLODEX_API_KEY. Without a key,
 * `fetchMusicdexDataset()` returns an empty array and the caller writes an
 * empty snapshot so the import step can proceed cleanly.
 */

export interface MusicdexSongEntry {
  /** YouTube video id. */
  id: string;
  /** Channel that uploaded the video. */
  channelId: string;
  /** Channel name. */
  channelName?: string;
  /** The performed song title. */
  song: string;
  /** The original artist. */
  originalArtist?: string;
  /** cover | mv | original | performance. */
  category?: string;
  /** ISO publish timestamp. */
  publishedAt?: string | null;
  /** Duration in seconds. */
  duration?: number | null;
  /** View count. */
  viewCount?: number | null;
  /** Thumbnail URL. */
  thumbnail?: string | null;
  /** True when this is a collaboration. */
  isCollab?: boolean;
}

const API_BASE = "https://music.holodex.net/api/v1";

/** Musicdex category values that map to our ItemCategory. */
export const MUSICDEX_CATEGORY_MAP: Record<
  string,
  "cover" | "mv" | "original" | "performance"
> = {
  cover: "cover",
  mv: "mv",
  original: "original",
  performance: "performance",
};

/** Item categories where Musicdex enrichment is allowed to overwrite. */
export const OVERWRITABLE_ITEM_CATEGORIES = new Set(["other", "live"]);

/** Fetch the Musicdex API key from the environment. */
export function musicdexApiKey(): string | null {
  return (
    process.env.MUSICDEX_API_KEY ?? process.env.HOLODEX_API_KEY ?? null
  );
}

/** Fetch one page of songs from the Musicdex API. */
async function fetchMusicdexPage(
  offset: number,
  limit: number,
  key: string,
): Promise<{ songs: MusicdexSongEntry[]; hasMore: boolean }> {
  const url = `${API_BASE}/songs?offset=${offset}&limit=${limit}`;
  try {
    const res = await fetch(url, {
      headers: {
        Accept: "application/json",
        "X-APIKEY": key,
        "User-Agent": "VSingerSingerTracker/1.0 (dataset builder)",
      },
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status === 403) {
      console.error(
        "musicdex: 403 Forbidden — MUSICDEX_API_KEY/HOLODEX_API_KEY is required",
      );
      return { songs: [], hasMore: false };
    }
    if (!res.ok) {
      console.error(`musicdex: HTTP ${res.status}`);
      return { songs: [], hasMore: false };
    }
    const data = (await res.json()) as {
      songs?: MusicdexSongEntry[];
      hasMore?: boolean;
    };
    return {
      songs: data.songs ?? [],
      hasMore: data.hasMore ?? false,
    };
  } catch (err) {
    console.error(
      `musicdex: fetch failed at offset ${offset}: ${(err as Error).message}`,
    );
    return { songs: [], hasMore: false };
  }
}

/**
 * Fetches all songs from the Musicdex API.
 *
 * Returns an empty array when no API key is configured or the source
 * returns no songs.
 */
export async function fetchMusicdexDataset(
  key?: string | null,
): Promise<MusicdexSongEntry[]> {
  const apiKey = key ?? musicdexApiKey();
  if (!apiKey) return [];

  const PAGE_SIZE = 100;
  let offset = 0;
  const allSongs: MusicdexSongEntry[] = [];
  const seen = new Set<string>();

  while (true) {
    const { songs, hasMore } = await fetchMusicdexPage(
      offset,
      PAGE_SIZE,
      apiKey,
    );
    if (!songs.length) break;

    for (const song of songs) {
      if (seen.has(song.id)) continue;
      seen.add(song.id);
      allSongs.push(song);
    }

    if (!hasMore) break;
    offset += PAGE_SIZE;
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  return allSongs.length ? allSongs : [];
}
