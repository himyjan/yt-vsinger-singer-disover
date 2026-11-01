/**
 * Virtuallife discovery source.
 *
 * virtuallife.tv is a German VTuber directory published as HTML with no JSON
 * API. The listing page at /?site=vtuber lists VTuber cards with name and
 * Discord ID. Each candidate is keyed by `virtuallife:<discord_id>` and carries
 * no YouTube id — the promote step resolves names to YouTube channels through
 * a name search.
 *
 * No authentication required.
 */

import { fetchJson } from "../io";
import type { Candidate } from "../identity";
import type { DebutSource } from "./types";
import type { RegionCode } from "../types";

const SOURCE_URL = "https://virtuallife.tv";

interface VirtuallifeEntry {
  name: string;
  id: string;
}

export class VirtuallifeSource implements DebutSource {
  readonly id = "virtuallife";
  readonly label = "Virtuallife";

  constructor(private readonly limit = 200) {}

  isConfigured(): boolean {
    return true;
  }

  unavailableReason(): string | null {
    return null;
  }

  async fetch(_since: string | null): Promise<Candidate[]> {
    try {
      const res = await fetch(`${SOURCE_URL}/?site=vtuber`, {
        signal: AbortSignal.timeout(30_000),
        headers: {
          "User-Agent": "yt-vsinger-singer-tracker/1.0 (dataset builder)",
          Accept: "text/html",
        },
      });
      if (!res.ok) return [];
      const html = await res.text();
      const entries = parseVirtuallifeHtml(html);

      const candidates: Candidate[] = [];
      for (const ch of entries.slice(0, this.limit)) {
        candidates.push({
          id: `virtuallife:${ch.id}`,
          name: ch.name,
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

/** Parses VTuber cards from the Virtuallife listing HTML. */
function parseVirtuallifeHtml(html: string): Array<{ name: string; id: string }> {
  const entries: Array<{ name: string; id: string }> = [];
  const seen = new Set<string>();

  // Match: <div class='searchP vt-user' style='background-image: url(./img/users/<id>.webp);'>
  //        <div id='<id>' class='vt-overlay'>
  //        ... <h2 class='searchT'>Name</h2>
  const cardRegex = /<div class='searchP vt-user' style='background-image: url\(.\/img\/users\/(\d+)\.webp\);'>[\s\S]*?<h2 class='searchT'>\s*([^<]+?)\s*<\/h2>/g;
  let match: RegExpExecArray | null;
  while ((match = cardRegex.exec(html)) !== null) {
    const id = match[1];
    const name = match[2].trim();

    if (!name || seen.has(name)) continue;
    seen.add(name);

    entries.push({ name, id });
  }

  return entries;
}
