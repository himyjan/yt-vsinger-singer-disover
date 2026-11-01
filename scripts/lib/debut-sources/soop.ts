/**
 * SOOP discovery source.
 *
 * SOOP exposes live broadcast list:
 *   GET https://live.sooplive.co.kr/api/main_broad_list_api.php?main_category_code=...
 * Returns streams with channel id, title, broadcaster name, viewer count, etc.
 *
 * No authentication required.
 */

import { fetchJson } from "../io";
import type { Candidate } from "../identity";
import type { DebutSource } from "./types";

const SOOP_API = "https://live.sooplive.co.kr/api/main_broad_list_api.php";

interface SoopStream {
  station_id?: string;
  channel_id?: string;
  broadcaster_id?: string;
  title?: string;
  broadcaster_name?: string;
  viewer_count?: number;
}

export class SoopSource implements DebutSource {
  readonly id = "soop";
  readonly label = "SOOP";

  constructor(private readonly limit = 200) {}

  isConfigured(): boolean {
    return true;
  }

  unavailableReason(): string | null {
    return null;
  }

  async fetch(_since: string | null): Promise<Candidate[]> {
    const res = await this.fetchJson<{ data?: SoopStream[] }>(
      `${SOOP_API}?main_category_code=GAME&sub_category_code=&sort=popular&rows=${this.limit}`,
    );
    if (!res?.data) return [];

    const candidates: Candidate[] = [];
    for (const stream of res.data) {
      if (!stream.channel_id) continue;

      candidates.push({
        id: `soop:${stream.channel_id}`,
        name: stream.title || null,
        handle: stream.broadcaster_id || null,
        region: null,
        affiliation: null,
        debutDate: null,
        graduateDate: null,
        externals: { soop: [stream.channel_id] },
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
