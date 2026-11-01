/**
 * VTuber Database (vtuber-database.wikiru.jp) debut source.
 *
 * vtuber-database.wikiru.jp is a Japanese VTuber database wiki.
 * It does not provide a public API, so we scrape the channel listing pages.
 *
 * The site lists VTubers with their YouTube channel URLs and basic info.
 * Each entry page contains detailed information including YouTube channel URL,
 * Twitter/X handle, debut date, and other social media links.
 */

import { fetchJson } from "../io";
import type { Candidate } from "../identity";
import type { DebutSource } from "./types";
import type { RegionCode } from "../types";

const VDB_URL = "https://vtuber-database.wikiru.jp";

interface VdbChannel {
  channel_id?: string;
  title?: string;
  description?: string;
  thumbnail?: string | null;
  subscribers?: number;
  published_at?: string;
  region?: string | null;
  gender?: string | null;
  languages?: string[];
}

export class VdbSource implements DebutSource {
  readonly id = "vdb";
  readonly label = "vtuber-database.wikiru.jp";

  constructor(private readonly limit = 200) {}

  isConfigured(): boolean {
    return true;
  }

  unavailableReason(): string | null {
    return null;
  }

  async fetch(_since: string | null): Promise<Candidate[]> {
    const res = await this.fetchJson<{ data?: VdbChannel[] }>(
      `${VDB_URL}/api/channels?limit=${this.limit}`
    );
    if (!res?.data) return [];

    const candidates: Candidate[] = [];
    for (const ch of res.data) {
      if (!ch.channel_id) continue;

      candidates.push({
        id: `youtube:${ch.channel_id}`,
        name: ch.title ?? null,
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
