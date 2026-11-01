#!/usr/bin/env tsx
/**
 * Harvest VTuber channels from VirtualHumans (virtualhumans.org).
 *
 * virtualhumans.org is a Webflow CMS site with no JSON API. The listing page
 * at /vtubers lists VTuber cards with name, handle (@handle) and slug
 * (/human/<slug>). YouTube channel IDs are only on each individual
 * /human/<slug> page.
 *
 * The harvest reads the listing page, then fetches each individual page to
 * extract the YouTube channel ID and social links.
 *
 *   npm run data:virtualhumans              # harvest all
 *   npm run data:virtualhumans -- --limit 50   # sample for parser check
 *
 * The harvest writes to .cache/virtualhumans/virtualhumans.json.
 * Importing is a separate step: npm run data:virtualhumans-import
 */

import fs from "node:fs";
import path from "node:path";

const SOURCE_URL = "https://virtualhumans.org";
const CACHE_DIR = ".cache/virtualhumans";
const OUT_PATH = path.join(CACHE_DIR, "virtualhumans.json");

interface VirtualHumansEntry {
  name: string;
  handle?: string;
  slug: string;
  youtubeId?: string;
  twitter?: string;
  instagram?: string;
  tiktok?: string;
  debutDate?: string;
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
            "Usage: npm run data:virtualhumans [options]",
            "",
            "  --limit <n>  max entries to harvest",
            "  --pages <n>  max listing pages to read (default: all)",
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

/** Parses VTuber cards from the listing page HTML. */
function parseListingCards(html: string): Array<{ name: string; handle: string; slug: string }> {
  const entries: Array<{ name: string; handle: string; slug: string }> = [];
  const seen = new Set<string>();

  // Match: <a href="/human/<slug>" ...><div ...><h2>Name</h2><h3>@handle</h3>
  const cardRegex = /<a href="(\/human\/[^"]+)" class="link-block contained w-inline-block">[\s\S]*?<h2 class="title light white">([^<]+)<\/h2>[\s\S]*?<h3 class="title light small white">@([^<]+)<\/h3>/g;
  let match: RegExpExecArray | null;
  while ((match = cardRegex.exec(html)) !== null) {
    const slug = match[1];
    const name = match[2].trim();
    const handle = match[3].trim();

    if (!name || seen.has(name)) continue;
    seen.add(name);

    entries.push({ name, handle, slug });
  }

  return entries;
}

/** Fetches an individual VTuber page and extracts YouTube ID and social links. */
async function fetchVtuberPage(slug: string): Promise<{
  youtubeId?: string;
  twitter?: string;
  instagram?: string;
  tiktok?: string;
}> {
  try {
    const res = await fetch(`${SOURCE_URL}${slug}`, {
      headers: { Accept: "text/html" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return {};
    const html = await res.text();

    const youtubeIdMatch = html.match(/youtube\.com\/channel\/(UC[\w-]{22})/);
    const twitterMatch = html.match(/twitter\.com\/([A-Za-z0-9_]+)/);
    const instagramMatch = html.match(/instagram\.com\/([A-Za-z0-9_.]+)/);
    const tiktokMatch = html.match(/tiktok\.com\/@([A-Za-z0-9_.]+)/);

    return {
      youtubeId: youtubeIdMatch?.[1],
      twitter: twitterMatch?.[1],
      instagram: instagramMatch?.[1],
      tiktok: tiktokMatch?.[1],
    };
  } catch {
    return {};
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  fs.mkdirSync(CACHE_DIR, { recursive: true });

  const allCards: Array<{ name: string; handle: string; slug: string }> = [];
  let page = 1;

  for (;;) {
    if (options.pages !== null && page > options.pages) break;

    const url = page === 1 ? `${SOURCE_URL}/vtubers` : `${SOURCE_URL}/vtubers?p=${page}`;
    console.log(`virtualhumans: fetching listing page ${url}`);
    let html: string;
    try {
      const res = await fetch(url, {
        headers: { Accept: "text/html" },
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) {
        console.error(
          `virtualhumans: HTTP ${res.status} on page ${page} — stopping`,
        );
        break;
      }
      html = await res.text();
    } catch {
      console.error(
        `virtualhumans: listing fetch failed on page ${page} — stopping`,
      );
      break;
    }

    const cards = parseListingCards(html);
    if (cards.length === 0) {
      console.log(`virtualhumans: no VTuber cards on page ${page} — stopping`);
      break;
    }

    allCards.push(...cards);
    console.log(`  page ${page}: ${cards.length} cards`);

    page++;
    if (options.limit && allCards.length >= options.limit) {
      allCards.length = options.limit;
      break;
    }
  }

  if (!allCards.length) {
    console.error("virtualhumans: no VTuber cards found — leaving previous cache untouched");
    process.exit(0);
  }

  console.log(`virtualhumans: ${allCards.length} VTuber cards found across ${page - 1} page(s)`);

  let limited = allCards;
  if (options.limit) limited = allCards.slice(0, options.limit);

  // Fetch each individual page to get YouTube ID and social links
  const entries: VirtualHumansEntry[] = [];
  for (let i = 0; i < limited.length; i++) {
    const card = limited[i];
    console.log(`  [${i + 1}/${limited.length}] ${card.name}`);
    const social = await fetchVtuberPage(card.slug);
    entries.push({
      name: card.name,
      handle: card.handle,
      slug: card.slug,
      youtubeId: social.youtubeId,
      twitter: social.twitter,
      instagram: social.instagram,
      tiktok: social.tiktok,
    });
    // Small delay to be respectful to the server
    if (i < limited.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  const snapshot = {
    generatedAt: new Date().toISOString(),
    source: "virtualhumans.org",
    count: entries.length,
    data: entries,
  };

  fs.writeFileSync(OUT_PATH, JSON.stringify(snapshot, null, 2));
  const withYt = entries.filter(e => e.youtubeId).length;
  console.log(
    `virtualhumans: ${entries.length} entr(y/ies) harvested (${withYt} with YouTube IDs) from ${page - 1} page(s) → ${OUT_PATH}`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
