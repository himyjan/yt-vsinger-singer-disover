/**
 * Generic link extraction from profile/roster HTML.
 *
 * Scans an HTML page for `href` links, classifies each by hostname into a
 * platform id (YouTube, Twitch, X, Bilibili, …), and returns them as
 * `{ platform, handle, url }` tuples ready to write into `channel.externals`.
 *
 * Known platforms get the bare handle that `externalUrl()` in `src/lib/links.ts`
 * can reconstruct a full URL from. Unknown domains land in numbered
 * `web:<n>` slots, where the handle is the full address itself.
 *
 * Every roster harvester can use this instead of hand-writing regexes per
 * domain:
 *
 *   import { extractLinksFromHtml } from "../scripts/lib/link-extract";
 *   const links = extractLinksFromHtml(html, { sourceHost: "usadanews.com" });
 *
 *   // links = [
 *   //   { platform: "youtube", handle: "UCxxxx", url: "https://..." },
 *   //   { platform: "twitter", handle: "handle", url: "https://..." },
 *   //   { platform: "web:1", handle: "https://open.spotify.com/artist/…", url: "https://..." },
 *   // ]
 */

import type { PlatformId } from "./types";

/** A link found on a profile page. */
export interface ExtractedLink {
  /** Platform id (`youtube`, `twitter`, …) or `web:<n>` for unknown hosts. */
  platform: string;
  /** Bare handle for known platforms; full URL for `web:<n>`. */
  handle: string;
  /** The absolute URL as it appeared on the page. */
  url: string;
}

/** Options for link extraction. */
export interface LinkExtractOptions {
  /** Hostname of the source site — its own links are skipped (e.g. usadanews.com). */
  sourceHost?: string;
  /** Additional host → platform overrides. */
  knownHosts?: Record<string, string>;
  /** Maximum number of `web:<n>` slots to allocate. Defaults to 56. */
  maxWebSlots?: number;
}

/** Hostname → platform id. Keys are without `www.` and lowercased. */
export const PLATFORM_HOSTS: Record<string, string> = {
  // YouTube
  "youtube.com": "youtube",
  "youtu.be": "youtube",
  // Twitch
  "twitch.tv": "twitch",
  // X / Twitter
  "twitter.com": "twitter",
  "x.com": "twitter",
  "mobile.twitter.com": "twitter",
  // Instagram
  "instagram.com": "instagram",
  // TikTok
  "tiktok.com": "tiktok",
  "www.tiktok.com": "tiktok",
  // Bilibili
  "space.bilibili.com": "bilibili",
  "bilibili.com": "bilibili",
  // Niconico
  "nicovideo.jp": "niconico",
  "www.nicovideo.jp": "niconico",
  // VK
  "vk.com": "vk",
  // CHZZK
  "chzzk.naver.com": "chzzk",
  // KICK
  "kick.com": "kick",
  // SOOP
  "sooplive.com": "soop",
  "sooplive.co.kr": "soop",
  // CI.ME
  "ci.me": "ci.me",
  // Discord
  "discord.gg": "discord",
  "discord.com": "discord",
  // Spotify
  "open.spotify.com": "spotify",
  // Facebook
  "facebook.com": "facebook",
  "www.facebook.com": "facebook",
  // Telegram
  "t.me": "telegram",
  "telegram.me": "telegram",
  // Line
  "line.me": "line",
};

// Asset extensions that are never a social profile.
const ASSET_EXT = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "svg", "ico", "avif",
  "css", "js", "mjs", "ts", "woff", "woff2", "ttf", "eot", "otf",
  "mp4", "webm", "mp3", "wav", "ogg", "pdf", "zip", "gz",
]);

// Hosts that are never a social profile — CDNs, APIs, consent dialogs, etc.
const SKIP_HOSTS = new Set([
  "google.com", "www.google.com",
  "googleapis.com", "fonts.googleapis.com", "fonts.gstatic.com",
  "gstatic.com",
  "google-analytics.com", "www.google-analytics.com",
  "googletagmanager.com", "www.googletagmanager.com",
  "fundingchoicesmessages.google.com",
  "facebook.com", "www.facebook.com",  // Facebook pixel/share buttons
  "connect.facebook.net",
  "platform.twitter.com", "platform.instagram.com",
  "widgets.twitch.tv",
]);

function isAssetUrl(parsed: URL): boolean {
  const path = parsed.pathname.toLowerCase();
  const dot = path.lastIndexOf(".");
  if (dot === -1) return false;
  const ext = path.slice(dot + 1);
  return ASSET_EXT.has(ext);
}

/** Normalize a hostname: lowercase, strip `www.`. */
function normHost(host: string): string {
  return host.toLowerCase().replace(/^www\./, "");
}

/** Extract the bare handle from a platform URL. */
function extractHandle(platform: string, parsed: URL): string | null {
  const path = parsed.pathname.replace(/^\/+/, "").replace(/\/+$/, "");
  const segments = path.split("/").filter(Boolean);
  const first = segments[0];

  switch (platform) {
    case "youtube":
      if (first === "channel" && segments[1]) return segments[1];
      if (first === "c" && segments[1]) return `c/${segments[1]}`;
      if (first === "user" && segments[1]) return segments[1];
      if (first && first.startsWith("@")) return first;
      return first || null;
    case "twitch":
      return first || null;
    case "twitter":
      return first || null;
    case "instagram":
      return first || null;
    case "tiktok":
      if (first && first.startsWith("@")) return first.slice(1);
      return first || null;
    case "bilibili":
      if (first === "space" && segments[1]) return segments[1];
      return null;
    case "niconico":
      if (first === "user" && segments[1]) return segments[1];
      return null;
    case "vk":
      return first || null;
    case "chzzk":
      return first || null;
    case "kick":
      return first || null;
    case "soop":
      return first || null;
    case "ci.me":
      if (first && first.startsWith("@")) return first.slice(1);
      return first || null;
    case "discord":
      return first || null;
    case "spotify":
      return segments.join("/") || null;
    default:
      return null;
  }
}

/**
 * Extract platform and social links from an HTML string.
 *
 * Returns links in document order. The first link per known platform wins;
 * additional unknown hosts get `web:1`, `web:2`, … slots.
 */
export function extractLinksFromHtml(
  html: string,
  options: LinkExtractOptions = {},
): ExtractedLink[] {
  const {
    sourceHost,
    knownHosts = {},
    maxWebSlots = 56,
  } = options;

  const hosts = { ...PLATFORM_HOSTS, ...knownHosts };
  const source = sourceHost ? normHost(sourceHost) : null;

  const links: ExtractedLink[] = [];
  const seenUrls = new Set<string>();
  const seenPlatforms = new Set<string>();
  let webSlot = 0;

  // Match href="…" and href='…'
  const hrefRegex = /href\s*=\s*["']([^"']+)["']/gi;
  let match: RegExpExecArray | null;
  while ((match = hrefRegex.exec(html)) !== null) {
    let raw = match[1].trim();

    // Skip non-http schemes
    if (/^(?:mailto|tel|javascript|data):/i.test(raw)) continue;

    // Resolve protocol-relative and relative URLs against the source host.
    let resolved = raw;
    if (/^\/\//.test(raw)) {
      resolved = `https:${raw}`;
    } else if (sourceHost && !/^https?:\/\//i.test(raw)) {
      resolved = `https://${sourceHost}${raw.startsWith("/") ? "" : "/"}${raw}`;
    }

    if (!/^https?:\/\//i.test(resolved)) continue;

    try {
      const parsed = new URL(resolved);
      const host = normHost(parsed.hostname);

      // Skip source-site internal links.
      if (source && host === source) continue;

      // Skip CDNs, consent dialogs, analytics, share widgets.
      if (SKIP_HOSTS.has(host)) continue;

      // Skip assets.
      if (isAssetUrl(parsed)) continue;

      // Skip already-seen URLs.
      if (seenUrls.has(resolved)) continue;
      seenUrls.add(resolved);

      const platform = hosts[host] ?? null;

      if (platform) {
        // One entry per known platform (first wins).
        if (seenPlatforms.has(platform)) continue;
        const handle = extractHandle(platform, parsed);
        if (!handle) continue;
        seenPlatforms.add(platform);
        links.push({ platform, handle, url: resolved });
      } else if (webSlot < maxWebSlots) {
        // Unknown host → numbered web slot. Multiple unknown hosts each get
        // their own slot; the same host can appear in multiple slots.
        webSlot++;
        links.push({
          platform: `web:${webSlot}`,
          handle: resolved,
          url: resolved,
        });
      }
    } catch {
      // Unparseable URL — skip.
    }
  }

  return links;
}
