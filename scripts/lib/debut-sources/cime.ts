/**
 * CI.ME discovery source.
 *
 * CI.ME publishes a public channel list at
 *   https://ci.me/api/openapi/open/v1/channels
 * Returns all registered CI.ME channels with id, name, avatar, etc.
 *
 * No authentication needed for the channel list endpoint.
 * Live status requires a separate public endpoint per channel.
 */

import { fetchJson } from "../io";
import type { Candidate } from "../identity";
import type { DebutSource } from "./types";

const CI_ME_API = "https://ci.me/api/openapi/open/v1/channels";

interface CiMeChannel {
  id: string;
  name: string;
  avatar?: string | null;
  description?: string | null;
  followers?: number;
  category?: string | null;
}

export class CiMeSource implements DebutSource {
  readonly id = "cime";
  readonly label = "CI.ME";

  constructor(private readonly limit = 200) {}

  isConfigured(): boolean {
    return true;
  }

  unavailableReason(): string | null {
    return null;
  }

  async fetch(_since: string | null): Promise<Candidate[]> {
    const res = await fetchJson<{ data: CiMeChannel[] }>(`${CI_ME_API}?limit=${this.limit}`);
    if (!res?.data) return [];

    const candidates: Candidate[] = [];
    for (const ch of res.data) {
      if (!ch.id) continue;

      candidates.push({
        id: `cime:${ch.id}`,
        name: ch.name || null,
        handle: null,
        region: null,
        affiliation: null,
        debutDate: null,
        graduateDate: null,
        externals: { ci_me: [ch.id] },
        wikiPage: null,
        source: "cime",
      });
    }

    return candidates;
  }
}
