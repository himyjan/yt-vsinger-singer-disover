/**
 * Niconico discovery source.
 *
 * Niconico's Content Search API v2 can list live streams and videos:
 *   GET https://api.search.nicovideo.jp/api/v2/search?query=&type=video&filters[liveStatus]=onair
 * Returns videos with content_id, title, user_id, user_nickname, etc.
 *
 * No authentication required.
 */

import { fetchJson } from "../io";
import type { Candidate } from "../identity";
import type { DebutSource } from "./types";

const SEARCH_API = "https://api.search.nicovideo.jp/api/v2/search";

interface NicoVideo {
  contentId: string;
  title?: string;
  description?: string;
  viewCounter?: number;
  startTime?: number;
  userId?: string;
  userNickname?: string;
}

export class NiconicoSource implements DebutSource {
  readonly id = "niconico";
  readonly label = "Niconico";

  constructor(private readonly limit = 200) {}

  isConfigured(): boolean {
    return true;
  }

  unavailableReason(): string | null {
    return null;
  }

  async fetch(_since: string | null): Promise<Candidate[]> {
    const res = await this.fetchJson<{ data: NicoVideo[] }>(
      `${SEARCH_API}?query=&type=video&filters%5BliveStatus%5D%5B0%5D=onair&_sort=-viewCounter&_limit=${this.limit}`,
    );
    if (!res?.data) return [];

    const candidates: Candidate[] = [];
    for (const video of res.data) {
      if (!video.contentId) continue;

      candidates.push({
        id: `niconico:${video.contentId}`,
        name: video.title || null,
        handle: null,
        region: null,
        affiliation: null,
        debutDate: null,
        graduateDate: null,
        externals: { niconico: [video.contentId] },
        wikiPage: null,
        source: this.id,
      });
    }

    return candidates;
  }

  private async fetchJson<T>(path: string): Promise<T | null> {
    try {
      const res = await fetch(path, {
        signal: AbortSignal.timeout(30_000),
        headers: {
          "User-Agent": "yt-vsinger-singer-tracker/1.0 (dataset builder)",
          Accept: "application/json",
        },
      });
      if (!res.ok) return null;
      return (await res.json()) as T;
    } catch {
      return null;
    }
  }
}
