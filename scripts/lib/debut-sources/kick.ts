/**
 * KICK discovery source.
 *
 * KICK exposes a channel directory API:
 *   GET https://kick.com/api/v2/channels?category=...&limit=...
 * Returns channels with id, username, title, description, viewer_count, etc.
 *
 * No authentication required for basic channel listing.
 */

import { fetchJson } from "../io";
import type { Candidate } from "../identity";
import type { DebutSource } from "./types";

const KICK_API = "https://kick.com/api/v2";

interface KickChannel {
  id: string;
  username: string;
  title: string;
  description: string | null;
  viewer_count: number | null;
  categories: Array<{ name: string }>;
  thumbnail_url?: string | null;
}

export class KickSource implements DebutSource {
  readonly id = "kick";
  readonly label = "KICK";

  constructor(private readonly limit = 200) {}

  isConfigured(): boolean {
    return true;
  }

  unavailableReason(): string | null {
    return null;
  }

  async fetch(_since: string | null): Promise<Candidate[]> {
    const res = await fetchJson<{ data?: KickChannel[] }>(`channels?limit=${this.limit}`);
    if (!res?.data) return [];

    const candidates: Candidate[] = [];
    for (const ch of res.data) {
      if (!ch.id) continue;

      candidates.push({
        id: `kick:${ch.id}`,
        name: ch.title || ch.username || null,
        handle: ch.username || null,
        region: null,
        affiliation: null,
        debutDate: null,
        graduateDate: null,
        externals: { kick: [ch.id] },
        wikiPage: null,
        source: this.id,
      });
    }

    return candidates;
  }

  private async fetchJson<T>(path: string): Promise<T | null> {
    try {
      const res = await fetch(`${KICK_API}/${path}`, {
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
