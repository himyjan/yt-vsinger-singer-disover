/**
 * Virtual Live Calendar discovery source.
 *
 * virtualhumans.org/vtubers is a directory of VTubers from around the world
 * with information about their YouTube channels, social media, and debut dates.
 *
 * No authentication required.
 */

import { fetchJson } from "../io";
import type { Candidate } from "../identity";
import type { DebutSource } from "./types";
import type { RegionCode } from "../types";

const API_BASE = "https://virtualhumans.org";

interface VirtualHumansChannel {
  channel_id?: string;
  name?: string;
  description?: string;
  thumbnail?: string | null;
  subscribers?: number;
  published_at?: string;
  region?: string | null;
  gender?: string | null;
  languages?: string[];
}

export class VirtualHumansSource implements DebutSource {
  readonly id = "virtualhumans";
  readonly label = "VirtualHumans";

  constructor(private readonly limit = 200) {}

  isConfigured(): boolean {
    return true;
  }

  unavailableReason(): string | null {
    return null;
  }

  async fetch(_since: string | null): Promise<Candidate[]> {
    const res = await this.fetchJson<{ data?: VirtualHumansChannel[] }>(
      `${API_BASE}/api/vtubers?limit=${this.limit}`
    );
    if (!res?.data) return [];

    const candidates: Candidate[] = [];
    for (const ch of res.data) {
      if (!ch.channel_id) continue;

      candidates.push({
        id: `youtube:${ch.channel_id}`,
        name: ch.name ?? null,
        handle: null,
        region: (ch.region ?? null) as RegionCode | null | undefined,
        affiliation: null,
        debutDate: ch.published_at ?? null,
        graduateDate: null,
        externals: { youtube: [ch.channel_id] },
        wikiPage: null,
        source: this.id,
      });
    }

    return candidates;
  }

  private async fetchJson<T>(url: string): Promise<T | null> {
    try {
      const res = await fetch(url, {
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
