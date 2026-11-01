/**
 * CHZZK discovery source.
 *
 * CHZZK exposes channel listings:
 *   GET https://api.chzzk.naver.com/service/v1.0/channels?categoryCode=...&size=...
 * Returns channels with channelId, channelName, profileImage, followerCount, etc.
 *
 * No authentication required for basic channel listing.
 */

import { fetchJson } from "../io";
import type { Candidate } from "../identity";
import type { DebutSource } from "./types";

const CHZZK_API = "https://api.chzzk.naver.com/service/v1.0";

interface ChzzkChannel {
  channelId: string;
  channelName: string;
  channelImageUrl?: string;
  followerCount?: number;
  categoryValue?: string;
}

export class ChzzkSource implements DebutSource {
  readonly id = "chzzk";
  readonly label = "CHZZK";

  constructor(private readonly limit = 200) {}

  isConfigured(): boolean {
    return true;
  }

  unavailableReason(): string | null {
    return null;
  }

  async fetch(_since: string | null): Promise<Candidate[]> {
    const res = await this.fetchJson<{ content: ChzzkChannel[] }>(
      `${CHZZK_API}/channels?categoryCode=GAME&size=${this.limit}`,
    );
    if (!res?.content) return [];

    const candidates: Candidate[] = [];
    for (const ch of res.content) {
      if (!ch.channelId) continue;

      candidates.push({
        id: `chzzk:${ch.channelId}`,
        name: ch.channelName || null,
        handle: null,
        region: null,
        affiliation: null,
        debutDate: null,
        graduateDate: null,
        externals: { chzzk: [ch.channelId] },
        wikiPage: null,
        source: this.id,
      });
    }

    return candidates;
  }

  private async fetchJson<T>(path: string): Promise<T | null> {
    try {
      const res = await fetch(`${CHZZK_API}/${path}`, {
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
