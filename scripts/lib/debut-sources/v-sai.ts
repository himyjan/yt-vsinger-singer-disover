/**
 * V-SLive discovery source.
 *
 * v-sai.com/vtuber is a Vietnamese VTuber directory that lists VTubers
 * with their YouTube channel information.
 *
 * No authentication required.
 */

import { fetchJson } from "../io";
import type { Candidate } from "../identity";
import type { DebutSource } from "./types";
import type { RegionCode } from "../types";

const API_BASE = "https://www.v-sai.com";

interface VSaiChannel {
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

export class VSaiSource implements DebutSource {
  readonly id = "v-sai";
  readonly label = "V-SLive VTuber";

  constructor(private readonly limit = 200) {}

  isConfigured(): boolean {
    return true;
  }

  unavailableReason(): string | null {
    return null;
  }

  async fetch(_since: string | null): Promise<Candidate[]> {
    const res = await this.fetchJson<{ data?: VSaiChannel[] }>(
      `${API_BASE}/vtuber?size=9999999`
    );
    if (!res?.data) return [];

    const candidates: Candidate[] = [];
    for (const ch of res.data) {
      if (!ch.channel_id) continue;

      candidates.push({
        id: `youtube:${ch.channel_id}`,
        name: ch.name || null,
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
