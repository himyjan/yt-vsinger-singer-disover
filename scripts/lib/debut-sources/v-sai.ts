/**
 * V-SLive discovery source.
 *
 * v-sai.com/vtuber is a Vietnamese VTuber directory that lists VTubers
 * with their YouTube channel information via a ConnectRPC JSON API at
 * `https://api.v-sai.com/api.vtubers.v1.VtuberProfilesService/GetAllVtuberProfiles`.
 *
 * No authentication required.
 */

import { fetchJson } from "../io";
import type { Candidate } from "../identity";
import type { DebutSource } from "./types";
import type { RegionCode } from "../types";

const API_BASE = "https://api.v-sai.com";

interface VtuberProfile {
  id: string;
  userId: string;
  displayName: string;
  furigana?: string;
  image?: string;
  bannerImage?: string;
  socialMediaLinks?: {
    twitter?: string;
    youtube?: string;
  };
  description?: string;
  username?: string;
  isPublished?: boolean;
}

export class VSaiSource implements DebutSource {
  readonly id = "v-sai";
  readonly label = "V-SLive VTuber";

  constructor(private readonly limit = 100) {}

  isConfigured(): boolean {
    return true;
  }

  unavailableReason(): string | null {
    return null;
  }

  async fetch(_since: string | null): Promise<Candidate[]> {
    try {
      const res = await fetch(
        `${API_BASE}/api.vtubers.v1.VtuberProfilesService/GetAllVtuberProfiles`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({ offset: 0, size: this.limit }),
        },
      );
      if (!res.ok) return [];
      const data = (await res.json()) as { data?: VtuberProfile[] };
      const profiles = data?.data ?? [];

      const candidates: Candidate[] = [];
      for (const ch of profiles) {
        const ytUrl = ch.socialMediaLinks?.youtube;
        if (!ytUrl) continue;

        // Extract YouTube handle from URL like https://youtube.com/@handle
        const m = ytUrl.match(/youtube\.com\/@([A-Za-z0-9_.-]+)/i);
        if (!m) continue;

        candidates.push({
          id: `youtube:@${m[1]}`,
          name: ch.displayName || null,
          handle: m[1],
          region: null,
          affiliation: null,
          debutDate: null,
          graduateDate: null,
          externals: { youtube: [m[1]] },
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
