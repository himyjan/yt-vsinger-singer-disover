/**
 * VirtualHumans discovery source.
 *
 * virtualhumans.org is a VTuber directory published as a Webflow site with no
 * JSON API. The listing page at /vtubers contains VTuber cards with name,
 * handle (@handle) and slug (/human/<slug>). Each candidate is keyed by
 * `virtualhumans:<name>` and carries no YouTube id — the promote step resolves
 * names to YouTube channels through a name search.
 *
 * No authentication required.
 */

import { fetchJson } from "../io";
import type { Candidate } from "../identity";
import type { DebutSource } from "./types";
import type { RegionCode } from "../types";

const SOURCE_URL = "https://virtualhumans.org";

interface VirtualHumansEntry {
  name: string;
  country?: string;
  group?: string;
}

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
      const res = await fetch(SOURCE_URL + "/vtubers", {
        signal: AbortSignal.timeout(30_000),
        headers: {
          "User-Agent": "yt-vsinger-singer-tracker/1.0 (dataset builder)",
          Accept: "text/html",
        },
      });
      if (!res.ok) return [];
      const html = await res.text();
      const entries = parseVirtualHumansHtml(html);

      const candidates: Candidate[] = [];
      for (const ch of entries.slice(0, this.limit)) {
        candidates.push({
          id: `virtualhumans:${ch.name}`,
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

/** Parses VTuber cards from the VirtualHumans listing HTML. */
function parseVirtualHumansHtml(html: string): VirtualHumansEntry[] {
  const entries: VirtualHumansEntry[] = [];
  const seen = new Set<string>();

  // Match: <a href="/human/<slug>" ...><div ...><h2>Name</h2><h3>@handle</h3>
  const cardRegex = /<a href="(\/human\/[^"]+)" class="link-block contained w-inline-block">[\s\S]*?<h2 class="title light white">([^<]+)<\/h2>[\s\S]*?<h3 class="title light small white">@([^<]+)<\/h3>/g;
  let match: RegExpExecArray | null;
  while ((match = cardRegex.exec(html)) !== null) {
    const name = match[2].trim();
    const handle = match[3].trim();

    if (!name || seen.has(name)) continue;
    seen.add(name);

    entries.push({ name, country: undefined, group: undefined });
  }

  return entries;
}
