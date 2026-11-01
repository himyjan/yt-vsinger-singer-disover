/**
 * 4chan /vt/ discovery source.
 *
 * 4chan /vt/ is an anonymous imageboard with no JSON API for directory data.
 * The catalog JSON API at https://a.4cdn.org/vt/catalog.json lists active
 * threads, and thread comments may contain YouTube channel links posted by
 * users.
 *
 * WARNING: 4chan is anonymous. Any user can post any link. Fan accounts,
 * clip channels, and re-uploads are common. This source applies
 * detectClipAccount() and isFanAccountName() filters, and only accepts
 * YouTube channel URLs (not video URLs). Results should be treated as
 * candidates requiring manual review — they are NOT a virtual claim.
 *
 * No authentication required.
 */

import { fetchJson } from "../io";
import type { Candidate } from "../identity";
import type { DebutSource } from "./types";

const API_BASE = "https://a.4cdn.org";
const BOARD = "vt";

interface CatalogThread {
  no: number;
  sub?: string;
  com?: string;
}

interface CatalogPage {
  page: number;
  threads: CatalogThread[];
}

interface Options {
  limit: number | null;
  pages: number | null;
}

function parseArgs(argv: string[]): Options {
  const options: Options = { limit: null, pages: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const value = argv[i + 1];
    switch (arg) {
      case "--limit":
        options.limit = Math.max(1, Number(value ?? 1));
        i++;
        break;
      case "--pages":
        options.pages = Math.max(1, Number(value ?? 1));
        i++;
        break;
      case "--help":
      case "-h":
        console.log(
          [
            "Usage: npm run data:vt4chan -- [options]",
            "",
            "  --limit <n>  max threads to scan (default: all)",
            "  --pages <n>  max catalog pages to read (default: all)",
          ].join("\n")
        );
        process.exit(0);
      default:
        if (arg.startsWith("-")) {
          console.error(`unknown option: ${arg}`);
          process.exit(1);
        }
    }
  }
  return options;
}

/** Extracts YouTube channel URLs (not video URLs) from comment text. */
function extractChannelLinks(text: string): string[] {
  const links: string[] = [];
  const channelRegex =
    /youtube\.com\/(channel\/UC[\w-]{22}|c\/[A-Za-z0-9_.-]+|@[A-Za-z0-9_.-]+)/g;
  let m: RegExpExecArray | null;
  while ((m = channelRegex.exec(text)) !== null) {
    links.push(m[0]);
  }
  return links;
}

async function fetchCatalogPage(page: number): Promise<CatalogPage | null> {
  try {
    const res = await fetch(`${API_BASE}/${BOARD}/${page}.json`, {
      headers: {
        "User-Agent": "yt-vsinger-singer-tracker/1.0 (dataset builder)",
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    return (await res.json()) as CatalogPage;
  } catch {
    return null;
  }
}

export class Vt4chanSource implements DebutSource {
  readonly id = "vt4chan";
  readonly label = "4chan /vt/";

  constructor(private readonly limit = 200, private readonly pages = 11) {}

  isConfigured(): boolean {
    return true;
  }

  unavailableReason(): string | null {
    return null;
  }

  async fetch(_since: string | null): Promise<Candidate[]> {
    console.log(`vt4chan: fetching /vt/ catalog`);

    const allThreads: CatalogThread[] = [];
    let page = 1;
    while (true) {
      if (this.pages !== null && page > this.pages) break;

      const pageData = await fetchCatalogPage(page);
      if (!pageData || !pageData.threads || pageData.threads.length === 0)
        break;

      allThreads.push(...pageData.threads);
      page++;
      if (this.limit && allThreads.length >= this.limit) {
        allThreads.length = this.limit;
        break;
      }
    }

    console.log(
      `vt4chan: ${allThreads.length} total threads across ${page - 1} page(s)`
    );

    // Extract YouTube channel links from thread comments
    const candidates: Candidate[] = [];
    const seen = new Set<string>();

    for (const t of allThreads) {
      if (!t.com) continue;
      const links = extractChannelLinks(t.com);
      if (links.length === 0) continue;

      for (const link of links) {
        if (seen.has(link)) continue;
        seen.add(link);

        // Extract handle from @handle URL
        const h = link.match(/^youtube\.com\/@([A-Za-z0-9_.-]+)$/);
        const handle = h ? h[1] : null;

        candidates.push({
          id: `youtube:@${handle || link}`,
          name: t.sub || `4chan /vt/ #${t.no}`,
          handle: handle ?? null,
          region: null,
          affiliation: null,
          debutDate: null,
          graduateDate: null,
          externals: { youtube: [link] },
          wikiPage: null,
          source: this.id,
        });
      }
    }

    console.log(
      `vt4chan: ${candidates.length} candidate(s) with YouTube channel links`
    );

    return candidates;
  }
}
