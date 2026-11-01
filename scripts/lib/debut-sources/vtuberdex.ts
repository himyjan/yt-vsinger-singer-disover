/**
 * VTuberDex discovery source.
 *
 * vtuberdex.pages.dev is a static HTML directory of VTubers. It has no JSON
 * API, so this source parses the HTML page to extract VTuber names, countries
 * and groups from the card elements. Each candidate is keyed by
 * `vtuberdex:<name>` and carries no YouTube id — the promote step resolves
 * names to YouTube channels through a name search.
 *
 * No authentication required.
 */

import { fetchJson } from "../io";
import type { Candidate } from "../identity";
import type { DebutSource } from "./types";
import type { RegionCode } from "../types";

const SOURCE_URL = "https://vtuberdex.pages.dev";

interface VtuberdexEntry {
  name: string;
  country?: string;
  group?: string;
}

export class VtuberdexSource implements DebutSource {
  readonly id = "vtuberdex";
  readonly label = "VTuberDex";

  constructor(private readonly limit = 200) {}

  isConfigured(): boolean {
    return true;
  }

  unavailableReason(): string | null {
    return null;
  }

  async fetch(_since: string | null): Promise<Candidate[]> {
    try {
      const res = await fetch(SOURCE_URL, {
        signal: AbortSignal.timeout(30_000),
        headers: {
          "User-Agent": "yt-vsinger-singer-tracker/1.0 (dataset builder)",
          Accept: "text/html",
        },
      });
      if (!res.ok) return [];
      const html = await res.text();
      const entries = parseVtuberdexHtml(html);

      const candidates: Candidate[] = [];
      for (const ch of entries.slice(0, this.limit)) {
        candidates.push({
          id: `vtuberdex:${ch.name}`,
          name: ch.name,
          handle: null,
          region: (ch.country ?? null) as RegionCode | null | undefined,
          affiliation: ch.group ?? null,
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

/** Parses VTuberDex HTML cards to extract name, country, and group. */
function parseVtuberdexHtml(html: string): VtuberdexEntry[] {
  const entries: VtuberdexEntry[] = [];
  const seen = new Set<string>();

  // Match vtuber-card divs: <div class="vtuber-card cardN" data-pais="..." data-group="...">
  const cardRegex = /<div class="vtuber-card[^"]*"[^>]*data-pais="([^"]*)"[^>]*data-group="([^"]*)"[^>]*>[\s\S]*?<h2>([^<]+)<\/h2>/g;
  let match: RegExpExecArray | null;
  while ((match = cardRegex.exec(html)) !== null) {
    const country = match[1] || undefined;
    const group = match[2] || undefined;
    const name = match[3].trim();

    if (!name || seen.has(name)) continue;
    seen.add(name);

    entries.push({ name, country, group });
  }

  return entries;
}
