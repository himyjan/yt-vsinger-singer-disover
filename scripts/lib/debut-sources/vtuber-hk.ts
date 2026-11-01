/**
 * Harvest VTuber channels from vtuber.hk directory.
 *
 * vtuber.hk publishes channel data at:
 *   https://vtuber.hk/api/channels
 * Returns channels with youtube_id, name, description, thumbnail, subscribers, etc.
 *
 * No authentication required.
 */

import { fetchJson } from "../io";
import type { Candidate } from "../identity";
import type { DebutSource } from "./types";
import type { RegionCode } from "../types";

const API_BASE = "https://vtuber.hk/api";

interface VtuberHkChannel {
  youtube_id?: string;
  name?: string;
  description?: string;
  thumbnail?: string | null;
  subscribers?: number;
  view_count?: number;
  video_count?: number;
  debut_date?: string | null;
  region?: string | null;
  gender?: string | null;
  languages?: string[];
}

export class VtuberHkSource implements DebutSource {
  readonly id = "vtuberhk";
  readonly label = "vtuber.hk";

  constructor(private readonly limit = 200) {}

  isConfigured(): boolean {
    return true;
  }

  unavailableReason(): string | null {
    return null;
  }

  async fetch(_since: string | null): Promise<Candidate[]> {
    const res = await this.fetchJson<{ data?: VtuberHkChannel[] }>(
      `${API_BASE}/channels?limit=${this.limit}`,
    );
    if (!res?.data) return [];

    const candidates: Candidate[] = [];
    for (const ch of res.data) {
      if (!ch.youtube_id) continue;

      candidates.push({
        id: `youtube:${ch.youtube_id}`,
        name: ch.name || null,
        handle: null,
        region: (ch.region ?? null) as RegionCode | null | undefined,
        affiliation: null,
        debutDate: ch.debut_date ?? null,
        graduateDate: null,
        externals: { youtube: [ch.youtube_id] },
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
