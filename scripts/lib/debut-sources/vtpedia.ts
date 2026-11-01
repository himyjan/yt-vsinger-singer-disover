/**
 * VTuber.pedia discovery source.
 *
 * vtpedia.com publishes VTuber channel data as static JSON:
 *   https://vtpedia.com/data/vtubers.json
 *
 * Each entry carries a YouTube channel id and an internal UUID.
 * Entries are keyed by `vtpedia:<uuid>` and also carry `youtube:<UC…>` as an
 * external so they can be matched against the dataset.
 *
 * No authentication required.
 */

import { fetchJson } from "../io";
import type { Candidate } from "../identity";
import type { DebutSource } from "./types";
import type { RegionCode } from "../types";

const SOURCE_URL = "https://vtpedia.com/data/vtubers.json";

interface VtpediaVTuber {
  id: string;
  activity: string;
  name: string;
  imgUrl?: string;
  YouTube?: {
    subscriber: { tag: string; count: number };
    id: string;
  } | null;
  Twitch?: {
    follower: { tag: string; count: number };
    id: string;
  } | null;
  popularVideo?: {
    type: string;
    id: string;
  };
  nationality?: string;
  debutDate?: string;
}

interface VtpediaApiResponse {
  VTubers: VtpediaVTuber[];
}

export class VtpediaSource implements DebutSource {
  readonly id = "vtpedia";
  readonly label = "VTuberpedia";

  constructor(private readonly limit = 200) {}

  isConfigured(): boolean {
    return true;
  }

  unavailableReason(): string | null {
    return null;
  }

  async fetch(_since: string | null): Promise<Candidate[]> {
    try {
      const res = await fetchJson<VtpediaApiResponse>(SOURCE_URL);
      if (!res?.VTubers) return [];

      const vtubers = res.VTubers.slice(0, this.limit);

      const candidates: Candidate[] = [];
      for (const ch of vtubers) {
        candidates.push({
          id: `vtpedia:${ch.id}`,
          name: ch.name || null,
          handle: ch.YouTube?.id ?? null,
          region: (ch.nationality ?? null) as RegionCode | null | undefined,
          affiliation: null,
          debutDate: ch.debutDate ?? null,
          graduateDate:
            ch.activity?.includes("畢業") || ch.activity?.includes("graduated")
              ? ch.debutDate ?? null
              : null,
          externals: {
            ...(ch.YouTube?.id ? { youtube: [ch.YouTube.id] } : {}),
            ...(ch.Twitch?.id ? { twitch: [ch.Twitch.id] } : {}),
          },
          wikiPage: null,
          source: this.id,
        });
      }

      return candidates;
    } catch {
      return [];
    }
  }
}
