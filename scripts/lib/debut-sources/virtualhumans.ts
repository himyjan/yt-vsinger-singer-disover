/**
 * VirtualHumans discovery source.
 *
 * virtualhumans.org is a VTuber directory published as a Webflow site with no
 * JSON API. The listing page at /vtubers loads its cards client-side, so
 * instead we parse the public sitemap.xml to enumerate every
 * /human/<slug> profile page. Each candidate is keyed by
 * `virtualhumans:<name>` and carries no YouTube id — the promote step
 * resolves names to YouTube channels through a name search.
 *
 * No authentication required.
 */

import { fetchJson } from "../io";
import type { Candidate } from "../identity";
import type { DebutSource } from "./types";
import type { RegionCode } from "../types";

const SITEMAP_URL = "https://virtualhumans.org/sitemap.xml";

export class VirtualHumansSource implements DebutSource {
  readonly id = "virtualhumans";
  readonly label = "VirtualHumans";

  constructor(private readonly limit = 200) {}

  isConfigured(): boolean {
    return true;
  }

  unavailableReason(): string | null {
    return null;
  }

  async fetch(_since: string | null): Promise<Candidate[]> {
    try {
      const res = await fetch(SITEMAP_URL, {
        signal: AbortSignal.timeout(30_000),
        headers: {
          "User-Agent": "yt-vsinger-singer-tracker/1.0 (dataset builder)",
          Accept: "application/xml",
        },
      });
      if (!res.ok) return [];
      const xml = await res.text();
      const slugs = parseSitemap(xml);

      const candidates: Candidate[] = [];
      for (const url of slugs.slice(0, this.limit)) {
        const slug = slugFromUrl(url);
        // Best-effort name from slug: replace hyphens with spaces, capitalize.
        const name = slug
          .split("-")
          .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
          .join(" ");

        candidates.push({
          id: `virtualhumans:${name}`,
          name,
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

      return candidates;
    } catch {
      return [];
    }
  }
}

/** Extracts the slug from a /human/<slug> URL. */
function slugFromUrl(url: string): string {
  const m = url.match(/\/human\/([^\/]+)\/?$/);
  return m ? m[1]! : url;
}

/** Parses sitemap.xml to extract all /human/<slug> URLs. */
function parseSitemap(xml: string): string[] {
  const slugs: string[] = [];
  const seen = new Set<string>();
  const regex = /<loc>(https:\/\/virtualhumans\.org\/human\/([^<]+))<\/loc>/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(xml)) !== null) {
    const slug = match[2];
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    slugs.push(match[1]);
  }
  return slugs;
}
