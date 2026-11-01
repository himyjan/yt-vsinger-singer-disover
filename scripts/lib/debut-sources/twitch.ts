/**
 * Twitch discovery source.
 *
 * Twitch exposes a public channel search API (Helix `search/channels`) that
 * returns broadcasters matching a query. This source searches for VTuber
 * and VSinger related terms and publishes each match as a candidate.
 *
 * Requires `TWITCH_CLIENT_ID` and `TWITCH_CLIENT_SECRET` credentials.
 * Without them the source is skipped (not an error — the rest of the
 * pipeline continues).
 */

import { TwitchClient } from "../twitch";
import type { Candidate } from "../identity";
import type { DebutSource } from "./types";

const SEARCH_TERMS = [
  "VTuber",
  "VSinger",
  "歌枠",
  "バーチャル",
  "virtual youtuber",
];

export class TwitchSource implements DebutSource {
  readonly id = "twitch";
  readonly label = "Twitch";

  constructor(private readonly limit = 100) {}

  isConfigured(): boolean {
    return TwitchClient.isConfigured(process.env);
  }

  unavailableReason(): string | null {
    if (this.isConfigured()) return null;
    return "missing TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET";
  }

  async fetch(_since: string | null): Promise<Candidate[]> {
    const client = TwitchClient.fromEnv(process.env, ".cache/twitch");
    if (!client) return [];

    const candidates: Candidate[] = [];
    const seen = new Set<string>();

    for (const term of SEARCH_TERMS) {
      try {
        const results = await client.searchChannels(term, this.limit);
        for (const ch of results) {
          const id = String(ch.id);
          if (!id || seen.has(id)) continue;
          seen.add(id);

          candidates.push({
            id: `twitch:${id}`,
            name: ch.display_name ?? ch.broadcaster_login ?? null,
            handle: ch.broadcaster_login ?? null,
            region: null,
            affiliation: null,
            debutDate: null,
            graduateDate: null,
            externals: { twitch: [id] },
            wikiPage: null,
            source: this.id,
          });
        }
      } catch {
        /* one term failing must not kill the whole source */
      }
    }

    return candidates;
  }
}
