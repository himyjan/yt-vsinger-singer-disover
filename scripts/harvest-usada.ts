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
import { parseShard } from "../scripts/lib/shard";

const SOURCE_URL = "https://usadanews.com";
const CACHE_DIR = ".cache/usada";

interface UsadaEntry {
  id: string;
  name: string;
  gender: string | null;
  affiliation: string | null;
  group: string | null;
  activity: string | null;
  debutDate: string | null;
  country: string | null;
  youtubeUrl: string | null;
  youtubeId: string | null;
  youtubeHandle: string | null;
  twitterUrl: string | null;
  twitchUrl: string | null;
  instagramUrl: string | null;
  tiktokUrl: string | null;
  reincarnationOf: string[] | null;
  roleTags: string[] | null;
  statusData: string | null;
}

interface Options {
  limit: number | null;
  pages: number | null;
  shard: string | null;
  listingsOnly: boolean;
}

function parseArgs(argv: string[]): Options {
  const options: Options = { limit: null, pages: null, shard: null, listingsOnly: false };
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
      case "--shard":
        options.shard = value ?? null;
        i++;
        break;
      case "--listings-only":
        options.listingsOnly = true;
        break;
      case "--shard":
        options.shard = value ?? null;
        i++;
        break;
      case "--shard":
        options.shard = value ?? null;
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

/** Extracts the UC channel id from a youtube.com/channel/UC... URL. */
function extractYoutubeId(url: string): string | null {
  const match = url.match(/youtube\.com\/channel\/(UC[\w-]{22})/);
  return match ? match[1] : null;
}

/** Extracts the handle from a youtube.com/@handle URL. */
function extractYoutubeHandle(url: string): string | null {
  const match = url.match(/youtube\.com\/@([A-Za-z0-9_.-]+)/);
  return match ? match[1] : null;
}

/** Parses profile info cards: <dt class="label">…</dt><dd class="value">…</dd> */
function parseInfoCards(html: string): Record<string, string> {
  const cards: Record<string, string> = {};
  // More flexible: allow any whitespace between </dt> and <dd>
  const cardRegex = /<dt class="label">\s*([^<]+?)\s*<\/dt>\s*<dd[^>]*class="value"[^>]*>([\s\S]*?)<\/dd>/g;
  let match: RegExpExecArray | null;
  while ((match = cardRegex.exec(html)) !== null) {
    const label = match[1].trim();
    const value = match[2]
      .replace(/<[^>]*>/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (label && value) cards[label] = value;
  }
  return cards;
}

/** URL-decodes a usadanews slug (e.g. %E6%96%90%E5%A8%9Cfeina → 斐娜feina). */
function decodeSlug(slug: string): string {
  try {
    return decodeURIComponent(slug);
  } catch {
    return slug;
  }
}

/** Extracts activity status data-status attribute. */
function extractActivityStatus(html: string): string | null {
  const match = html.match(/<a[^>]*class="vt-profile-status[^"]*"[^>]*data-status="([^"]+)"/);
  return match ? match[1] : null;
}

/** Extracts links to other usadanews VTuber profiles (potential reincarnation links). */
function extractReincarnationLinks(html: string, currentSlug: string): string[] {
  const links: string[] = [];
  const seen = new Set<string>();
  const regex = /href="(https:\/\/usadanews\.com\/vtuber\/([^\/]+)\/)"/g;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(html)) !== null) {
    const rawSlug = m[2];
    const slug = decodeSlug(rawSlug);
    if (slug !== currentSlug && !seen.has(slug)) {
      seen.add(slug);
      links.push(slug);
    }
  }
  return links;
}

/** Extracts role tags from detail page (links to /roles/<name>/). */
function extractRoleTags(html: string): string[] {
  const tags: string[] = [];
  const seen = new Set<string>();
  const regex = /href="(https:\/\/usadanews\.com\/roles\/([^\/]+)\/)"/g;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(html)) !== null) {
    const rawTag = m[2];
    const tag = decodeSlug(rawTag);
    if (tag && !seen.has(tag)) {
      seen.add(tag);
      tags.push(tag);
    }
  }
  return tags;
}

/** Fetches an individual VTuber page and extracts profile data. */
async function fetchUsadaPage(slug: string): Promise<{
  youtubeUrl: string | null;
  youtubeId: string | null;
  youtubeHandle: string | null;
  twitter: string | null;
  twitch: string | null;
  instagram: string | null;
  tiktok: string | null;
  activity: string | null;
  debutDate: string | null;
  country: string | null;
  affiliation: string | null;
  reincarnationOf: string[] | null;
  roleTags: string[] | null;
  statusData: string | null;
}> {
  try {
    const res = await fetch(`${SOURCE_URL}/vtuber/${encodeURIComponent(slug)}`, {
      headers: {
        Accept: "text/html",
        "User-Agent": "yt-vsinger-singer-tracker/1.0 (dataset builder)",
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      return {
        youtubeUrl: null, youtubeId: null, youtubeHandle: null,
        twitter: null, twitch: null, instagram: null, tiktok: null,
        activity: null, debutDate: null, country: null, affiliation: null,
        reincarnationOf: null, roleTags: null, statusData: null,
      };
    }
    const html = await res.text();

    // YouTube links - prefer channel/UC id over @handle
    const youtubeChannelMatch = html.match(/youtube\.com\/channel\/(UC[\w-]{22})/);
    const youtubeHandleMatch = html.match(/youtube\.com\/@([A-Za-z0-9_.-]+)/);
    const youtubeUrl = youtubeChannelMatch
      ? `https://www.youtube.com/channel/${youtubeChannelMatch[1]}`
      : youtubeHandleMatch
        ? `https://www.youtube.com/@${youtubeHandleMatch[1]}`
        : null;

    const twitterMatch = html.match(/twitter\.com\/([A-Za-z0-9_]+)/i);
    const xMatch = html.match(/x\.com\/([A-Za-z0-9_]+)/i);
    const twitchMatch = html.match(/twitch\.tv\/([A-Za-z0-9_]+)/i);
    const instagramMatch = html.match(/instagram\.com\/([A-Za-z0-9_.]+)/i);
    const tiktokMatch = html.match(/tiktok\.com\/@([A-Za-z0-9_.]+)/i);

    // Profile info cards
    const infoCards = parseInfoCards(html);

    // Activity status
    const statusData = extractActivityStatus(html);

    // Reincarnation links (links to other usadanews VTuber profiles)
    const reincarnationOf = extractReincarnationLinks(html, slug);

    // Role tags (links to /roles/<name>/)
    const roleTags = extractRoleTags(html);

    return {
      youtubeUrl,
      youtubeId: youtubeChannelMatch ? youtubeChannelMatch[1] : null,
      youtubeHandle: youtubeHandleMatch ? youtubeHandleMatch[1] : null,
      twitter: twitterMatch ? twitterMatch[1] : xMatch ? xMatch[1] : null,
      twitch: twitchMatch ? twitchMatch[1] : null,
      instagram: instagramMatch ? instagramMatch[1] : null,
      tiktok: tiktokMatch ? tiktokMatch[1] : null,
      activity: infoCards["活動狀態"] ?? statusData ?? null,
      debutDate: infoCards["出道日期"] ?? null,
      country: infoCards["國家 / 地區"] ?? null,
      affiliation: infoCards["所屬 / 關聯"] ?? null,
      reincarnationOf: reincarnationOf.length > 0 ? reincarnationOf : null,
      roleTags: roleTags.length > 0 ? roleTags : null,
      statusData,
    };
  } catch {
    return {
      youtubeUrl: null, youtubeId: null, youtubeHandle: null,
      twitter: null, twitch: null, instagram: null, tiktok: null,
      activity: null, debutDate: null, country: null, affiliation: null,
      reincarnationOf: null, roleTags: null, statusData: null,
    };
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const OUT_PATH = path.join(CACHE_DIR, `usada-${options.shard?.replace("/", "-") ?? "all"}.json`);
  fs.mkdirSync(CACHE_DIR, { recursive: true });

  const allCards: Array<{ name: string; slug: string }> = [];
  const seen = new Set<string>();
  let page = 1;

  while (true) {
    // Shard: only process this page if it belongs to this shard
    // Shard 1/20 gets pages 1, 21, 41... Shard 2/20 gets pages 2, 22, 42...
    if (options.shard) {
      const [shardIdx, shardCount] = options.shard.split("/").map(Number);
      if (((page - 1) % shardCount) !== (shardIdx - 1)) {
        page++;
        continue;
      }
    }

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
      .map((c) => ({ name: c.name, slug: decodeSlug(slugFromUrl(c.url) ?? "") }))
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
  // Run in parallel batches to speed up harvesting, with concurrency limit
  const entries: UsadaEntry[] = [];
  const concurrency = 8; // Concurrent profile fetches
  let processed = 0;

  for (let i = 0; i < limited.length; i += concurrency) {
    const batch = limited.slice(i, i + concurrency);
    if (!options.listingsOnly) {
      const results = await Promise.all(
        batch.map(async (ch) => {
          processed++;
          console.log(`  [${processed}/${limited.length}] ${ch.name}`);
          try {
            const profile = await fetchUsadaPage(ch.slug);
            return {
              id: ch.slug,
              name: ch.name,
              gender: null,
              affiliation: profile.affiliation,
              group: null,
              activity: profile.activity,
              debutDate: profile.debutDate,
              country: profile.country,
              youtubeUrl: profile.youtubeUrl,
              youtubeId: profile.youtubeId,
              youtubeHandle: profile.youtubeHandle,
              twitterUrl: profile.twitter ? `https://twitter.com/${profile.twitter}` : null,
              twitchUrl: profile.twitch ? `https://twitch.tv/${profile.twitch}` : null,
              instagramUrl: profile.instagram ? `https://instagram.com/${profile.instagram}` : null,
              tiktokUrl: profile.tiktok ? `https://tiktok.com/@${profile.tiktok}` : null,
              reincarnationOf: profile.reincarnationOf,
              roleTags: profile.roleTags,
              statusData: profile.statusData,
            };
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`    failed ${ch.name}: ${msg}`);
            return {
              id: ch.slug,
              name: ch.name,
              gender: null,
              affiliation: null,
              group: null,
              activity: null,
              debutDate: null,
              country: null,
              youtubeUrl: null,
              youtubeId: null,
              youtubeHandle: null,
              twitterUrl: null,
              twitchUrl: null,
              instagramUrl: null,
              tiktokUrl: null,
              reincarnationOf: null,
              roleTags: null,
              statusData: null,
            };
          }
        })
      );
      entries.push(...results);
    }
  }

  const snapshot = {
    generatedAt: new Date().toISOString(),
    source: "usadanews.com",
    count: entries.length,
    data: entries,
  };

  fs.writeFileSync(OUT_PATH, JSON.stringify(snapshot, null, 2));
  const withYt = entries.filter((e) => e.youtubeId !== null || e.youtubeHandle !== null).length;
  console.log(
    `usada: ${entries.length} entr(y/ies) (${withYt} with YouTube) harvested → ${OUT_PATH}`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
