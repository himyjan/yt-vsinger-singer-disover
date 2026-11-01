/**
 * Bilibili discovery source.
 *
 * Bilibili's 虚拟主播 (VTuber) partition ranking (`rid=160`) publishes the
 * top VTuber channels on the platform. This source reads that ranking and
 * publishes each entry as a candidate.
 *
 * No authentication required — the ranking endpoint is public.
 */

import { fetchJson } from "../io";
import type { Candidate } from "../identity";
import type { DebutSource } from "./types";

const API = "https://api.bilibili.com";
const VTUBER_PARTITION = 160;

interface BiliRankingEntry {
  mid: number;
  uname: string;
  face?: string;
  sign?: string;
  pts?: number;
}

export class BilibiliSource implements DebutSource {
  readonly id = "bilibili";
  readonly label = "Bilibili";

  constructor(private readonly limit = 100) {}

  isConfigured(): boolean {
    return true;
  }

  unavailableReason(): string | null {
    return null;
  }

  async fetch(_since: string | null): Promise<Candidate[]> {
    const res = await fetchJson<{
      data?: { list?: BiliRankingEntry[] };
    }>(
      `${API}/x/web-interface/ranking/v2?rid=${VTUBER_PARTITION}&type=1&arc_type=0&jsonp=jsonp`,
    );
    if (!res?.data?.list) return [];

    const candidates: Candidate[] = [];
    for (const entry of res.data.list.slice(0, this.limit)) {
      if (!entry.mid) continue;

      candidates.push({
        id: `bilibili:${entry.mid}`,
        name: entry.uname || null,
        handle: null,
        region: null,
        affiliation: null,
        debutDate: null,
        graduateDate: null,
        externals: { bilibili: [String(entry.mid)] },
        wikiPage: null,
        source: this.id,
      });
    }

    return candidates;
  }
}
