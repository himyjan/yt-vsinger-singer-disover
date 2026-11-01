/**
 * USADA discovery source.
 *
 * USADA (https://usadanews.com) is a multilingual VTuber database that
 * publishes VTuber channel data via HTML pages:
 *   https://usadanews.com/vtuber/          — directory listing
 *   https://usadanews.com/vtuber/<slug>/   — individual performer page
 *   https://usadanews.com/life-status/graduated/ — graduated performers
 *   https://usadanews.com/agencies/        — agency directory
 *
 * Each entry carries a YouTube channel id, name, and social links.
 * No authentication required.
 *
 *   npm run data:usada              # harvest VTuber candidates
 *
 * Nothing here writes data/ — adding the channels is a separate step
 * through `npm run data:usada-import`.
 */

import type { Candidate } from "../identity";
import type { DebutSource } from "./types";
import type { RegionCode } from "../types";

const SOURCE_URL = "https://usadanews.com";

interface UsadaEntry {
  id: string;
  name: string;
  region?: string | null;
  youtubeId?: string;
  twitterUrl?: string;
  twitchUrl?: string;
  instagramUrl?: string;
  tiktokUrl?: string;
}

export class UsadaSource implements DebutSource {
  readonly id = "usada";
  readonly label = "USADA (usadanews.com)";

  constructor(private readonly limit = 200) {}

  isConfigured(): boolean {
    return true;
  }

  unavailableReason(): string | null {
    return null;
  }

  async fetch(_since: string | null): Promise<Candidate[]> {
    try {
      const res = await fetch(`${SOURCE_URL}/vtuber/`, {
        signal: AbortSignal.timeout(30_000),
        headers: {
          Accept: "text/html",
          "User-Agent": "yt-vsinger-singer-tracker/1.0 (dataset builder)",
        },
      });
      if (!res.ok) return [];
      const html = await res.text();

      const candidates: Candidate[] = [];
      const seen = new Set<string>();

      // Extract ItemList JSON-LD
      const jsonLdMatches = html.match(
        /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g
      );
      if (!jsonLdMatches) return candidates;

      for (const m of jsonLdMatches) {
        try {
          const raw = m
            .replace(/<script type="application\/ld\+json">/, "")
            .replace(/<\/script>/, "");
          const data = JSON.parse(raw);
          if (data.itemListElement && Array.isArray(data.itemListElement)) {
            for (const item of data.itemListElement) {
              if (!item.name || !item.url) continue;
              const slugMatch = item.url.match(/\/vtuber\/([^\/]+)\/?$/);
              const slug = slugMatch ? slugMatch[1] : null;
              if (!slug || seen.has(slug)) continue;
              seen.add(slug);

              candidates.push({
                id: `usada:${slug}`,
                name: item.name.trim(),
                handle: null,
                region: null,
                affiliation: null,
                debutDate: null,
                graduateDate: null,
                externals: {},
                wikiPage: null,
                source: this.id,
              });
            }
            break; // only process the first ItemList
          }
        } catch {
          // skip invalid JSON-LD blocks
        }
      }

      return candidates.slice(0, this.limit);
    } catch {
      return [];
    }
  }
}
