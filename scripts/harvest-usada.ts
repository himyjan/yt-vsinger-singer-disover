#!/usr/bin/env tsx
/**
 * Harvest VTuber channels from USADA (usadanews.com).
 *
 * USADA (https://usadanews.com) is a multilingual VTuber database with
 * channel listings that include YouTube, Twitch, Twitter/X, Instagram, TikTok
 * links and activity status. The listing page paginates through all VTubers
 * using JSON-LD ItemList, and each entry links to an individual profile page
 * with full details.
 *
 *   npm run data:usada              # harvest VTuber candidates
 *   npm run data:usada -- --limit 50   # sample for parser check
 *   npm run data:usada -- --pages 5    # harvest 5 listing pages
 *
 * Nothing here writes data/ — adding the channels is a separate step
 * through `npm run data:usada-import`.
 */

import fs from "node:fs";
import path from "node:path";

const SOURCE_URL = "https://usadanews.com";
const CACHE_DIR = ".cache/usada";
const OUT_PATH = path.join(CACHE_DIR, "usada.json");

interface UsadaEntry {
  id: string;
  name: string;
  gender: string | null;
  affiliation: string | null;
  group: string | null;
  activity: string | null;
  debutDate: string | null;
  youtubeId: string | null;
  twitterUrl: string | null;
  twitchUrl: string | null;
  instagramUrl: string | null;
  tiktokUrl: string | null;
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
            "Usage: npm run data:usada [--limit <n>] [--pages <n>]",
            "",
            "  --limit <n>  stop after n entries in this pass",
            "  --pages <n>  harvest this many listing pages",
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

/** Extracts the ItemList JSON-LD from HTML and returns its entries. */
function extractItemList(html: string): Array<{ name: string; url: string }> {
  const entries: Array<{ name: string; url: string }> = [];
  const jsonLdMatches = html.match(
    /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g
  );
  if (!jsonLdMatches) return entries;

  for (const m of jsonLdMatches) {
    try {
      const raw = m.replace(/<script type="application\/ld\+json">/, "").replace(/<\/script>/, "");
      const data = JSON.parse(raw);
      if (data.itemListElement && Array.isArray(data.itemListElement)) {
        for (const item of data.itemListElement) {
          if (item.name && item.url) {
            entries.push({ name: item.name.trim(), url: item.url });
          }
        }
        return entries;
      }
    } catch {
      // skip invalid JSON-LD blocks
    }
  }

  return entries;
}

/** Extracts the slug from a USADA VTuber URL. */
function slugFromUrl(url: string): string | null {
  const match = url.match(/\/vtuber\/([^\/]+)\/?$/);
  return match ? match[1] : null;
}

/** Fetches an individual VTuber page and extracts profile data. */
async function fetchUsadaPage(slug: string): Promise<{
  youtubeId: string | null;
  twitter: string | null;
  twitch: string | null;
  instagram: string | null;
  tiktok: string | null;
}> {
  try {
    const res = await fetch(`${SOURCE_URL}/vtuber/${slug}`, {
      headers: {
        Accept: "text/html",
        "User-Agent": "yt-vsinger-singer-tracker/1.0 (dataset builder)",
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      return { youtubeId: null, twitter: null, twitch: null, instagram: null, tiktok: null };
    }
    const html = await res.text();

    const youtubeMatch = html.match(/youtube\.com\/(?:channel\/UC[\w-]{22}|@[A-Za-z0-9_.-]+)/);
    const twitterMatch = html.match(/twitter\.com\/([A-Za-z0-9_]+)/i);
    const twitchMatch = html.match(/twitch\.tv\/([A-Za-z0-9_]+)/i);
    const instagramMatch = html.match(/instagram\.com\/([A-Za-z0-9_.]+)/i);
    const tiktokMatch = html.match(/tiktok\.com\/@([A-Za-z0-9_.]+)/i);

    return {
      youtubeId: youtubeMatch ? youtubeMatch[1] : null,
      twitter: twitterMatch ? twitterMatch[1] : null,
      twitch: twitchMatch ? twitchMatch[1] : null,
      instagram: instagramMatch ? instagramMatch[1] : null,
      tiktok: tiktokMatch ? tiktokMatch[1] : null,
    };
  } catch {
    return { youtubeId: null, twitter: null, twitch: null, instagram: null, tiktok: null };
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  fs.mkdirSync(CACHE_DIR, { recursive: true });

  const allCards: Array<{ name: string; slug: string }> = [];
  const seen = new Set<string>();
  let page = 1;

  while (true) {
    const url = page === 1 ? `${SOURCE_URL}/vtuber/` : `${SOURCE_URL}/vtuber/?page=${page}`;
    console.log(`usada: fetching listing page ${url}`);

    let html: string;
    try {
      const res = await fetch(url, {
        headers: {
          Accept: "text/html",
          "User-Agent": "yt-vsinger-singer-tracker/1.0 (dataset builder)",
        },
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) {
        console.error(`usada: HTTP ${res.status} on page ${page} — stopping`);
        break;
      }
      html = await res.text();
    } catch {
      console.error(`usada: fetch failed on page ${page} — stopping`);
      break;
    }

    const cards = extractItemList(html);
    const newCards = cards
      .map((c) => ({ name: c.name, slug: slugFromUrl(c.url) ?? "" }))
      .filter((c) => c.slug && !seen.has(c.slug));

    for (const c of newCards) seen.add(c.slug!);
    allCards.push(...newCards);

    console.log(`  page ${page}: ${newCards.length} new cards (total ${allCards.length})`);

    // Stop conditions
    if (cards.length === 0) break;
    if (options.pages && page >= options.pages) break;
    if (options.limit && allCards.length >= options.limit) break;

    // If we got fewer than 24 items, we're on the last page
    if (cards.length < 24) break;

    page++;
    // Be respectful between pages
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  if (allCards.length === 0) {
    console.error("usada: no VTuber cards found — leaving previous cache untouched");
    process.exit(0);
  }

  // Apply limit
  let limited = allCards;
  if (options.limit) limited = allCards.slice(0, options.limit);

  console.log(`usada: ${limited.length} VTuber cards to process`);

  // Fetch each individual page to get YouTube ID and social links
  const entries: UsadaEntry[] = [];
  for (let i = 0; i < limited.length; i++) {
    const ch = limited[i];
    console.log(`  [${i + 1}/${limited.length}] ${ch.name}`);
    const profile = await fetchUsadaPage(ch.slug);
    entries.push({
      id: ch.slug,
      name: ch.name,
      gender: null,
      affiliation: null,
      group: null,
      activity: null,
      debutDate: null,
      youtubeId: profile.youtubeId,
      twitterUrl: profile.twitter ? `https://twitter.com/${profile.twitter}` : null,
      twitchUrl: profile.twitch ? `https://twitch.tv/${profile.twitch}` : null,
      instagramUrl: profile.instagram ? `https://instagram.com/${profile.instagram}` : null,
      tiktokUrl: profile.tiktok ? `https://tiktok.com/@${profile.tiktok}` : null,
    });
    // Small delay to be respectful to the server
    if (i < limited.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  const snapshot = {
    generatedAt: new Date().toISOString(),
    source: "usadanews.com",
    count: entries.length,
    data: entries,
  };

  fs.writeFileSync(OUT_PATH, JSON.stringify(snapshot, null, 2));
  const withYt = entries.filter((e) => e.youtubeId !== null).length;
  console.log(
    `usada: ${entries.length} entr(y/ies) (${withYt} with YouTube IDs) harvested → ${OUT_PATH}`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
