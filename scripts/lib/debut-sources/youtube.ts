/**
 * Harvest VTuber channels from YouTube via keyword searches.
 *
 * Uses YouTube InnerTube channel search to find channels by keyword.
 * No authentication required via InnerTube (quota-free).
 *
 *   npm run data:youtube-discover -- --keyword "VTuber" --limit 200
 *   npm run data:discover --source youtube --limit 200
 */

import { InnerTubeSource } from "../youtubei";
import type { Candidate } from "../identity";
import type { DebutSource } from "./types";

export class YoutubeSource implements DebutSource {
  readonly id = "youtube";
  readonly label = "YouTube";

  constructor(private readonly keyword = "VTuber", private readonly limit = 200) {}

  isConfigured(): boolean {
    return true;
  }

  unavailableReason(): string | null {
    return null;
  }

  async fetch(_since: string | null): Promise<Candidate[]> {
    const innertube = new InnerTubeSource();
    await innertube.connect();
    const client = (innertube as any).client;

    const results = await client.searchChannels(this.keyword, this.limit);
    if (!results) return [];

    const candidates: Candidate[] = [];
    for (const item of results) {
      if (!item.id) continue;

      candidates.push({
        id: `youtube:${item.id}`,
        name: item.title || null,
        handle: null,
        region: null,
        affiliation: null,
        debutDate: null,
        graduateDate: null,
        externals: { youtube: [item.id] },
        wikiPage: null,
        source: this.id,
      });
    }

    return candidates;
  }
}
