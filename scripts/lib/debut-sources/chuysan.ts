/**
 * Chuysan Thai VTuber Ranking debut source.
 *
 * Chuysan maintains a directory of Thai VTubers at vtuber.chuysan.com,
 * backed by a public JSON API hosted on Google Cloud Storage. The API
 * publishes every VTuber channel registered in their database, with
 * channel id, title, description, subscriber count, publish date and
 * more — no authentication or rate limit.
 *
 * API docs: https://chuymaster.github.io/thaivtuberranking-docs/
 * Base URL: https://storage.googleapis.com/thaivtuberranking.appspot.com/
 *
 * The `simple_list.json` endpoint returns every channel in the catalogue,
 * which is small enough (a few thousand entries) to fetch in one request.
 * Each entry carries a YouTube channel id (`channel_id`), title, thumbnail,
 * subscriber count, publish date and update timestamp — enough to create a
 * dataset record with `kind: "virtual"` and `region: "sea"`.
 */

import type { Candidate } from "../identity";
import type { DebutSource } from "./types";

const API_BASE = "https://storage.googleapis.com/thaivtuberranking.appspot.com";

/** One entry from the simple list endpoint. */
interface ChuysanChannel {
  channel_id: string;
  title: string;
  description?: string;
  thumbnail_icon_url?: string;
  subscribers?: number;
  views?: number;
  published_at?: string;
  last_published_video_at?: string | null;
  updated_at?: number;
  is_rebranded?: boolean;
  uploads?: string;
}

export class ChuysanSource implements DebutSource {
  readonly id = "chuysan";
  readonly label = "Chuysan Thai VTuber Directory";

  private readonly baseUrl: string;

  constructor(options: { baseUrl?: string } = {}) {
    this.baseUrl = options.baseUrl ?? API_BASE;
  }

  isConfigured(): boolean {
    return true;
  }

  unavailableReason(): string | null {
    return null;
  }

  async fetch(_since: string | null): Promise<Candidate[]> {
    const res = await this.fetchJson<{ result: ChuysanChannel[] }>(
      `${this.baseUrl}/v2/channel_data/simple_list.json`,
    );
    if (!res || !Array.isArray(res.result)) {
      return [];
    }

    const candidates: Candidate[] = [];
    for (const row of res.result) {
      if (!row.channel_id || !/^UC[\w-]{20,}$/.test(row.channel_id)) continue;

      candidates.push({
        id: row.channel_id,
        name: row.title || null,
        handle: null,
        region: "sea",
        affiliation: null,
        debutDate: row.published_at ?? null,
        graduateDate: null,
        externals: { youtube: [row.channel_id] },
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
