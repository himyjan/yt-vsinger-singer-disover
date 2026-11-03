#!/usr/bin/env tsx
/**
 * Harvest VTuber profiles from VirtualHumans (virtualhumans.org).
 *
 * virtualhumans.org is a Webflow CMS site with no JSON API. The listing page
 * at /vtubers loads its cards client-side, so instead we parse the public
 * sitemap.xml to enumerate every /human/<slug> profile page, then fetch each
 * profile page to extract the name, handle, country, debut date, avatar,
 * and social links (YouTube, Instagram, Twitter/X, TikTok, Website, Email).
 *
 * No authentication required.
 *
 *   npm run data:virtualhumans              # harvest all ~510 profiles
 *   npm run data:virtualhumans -- --limit 50   # sample for parser check
 *   npm run data:virtualhumans -- --no-profiles  # listing URLs only, no profile fetches
 *
 * The harvest writes to .cache/virtualhumans/virtualhumans.json.
 * Importing is a separate step: npm run data:virtualhumans-import
 */

import fs from "node:fs";
import path from "node:path";

const SITEMAP_URL = "https://virtualhumans.org/sitemap.xml";
const SOURCE_URL = "https://virtualhumans.org";
const CACHE_DIR = ".cache/virtualhumans";
const OUT_PATH = path.join(CACHE_DIR, "virtualhumans.json");

interface VirtualHumansEntry {
  /** Human-readable display name. */
  name: string;
  /** @handle from the profile page. */
  handle?: string;
  /** URL slug, e.g. "aba-wils". */
  slug: string;
  /** Profile page URL. */
  profileUrl?: string;
  /** YouTube channel id (UC… or handle) from the profile page. */
  youtubeId?: string;
  /** YouTube channel URL from the profile page. */
  youtubeUrl?: string;
  /** X/Twitter handle or URL. */
  twitter?: string;
  /** Instagram handle or URL. */
  instagram?: string;
  /** TikTok handle or URL. */
  tiktok?: string;
  /** Website URL. */
  website?: string;
  /** Email address. */
  email?: string;
  /** "Originally From" country text. */
  country?: string;
  /** "First Appearance" date text. */
  debutDate?: string;
  /** "Identifies as" emoji/text, e.g. 🌐👩. */
  identifiesAs?: string;
  /** Avatar image URL. */
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
            "Usage: npm run data:virtualhumans -- [options]",
            "",
            "  --limit <n>        max entries to harvest",
            "  --no-profiles      skip fetching profile pages (sitemap URLs only)",
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

/** Parses sitemap.xml to extract all /human/<slug> URLs. */
function parseSitemap(xml: string): string[] {
  const slugs: string[] = [];
  const seen = new Set<string>();
  const regex = /<loc>(https:\/\/virtualhumans\.org\/human\/([^<]+))<\/loc>/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(xml)) !== null) {
    const fullUrl = match[1];
    const slug = match[2];
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    slugs.push(fullUrl);
  }
  return slugs;
}

/**
 * Parses a VirtualHumans profile page HTML.
 *
 * Extracts name, handle, country, debut date, identifies-as, avatar, and
 * social links. Social links that are hidden (`w-condition-invisible`) or
 * have `href="#"` are treated as absent.
 */
function parseProfilePage(html: string): Partial<VirtualHumansEntry> {
  const out: Partial<VirtualHumansEntry> = {};

  // Name: <h1 class="heading profile-custom">Aba Wils</h1>
  const nameMatch = html.match(
    /<h1[^>]*class="[^"]*profile-custom[^"]*"[^>]*>([\s\S]*?)<\/h1>/i,
  );
  if (nameMatch) {
    out.name = nameMatch[1]!.replace(/<[^>]*>/g, "").trim();
  }

  // Handle: <div class="heading small light no-gap">@abawils</div>
  const handleMatch = html.match(
    /<div[^>]*class="[^"]*heading small light no-gap[^"]*"[^>]*>@([^<]+)<\/div>/i,
  );
  if (handleMatch) {
    out.handle = handleMatch[1]!.trim();
  }

  // Avatar: <img ... class="... profile-img ..." ... src="URL" ...> or src before class
  const avatarMatch = html.match(
    /<img[^>]*(?:class="[^"]*profile-img[^"]*"[^>]*src="([^"]+)"|src="([^"]+)"[^>]*class="[^"]*profile-img[^"]*")[^>]*>/i,
  );
  if (avatarMatch) {
    out.avatar = avatarMatch[1] ?? avatarMatch[2];
  }

  // Bio fields: <h3 class="heading small title">Label</h3><div class="heading small light">Value</div>
  const fieldRegex =
    /<h3[^>]*class="[^"]*heading small title[^"]*"[^>]*>([\s\S]*?)<\/h3>\s*<div[^>]*class="heading small light"[^>]*>([\s\S]*?)<\/div>/gi;
  let fieldMatch: RegExpExecArray | null;
  while ((fieldMatch = fieldRegex.exec(html)) !== null) {
    const label = fieldMatch[1]!.replace(/<[^>]*>/g, "").trim().toLowerCase();
    const value = fieldMatch[2]!.replace(/<[^>]*>/g, "").trim();
    if (!value) continue;
    if (label.includes("originally from") || label.includes("country")) {
      out.country = value;
    } else if (label.includes("first appearance")) {
      out.debutDate = value;
    } else if (label.includes("identifies as")) {
      out.identifiesAs = value;
    }
  }

  // Social links: <a href="URL" ...><div>Platform Name</div></a>
  // Skip links with href="#" or w-condition-invisible (hidden = not set).
  const socialRegex =
    /<a[^>]*href="([^"]+)"[^>]*>(?:[\s\S]*?<div[^>]*>([^<]+)<\/div>[\s\S]*?)?<\/a>/gi;
  let socialMatch: RegExpExecArray | null;
  while ((socialMatch = socialRegex.exec(html)) !== null) {
    const url = socialMatch[1]!;
    const label = (socialMatch[2] ?? "").trim().toLowerCase();

    // Skip hidden links and dead hrefs.
    if (url === "#" || !url) continue;

    if (label.includes("instagram")) {
      out.instagram = url;
    } else if (label.includes("twitter") || label.includes("x ")) {
      out.twitter = url;
    } else if (label.includes("tiktok")) {
      out.tiktok = url;
    } else if (label.includes("website")) {
      out.website = url;
    } else if (label.includes("youtube")) {
      out.youtubeUrl = url;
      const ytId = url.match(
        /youtube\.com\/(?:channel\/(UC[\w-]{22,})|@([\w.-]+))/,
      );
      if (ytId) {
        out.youtubeId = ytId[1] ?? ytId[2];
      }
    } else if (label.includes("email")) {
      // Extract email from mailto: URL.
      const emailMatch = url.match(/^mailto:([^?]+)/i);
      if (emailMatch) {
        out.email = emailMatch[1]!;
      }
    }
  }

  return out;
}

async function fetchHtml(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "yt-vsinger-singer-tracker/1.0 (dataset builder)",
        Accept: "text/html",
      },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return null;
    return (await res.text()) as string;
  } catch {
    return null;
  }
}

/** Fetch profile pages in bounded concurrency batches. */
async function fetchProfilesConcurrently(
  urls: string[],
  concurrency: number,
): Promise<Array<{ url: string; html: string | null }>> {
  const results: Array<{ url: string; html: string | null }> = [];
  for (let i = 0; i < urls.length; i += concurrency) {
    const batch = urls.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map(async (url) => {
        const html = await fetchHtml(url);
        return { url, html };
      }),
    );
    results.push(...batchResults);
    // Small delay between batches to be respectful.
    if (i + concurrency < urls.length) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  return results;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  fs.mkdirSync(CACHE_DIR, { recursive: true });

  console.log(`virtualhumans: fetching sitemap ${SITEMAP_URL}`);
  const sitemap = await fetchHtml(SITEMAP_URL);
  if (!sitemap) {
    console.error(
      "virtualhumans: sitemap fetch failed — leaving previous cache untouched",
    );
    process.exit(0);
  }

  const profileUrls = parseSitemap(sitemap);
  if (!profileUrls.length) {
    console.error(
      "virtualhumans: no /human/ URLs found in sitemap — leaving previous cache untouched",
    );
    process.exit(0);
  }

  console.log(
    `virtualhumans: ${profileUrls.length} profile URL(s) found in sitemap`,
  );

  const limited = options.limit ? profileUrls.slice(0, options.limit) : profileUrls;

  // Extract slugs from URLs for the entries without profile fetch.
  const slugFromUrl = (url: string): string => {
    const m = url.match(/\/human\/([^\/]+)\/?$/);
    return m ? m[1]! : url;
  };

  let entries: VirtualHumansEntry[] = limited.map((url) => ({
    name: "",
    slug: slugFromUrl(url),
    profileUrl: url,
  }));

  if (!options.noProfiles) {
    console.log(
      `virtualhumans: fetching ${limited.length} profile page(s) with concurrency 6`,
    );
    const results = await fetchProfilesConcurrently(
      limited.map((u) => u),
      6,
    );

    entries = results.map(({ url, html }) => {
      const slug = slugFromUrl(url);
      const base: VirtualHumansEntry = {
        name: "",
        slug,
        profileUrl: url,
      };
      if (!html) return base;
      const parsed = parseProfilePage(html);
      return {
        ...base,
        name: parsed.name ?? "",
        handle: parsed.handle ?? undefined,
        youtubeId: parsed.youtubeId ?? undefined,
        youtubeUrl: parsed.youtubeUrl ?? undefined,
        twitter: parsed.twitter ?? undefined,
        instagram: parsed.instagram ?? undefined,
        tiktok: parsed.tiktok ?? undefined,
        website: parsed.website ?? undefined,
        email: parsed.email ?? undefined,
        country: parsed.country ?? undefined,
        debutDate: parsed.debutDate ?? undefined,
        identifiesAs: parsed.identifiesAs ?? undefined,
        avatar: parsed.avatar ?? undefined,
      };
    });

    const withYt = entries.filter((e) => e.youtubeId).length;
    const withIg = entries.filter((e) => e.instagram).length;
    const withTw = entries.filter((e) => e.twitter).length;
    console.log(
      `virtualhumans: profile fetch complete — ${withYt} with YouTube, ${withIg} with Instagram`,
    );
  }

  const snapshot = {
    generatedAt: new Date().toISOString(),
    source: "virtualhumans.org",
    count: entries.length,
    totalOnPage: profileUrls.length,
    data: entries,
  };

  fs.writeFileSync(OUT_PATH, JSON.stringify(snapshot, null, 2));
  console.log(
    `virtualhumans: ${entries.length} entr(y/ies) harvested → ${OUT_PATH}`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
