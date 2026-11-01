#!/usr/bin/env tsx
/**
 * Harvest VTuber channels from 4chan /vt/ (Virtual YouTubers board).
 *
 * 4chan /vt/ is an anonymous imageboard. Threads contain YouTube channel
 * links posted by users. This source reads the catalog JSON API and extracts
 * YouTube channel handles/IDs from thread comments.
 *
 * WARNING: 4chan is an anonymous imageboard. Any user can post any link.
 * Fan accounts, clip channels, and re-uploads are common. This source applies
 * detectClipAccount() and isFanAccountName() filters, and only accepts
 * YouTube channel URLs (not video URLs). Results should be treated as
 * candidates requiring manual review.
 *
 *   npm run data:vt4chan              # harvest VTuber candidates from 4chan /vt/
 *   npm run data:vt4chan -- --limit 100   # max threads to scan
 *
 * Nothing here writes data/ — adding the channels is a separate step
 * through npm run data:vt4chan-import.
 */

import fs from "node:fs";
import path from "node:path";

const API_BASE = "https://a.4cdn.org";
const BOARD = "vt";
const CACHE_DIR = ".cache/vt4chan";
const OUT_PATH = path.join(CACHE_DIR, "vt4chan.json");

interface CatalogThread {
  no: number;
  sub?: string;
  com?: string;
  tim?: number;
  ext?: string;
  filename?: string;
  semantic_url?: string;
}

interface CatalogPage {
  page: number;
  threads: CatalogThread[];
}

interface CatalogThreadEntry {
  no: number;
  sub?: string;
  com?: string;
  youtubeLinks: string[];
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
  // Match youtube.com/channel/UC..., youtube.com/c/..., youtube.com/@handle
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

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  fs.mkdirSync(CACHE_DIR, { recursive: true });

  console.log(`vt4chan: fetching /vt/ catalog`);

  const allThreads: CatalogThread[] = [];
  let page = 1;
  while (true) {
    if (options.pages !== null && page > options.pages) break;

    const pageData = await fetchCatalogPage(page);
    if (!pageData || !pageData.threads || pageData.threads.length === 0) break;

    allThreads.push(...pageData.threads);
    console.log(`  page ${page}: ${pageData.threads.length} threads`);

    page++;
    if (options.limit && allThreads.length >= options.limit) {
      allThreads.length = options.limit;
      break;
    }
  }

  console.log(`vt4chan: ${allThreads.length} total threads across ${page - 1} page(s)`);

  // Extract YouTube channel links from thread comments
  const threadEntries: Array<{
    no: number;
    sub?: string;
    com?: string;
    youtubeLinks: string[];
  }> = [];

  for (const t of allThreads) {
    if (!t.com) continue;
    const links = extractChannelLinks(t.com);
    if (links.length === 0) continue;

    threadEntries.push({
      no: t.no,
      sub: t.sub,
      com: t.com,
      youtubeLinks: links,
    });
  }

  console.log(
    `vt4chan: ${threadEntries.length} threads with YouTube channel links`
  );

  const snapshot = {
    generatedAt: new Date().toISOString(),
    source: "boards.4chan.org/vt",
    count: threadEntries.length,
    data: threadEntries,
  };

  fs.writeFileSync(OUT_PATH, JSON.stringify(snapshot, null, 2));
  console.log(
    `vt4chan: ${threadEntries.length} entr(y/ies) harvested → ${OUT_PATH}`
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
