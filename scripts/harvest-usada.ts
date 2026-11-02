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
import { inShard, parseShard } from "../scripts/lib/shard";
import { extractLinksFromHtml, PLATFORM_HOSTS } from "../scripts/lib/link-extract";

const SOURCE_URL = "https://usadanews.com";
const CACHE_DIR = ".cache/usada";

interface UsadaEntry {
  id: string;
  name: string;
  gender: string | null;
  affiliation: string | null;
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
  /** All links extracted from the profile page, including platforms beyond the five USADA historically captured. */
  links: { platform: string; handle: string; url: string }[] | null;
}

interface Options {
  limit: number | null;
  pages: number | null;
  shard: string | null;
  listingsOnly: boolean;
  profile: boolean;
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    limit: null,
    pages: null,
    shard: null,
    listingsOnly: false,
    profile: false,
  };
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
      case "--profile":
        options.profile = true;
        break;
      case "--help":
      case "-h":
        console.log(
          [
            "Usage: npm run data:usada [--limit <n>] [--pages <n>] [--shard N/M]",
            "",
            "  (no flags)        harvest listings + profiles",
            "  --listings-only   harvest listing pages only (names + slugs, no profiles)",
            "  --profile         read listings snapshot and fetch missing profile pages",
            "  --limit <n>       stop after n entries in this pass",
            "  --pages <n>       harvest this many listing pages",
            "  --shard N/M       only this shard (1-based)",
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

/** Output path for the snapshot, consistent across listings/profile phases. */
function snapshotPath(shard: string | null): string {
  return path.join(CACHE_DIR, `usada-${shard?.replace("/", "-") ?? "all"}.json`);
}

/** Read an existing snapshot from disk, or return an empty one. */
function readSnapshot(shard: string | null): { data: UsadaEntry[]; generatedAt?: string } {
  try {
    const raw = fs.readFileSync(snapshotPath(shard), "utf8");
    const parsed = JSON.parse(raw) as { data?: UsadaEntry[]; generatedAt?: string };
    return { data: parsed.data ?? [], generatedAt: parsed.generatedAt };
  } catch {
    return { data: [] };
  }
}

/** True when an entry still needs profile data fetched. */
function needsProfile(entry: UsadaEntry): boolean {
  return (
    entry.youtubeId === null &&
    entry.youtubeHandle === null &&
    entry.youtubeUrl === null &&
    entry.twitterUrl === null &&
    entry.twitchUrl === null &&
    entry.instagramUrl === null &&
    entry.tiktokUrl === null
  );
}

/** Merge freshly fetched profile fields onto an existing entry. */
function mergeProfile(
  entry: UsadaEntry,
  profile: Awaited<ReturnType<typeof fetchUsadaPage>>,
): UsadaEntry {
  return {
    ...entry,
    youtubeUrl: entry.youtubeUrl ?? profile.youtubeUrl,
    youtubeId: entry.youtubeId ?? profile.youtubeId,
    youtubeHandle: entry.youtubeHandle ?? profile.youtubeHandle,
    twitterUrl:
      entry.twitterUrl ?? (profile.twitterUrl ? `https://twitter.com/${profile.twitterUrl}` : null),
    twitchUrl:
      entry.twitchUrl ?? (profile.twitchUrl ? `https://twitch.tv/${profile.twitchUrl}` : null),
    instagramUrl:
      entry.instagramUrl ?? (profile.instagramUrl ? `https://instagram.com/${profile.instagramUrl}` : null),
    tiktokUrl:
      entry.tiktokUrl ?? (profile.tiktokUrl ? `https://tiktok.com/@${profile.tiktokUrl}` : null),
    activity: entry.activity ?? profile.activity,
    debutDate: entry.debutDate ?? profile.debutDate,
    country: entry.country ?? profile.country,
    affiliation: entry.affiliation ?? profile.affiliation,
    reincarnationOf: entry.reincarnationOf ?? profile.reincarnationOf,
    roleTags: entry.roleTags ?? profile.roleTags,
    statusData: entry.statusData ?? profile.statusData,
    links: entry.links ?? profile.links ?? null,
  };
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
  twitterUrl: string | null;
  twitchUrl: string | null;
  instagramUrl: string | null;
  tiktokUrl: string | null;
  activity: string | null;
  debutDate: string | null;
  country: string | null;
  affiliation: string | null;
  reincarnationOf: string[] | null;
  roleTags: string[] | null;
  statusData: string | null;
  links: { platform: string; handle: string; url: string }[] | null;
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
        twitterUrl: null, twitchUrl: null, instagramUrl: null, tiktokUrl: null,
        activity: null, debutDate: null, country: null, affiliation: null,
        reincarnationOf: null, roleTags: null, statusData: null,
        links: null,
      };
    }
    const html = await res.text();

    // Extract all platform/social links generically, skipping usadanews.com itself.
    const links = extractLinksFromHtml(html, {
      sourceHost: "usadanews.com",
    });

    // Map extracted links to the entry's typed fields (first link per platform wins).
    const byPlatform = new Map<string, { handle: string; url: string }>();
    for (const link of links) {
      if (!byPlatform.has(link.platform)) byPlatform.set(link.platform, link);
    }

    const get = (platform: string): string | null => {
      const link = byPlatform.get(platform);
      return link ? link.handle : null;
    };
    const getUrl = (platform: string): string | null => {
      const link = byPlatform.get(platform);
      return link ? link.url : null;
    };

    const ytLink = byPlatform.get("youtube");
    const ytHandle = ytLink ? ytLink.handle : null;
    // YouTube channel id (UC…) vs handle (@name or plain name).
    const youtubeId = ytHandle && ytHandle.startsWith("UC") ? ytHandle : null;
    const youtubeHandle = ytHandle && !ytHandle.startsWith("UC")
      ? ytHandle.startsWith("@") ? ytHandle.slice(1) : ytHandle
      : null;
    const youtubeUrl = getUrl("youtube");

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
      youtubeId,
      youtubeHandle,
      twitterUrl: get("twitter") ? `https://twitter.com/${get("twitter")}` : null,
      twitchUrl: get("twitch") ? `https://twitch.tv/${get("twitch")}` : null,
      instagramUrl: get("instagram") ? `https://instagram.com/${get("instagram")}` : null,
      tiktokUrl: get("tiktok") ? `https://tiktok.com/@${get("tiktok")}` : null,
      activity: infoCards["活動狀態"] ?? statusData ?? null,
      debutDate: infoCards["出道日期"] ?? null,
      country: infoCards["國家 / 地區"] ?? null,
      affiliation: infoCards["所屬 / 關聯"] ?? null,
      reincarnationOf: reincarnationOf.length > 0 ? reincarnationOf : null,
      roleTags: roleTags.length > 0 ? roleTags : null,
      statusData,
      links: links.map((l) => ({ platform: l.platform, handle: l.handle, url: l.url })),
    };
  } catch {
    return {
      youtubeUrl: null, youtubeId: null, youtubeHandle: null,
      twitterUrl: null, twitchUrl: null, instagramUrl: null, tiktokUrl: null,
      activity: null, debutDate: null, country: null, affiliation: null,
      reincarnationOf: null, roleTags: null, statusData: null,
      links: null,
    };
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const OUT_PATH = snapshotPath(options.shard);
  fs.mkdirSync(CACHE_DIR, { recursive: true });

  // ── Profile phase: read the listings snapshot, fill in missing profiles ──
  if (options.profile) {
    // Source is always the full listings snapshot (usada-all.json).
    // Sharding only decides which subset of entries this job fetches.
    const allSnapshot = readSnapshot(null);
    let entries = allSnapshot.data;
    if (entries.length === 0) {
      console.error(
        `usada: no snapshot at ${snapshotPath(null)} — run npm run data:usada-listings first`,
      );
      process.exit(1);
    }

    // If sharded, only process entries whose id lands in this shard.
    if (options.shard) {
      const shard = parseShard(options.shard);
      entries = entries.filter((e) => inShard(e.id, shard.index, shard.count));
      console.log(
        `usada: profile phase shard ${options.shard} — ${entries.length} of ${allSnapshot.data.length} entries`,
      );
    }

    const toFetch = entries.filter(needsProfile);
    const alreadyHave = entries.length - toFetch.length;

    // Apply limit to the profile phase
    let limitedToFetch = toFetch;
    if (options.limit) limitedToFetch = toFetch.slice(0, options.limit);

    console.log(
      `usada: profile phase — ${alreadyHave} already have profile data, ${limitedToFetch.length} of ${toFetch.length} need fetching`,
    );

    if (limitedToFetch.length === 0) {
      // Still write an (empty or unchanged) shard snapshot so downstream
      // import knows this shard completed.
      const shardSnapshot = {
        generatedAt: new Date().toISOString(),
        source: "usadanews.com",
        count: entries.length,
        data: entries,
      };
      fs.writeFileSync(OUT_PATH, JSON.stringify(shardSnapshot, null, 2));
      console.log(`usada: all entries already have profile data → ${OUT_PATH}`);
      return;
    }

    const concurrency = 8;
    let processed = 0;

    for (let i = 0; i < limitedToFetch.length; i += concurrency) {
      const batch = limitedToFetch.slice(i, i + concurrency);
      const results = await Promise.all(
        batch.map(async (ch) => {
          processed++;
          console.log(`  [${processed}/${limitedToFetch.length}] ${ch.name}`);
          try {
            const profile = await fetchUsadaPage(ch.id);
            return mergeProfile(ch, profile);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`    failed ${ch.name}: ${msg}`);
            return ch;
          }
        })
      );
      // Splice results back into entries
      for (const r of results) {
        const idx = entries.findIndex((e) => e.id === r.id);
        if (idx !== -1) entries[idx] = r;
      }
    }

    const snapshotOut = {
      generatedAt: new Date().toISOString(),
      source: "usadanews.com",
      count: entries.length,
      data: entries,
    };
    fs.writeFileSync(OUT_PATH, JSON.stringify(snapshotOut, null, 2));
    const withYt = entries.filter(
      (e) => e.youtubeId !== null || e.youtubeHandle !== null,
    ).length;
    console.log(
      `usada: ${entries.length} entr(y/ies) (${withYt} with YouTube) → ${OUT_PATH}`,
    );
    return;
  }

  // ── Listing phase (and default full harvest) ──
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

  // If listings-only, write entries with null profile fields and stop.
  if (options.listingsOnly) {
    const entries: UsadaEntry[] = limited.map((ch) => ({
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
      links: null,
    }));

    const snapshot = {
      generatedAt: new Date().toISOString(),
      source: "usadanews.com",
      count: entries.length,
      data: entries,
    };
    fs.writeFileSync(OUT_PATH, JSON.stringify(snapshot, null, 2));
    console.log(
      `usada: ${entries.length} entr(y/ies) (listings only) → ${OUT_PATH}`,
    );
    return;
  }

  // Default: fetch each individual page to get YouTube ID and social links
  // Run in parallel batches to speed up harvesting, with concurrency limit
  const entries: UsadaEntry[] = [];
  const concurrency = 8; // Concurrent profile fetches
  let processed = 0;

  for (let i = 0; i < limited.length; i += concurrency) {
    const batch = limited.slice(i, i + concurrency);
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
            activity: profile.activity,
            debutDate: profile.debutDate,
            country: profile.country,
            youtubeUrl: profile.youtubeUrl,
            youtubeId: profile.youtubeId,
            youtubeHandle: profile.youtubeHandle,
            twitterUrl: profile.twitterUrl ? `https://twitter.com/${profile.twitterUrl}` : null,
            twitchUrl: profile.twitchUrl ? `https://twitch.tv/${profile.twitchUrl}` : null,
            instagramUrl: profile.instagramUrl ? `https://instagram.com/${profile.instagramUrl}` : null,
            tiktokUrl: profile.tiktokUrl ? `https://tiktok.com/@${profile.tiktokUrl}` : null,
            reincarnationOf: profile.reincarnationOf,
            roleTags: profile.roleTags,
            statusData: profile.statusData,
            links: profile.links ?? null,
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`    failed ${ch.name}: ${msg}`);
          return {
            id: ch.slug,
            name: ch.name,
            gender: null,
            affiliation: null,
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
            links: null,
          };
        }
      })
    );
    entries.push(...results);
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
