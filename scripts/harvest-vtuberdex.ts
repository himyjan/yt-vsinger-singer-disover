#!/usr/bin/env tsx
/**
 * Harvest VTuber channels from VTuberDex.
 *
 * vtuberdex.pages.dev is a static HTML directory of VTubers. It has no JSON
 * API and **no paging** — every card is rendered on the single index page —
 * so this script fetches that one page and parses every card to extract
 * VTuber names, countries, groups, and profile links.
 *
 * Cards that have a profile page link get their profile fetched to extract
 * the direct YouTube channel URL (and avatar). Cards without a profile link
 * carry no YouTube id — the import step resolves those names through a
 * YouTube name search.
 *
 *   npm run data:vtuberdex              # harvest all entries from VTuberDex
 *   npm run data:vtuberdex -- --limit 50  # sample for a parser check
 *   npm run data:vtuberdex -- --no-profiles  # skip profile fetching (listing only)
 *
 * Nothing here writes `data/` — adding the channels is a separate step
 * through `npm run data:vtuberdex-import`.
 */

import fs from "node:fs";
import path from "node:path";

const SOURCE_URL = "https://vtuberdex.pages.dev";
const CACHE_DIR = ".cache/vtuberdex";
const OUT_PATH = path.join(CACHE_DIR, "vtuberdex.json");

interface VtuberdexEntry {
  name: string;
  country?: string;
  group?: string;
  /** Profile page href relative to SOURCE_URL, e.g. "PipaHiyoko.html" */
  profileHref?: string;
  /** Direct YouTube channel URL extracted from the profile page. */
  youtubeUrl?: string;
  /** YouTube channel id (UC… or handle) extracted from the profile page. */
  youtubeId?: string;
  /** Avatar URL extracted from the profile page. */
  avatar?: string;
}

interface Options {
  limit: number | null;
  noProfiles: boolean;
}

function parseArgs(argv: string[]): Options {
  const options: Options = { limit: null, noProfiles: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const value = argv[i + 1];
    switch (arg) {
      case "--limit":
        options.limit = Math.max(1, Number(value ?? 1));
        i++;
        break;
      case "--no-profiles":
        options.noProfiles = true;
        break;
      case "--help":
      case "-h":
        console.log(
          [
            "Usage: npm run data:vtuberdex [options]",
            "",
            "  --limit <n>     max entries to harvest",
            "  --no-profiles   skip fetching profile pages (listing data only)",
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

/** Parses VTuberDex HTML cards to extract name, country, group, and profile href. */
function parseVtuberdexHtml(html: string): VtuberdexEntry[] {
  const entries: VtuberdexEntry[] = [];
  const seen = new Set<string>();

  const cardBlocks = html.split(/<div class="vtuber-card[^>]*>/);
  for (const block of cardBlocks.slice(1)) {
    const countryMatch = block.match(/\bdata-pais="([^"]*)"/);
    const groupMatch = block.match(/\bdata-group="([^"]*)"/);
    // Match <h2>...</h2>, or handle malformed HTML like <h2>Name<h2>
    // (missing closing slash) by stopping at the next <h2 or </div>.
    const nameMatch = block.match(/<h2>([\s\S]*?)(?=<\/h2>|<h2\s|<\/div>|$)/);
    // Profile link: <a href="Name.html"> — may be absolute or relative.
    const hrefMatch = block.match(/<a\s+href="([^"]+\.html)"/i);

    const country = countryMatch?.[1] || undefined;
    const group = groupMatch?.[1] || undefined;
    const name = nameMatch
      ? nameMatch[1]!
          .replace(/<[^>]*>/g, " ")
          .replace(/\s+/g, " ")
          .trim()
      : "";

    if (!name || seen.has(name)) continue;
    seen.add(name);

    const href = hrefMatch?.[1];
    const profileHref = href
      ? href.startsWith("http") || href.startsWith("/")
        ? href
        : `./${href}`
      : undefined;

    entries.push({ name, country, group, profileHref });
  }

  return entries;
}

/** Extracts a YouTube channel URL/id from a profile page's social links. */
function extractYouTubeFromProfile(html: string): { url?: string; id?: string } {
  // Match YouTube social links: <a href="https://www.youtube.com/...">…</a>
  const ytMatch = html.match(
    /<a[^>]*href="([^"]*youtube\.com[^"]*)"[^>]*>(?:[\s\S]*?<img[^>]*alt="YouTube"[\s\S]*?)?<\/a>/i,
  );
  if (!ytMatch) return {};

  const url = ytMatch[1]!;
  let id: string | undefined;
  // Extract channel id: youtube.com/channel/UC… or youtube.com/@handle
  const channelMatch = url.match(/youtube\.com\/channel\/(UC[\w-]{20,})/);
  if (channelMatch) {
    id = channelMatch[1]!;
  } else {
    const handleMatch = url.match(/youtube\.com\/@([\w.-]+)/);
    if (handleMatch) id = handleMatch[1]!;
  }

  return { url, id };
}

/** Extracts the avatar image URL from a profile page. */
function extractAvatarFromProfile(html: string): string | undefined {
  const avatarMatch = html.match(
    /<img[^>]+(?:id="avatarMain"|src="([^"]*\.png[^"]*)")[^>]*>/i,
  );
  if (avatarMatch) {
    const src = avatarMatch[1] ?? avatarMatch[0].match(/src="([^"]+)"/)?.[1];
    if (src) return src;
  }
  return undefined;
}

async function fetchHtml(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: { Accept: "text/html" },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return null;
    return (await res.text()) as string;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  fs.mkdirSync(CACHE_DIR, { recursive: true });

  console.log(`vtuberdex: fetching ${SOURCE_URL}`);
  let html: string;
  try {
    const res = await fetch(SOURCE_URL, {
      headers: { Accept: "text/html" },
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      console.error(`vtuberdex: HTTP ${res.status} — stopping`);
      process.exit(1);
    }
    html = await res.text();
  } catch (error: unknown) {
    console.error(
      `vtuberdex: fetch failed — ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }

  const entries = parseVtuberdexHtml(html);
  if (entries.length === 0) {
    console.error("vtuberdex: no entries found on the page — stopping");
    process.exit(1);
  }

  console.log(`vtuberdex: ${entries.length} entr(y/ies) found on the page`);

  let limited = entries;
  if (options.limit) limited = entries.slice(0, options.limit);

  // Fetch profile pages for entries that have a profile link, to extract
  // direct YouTube channel URLs (avoiding a name search at import time).
  // Some listing hrefs are `.html` files that 404 to the main listing; in
  // that case try the same path without the extension.
  // Profiles are fetched in small batches to avoid overwhelming the source.
  let profilesFetched = 0;
  let profilesWithYoutube = 0;
  if (!options.noProfiles) {
    const PROFILE_BATCH = 6;
    const profileEntries = limited.filter((e) => e.profileHref);
    for (let i = 0; i < profileEntries.length; i += PROFILE_BATCH) {
      const batch = profileEntries.slice(i, i + PROFILE_BATCH);
      const results = await Promise.all(
        batch.map(async (entry) => {
          const href = entry.profileHref!;
          const base = new URL(href, SOURCE_URL).href;
          const candidates = [base];
          if (base.endsWith(".html")) {
            candidates.push(base.slice(0, -5));
          }

          for (const candidate of candidates) {
            const profileHtml = await fetchHtml(candidate);
            if (!profileHtml) continue;
            const titleMatch = profileHtml.match(/<title>([^<]+)<\/title>/i);
            const title = titleMatch?.[1]?.trim();
            if (title && title !== "VtuberDex") {
              const yt = extractYouTubeFromProfile(profileHtml);
              if (yt.url) {
                entry.youtubeUrl = yt.url;
                entry.youtubeId = yt.id;
              }
              const avatar = extractAvatarFromProfile(profileHtml);
              if (avatar) entry.avatar = avatar;
              return { ok: true, hasYoutube: !!yt.url };
            }
          }
          return { ok: false, hasYoutube: false };
        }),
      );
      for (const r of results) {
        if (r.ok) profilesFetched++;
        if (r.hasYoutube) profilesWithYoutube++;
      }
    }
    console.log(
      `vtuberdex: fetched ${profilesFetched} profile(s), ${profilesWithYoutube} with direct YouTube link(s)`,
    );
  }

  const snapshot = {
    generatedAt: new Date().toISOString(),
    source: "vtuberdex.pages.dev",
    count: limited.length,
    totalOnPage: entries.length,
    profilesWithYoutube: options.noProfiles ? 0 : profilesWithYoutube,
    data: limited,
  };

  fs.writeFileSync(OUT_PATH, JSON.stringify(snapshot, null, 2));
  console.log(
    `vtuberdex: ${limited.length} entr(y/ies) harvested → ${OUT_PATH}`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
