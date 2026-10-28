/**
 * hololist.net — a VTuber directory, reduced to what the dataset uses.
 *
 * The site is WordPress with pretty permalinks, so every entry is a post at
 * `https://hololist.net/<slug>/` and the whole roster is enumerable from the
 * core sitemaps (`/wp-sitemap-posts-post-{1..5}.xml`). Its own footer states
 * the size it was built at — 9,359 entries, each filed under one or more of
 * `V-Tuber`, `V-Streamer`, `V-Singer` and `V-UP`.
 *
 * `robots.txt` disallows `/*?*`, which rules out the REST API the site's own
 * front end would use (`/wp-json/wp/v2/posts?per_page=…` answers `403` through
 * Cloudflare in any case), and the archive pages (`/debut/`, `/newest/`) are
 * client-rendered shells. The sitemap plus one request per entry is therefore
 * the only readable path: ~9,359 requests of about 56 KB, which is lighter
 * than bacharu's 2.9 GB census and is read once, incrementally thereafter —
 * the sitemaps carry `<lastmod>`, so a later run refetches only what changed.
 *
 * What an entry page publishes, as `<section id="…">` blocks: the name, the
 * nicknames, the types, the categories, the tags, the content (including
 * `Singing`), the birthday, the debut date, the height and weight, the
 * affiliation, the languages, the gender, the model (L2D/3D), the oshi mark,
 * the fanbase, the status (Active/Retired), a description, a lore paragraph,
 * the hashtags, the likes and dislikes, the character sheet, and the links —
 * YouTube (a `@handle`, never a `UC…` id), Twitch, X and whatever else the
 * performer publishes. The subscriber and Twitch follower counts are exact in
 * a `title` attribute, even though the page displays `63.6K`.
 *
 * The links are the point. A record this catalogue tracks is often missing
 * the Twitch or X account the performer actually uses, and hololist files it
 * beside the YouTube channel it belongs to.
 */

import { languageCodesFromNames } from "./regions";

/** One profile link an entry publishes. */
export interface HoloListLink {
  /** The host, folded to the platform name the dataset knows. */
  platform: string;
  url: string;
}

/** One hololist.net entry, parsed. */
export interface HoloListEntry {
  url: string;
  slug: string;
  name: string;
  nicknames: string[];
  /** `V-Tuber`, `V-Streamer`, `V-Singer`, `V-UP`. */
  types: string[];
  categories: string[];
  tags: string[];
  /** `Gaming`, `Singing`, … */
  content: string[];
  /** `MM-DD`, without a year — the site publishes a birthday, not a birth date. */
  birthday: string | null;
  /** `YYYY-MM-DD`. */
  debut: string | null;
  /** Centimetres. */
  height: number | null;
  zodiac: string | null;
  affiliation: string | null;
  /** The languages as codes, in the order the entry lists them. */
  languages: string[];
  /** The languages as the entry writes them (`English`, `Japanese`). */
  languageNames: string[];
  gender: string | null;
  model: string | null;
  oshiMark: string | null;
  fanbase: string | null;
  /** `Active`, `Retired`, … */
  status: string | null;
  description: string | null;
  lore: string | null;
  hashtags: string[];
  links: HoloListLink[];
  subscribers: number | null;
  twitchFollowers: number | null;
  /** The sitemap's `<lastmod>`, so a later run can skip unchanged entries. */
  lastmod: string | null;
}

/** One URL and its `<lastmod>` from a sitemap. */
export interface HoloListSitemapEntry {
  url: string;
  lastmod: string | null;
}

/* -------------------------------------------------------------------------- */
/* Text helpers                                                               */
/* -------------------------------------------------------------------------- */

const ENTITIES: Record<string, string> = {
  amp: "&",
  quot: '"',
  apos: "'",
  lt: "<",
  gt: ">",
  nbsp: " ",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  prime: "′",
  Prime: "″",
  rsquo: "’",
  lsquo: "‘",
  ldquo: "“",
  rdquo: "”",
  middot: "·",
  bull: "•",
  times: "×",
};

/** Decodes the entities a name, a description or a count can carry. */
export function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body: string) => {
    if (body.startsWith("#")) {
      const hex = body[1] === "x" || body[1] === "X";
      const code = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body] ?? ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/** Strips markup and collapses whitespace. */
export function textOf(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

/** The values a roster writes when it has nothing to say. */
const PLACEHOLDERS = new Set(["....", "…", "...", "-", "—", "–", "n/a", "na", "unknown", "tba"]);

function valueOf(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed || PLACEHOLDERS.has(trimmed.toLowerCase())) return null;
  return trimmed;
}

/* -------------------------------------------------------------------------- */
/* Entry parsing                                                              */
/* -------------------------------------------------------------------------- */

const MONTHS: Record<string, number> = {
  january: 1,
  february: 2,
  march: 3,
  april: 4,
  may: 5,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  october: 10,
  november: 11,
  december: 12,
};

/** `May 3, 2024` → `2024-05-03`; `October 28` → `10-28`. */
export function parseHoloListDate(input: string, withYear: boolean): string | null {
  const text = input.trim();
  const month = /([A-Za-z]+)/.exec(text)?.[1]?.toLowerCase();
  if (!month || !(month in MONTHS)) return null;
  const day = /(?:[A-Za-z]+)\s+(\d{1,2})/.exec(text)?.[1];
  if (!day) return null;
  const mm = String(MONTHS[month]).padStart(2, "0");
  const dd = String(Number(day)).padStart(2, "0");
  if (Number(dd) < 1 || Number(dd) > 31) return null;
  if (!withYear) return `${mm}-${dd}`;
  const year = /(\d{4})/.exec(text)?.[1];
  if (!year) return null;
  return `${year}-${mm}-${dd}`;
}

/** `135 cm (4′5″)` → `135`. */
export function parseHoloListHeight(input: string): number | null {
  const cm = /(\d{2,3})\s*cm/i.exec(input)?.[1];
  if (cm) {
    const value = Number(cm);
    return value >= 100 && value <= 250 ? value : null;
  }
  /* The imperial form is the fallback: `4′5″` is 134.6 cm. */
  const feet = /(\d)\s*(?:′|'|ft)/i.exec(input)?.[1];
  const inches = /(?:′|'|ft)\s*(\d{1,2})/.exec(input)?.[1] ?? "0";
  if (!feet) return null;
  const value = Math.round(Number(feet) * 30.48 + Number(inches) * 2.54);
  return value >= 100 && value <= 250 ? value : null;
}

/**
 * The `<section id="…">` blocks of an entry.
 *
 * A section runs to the next `</section>`, and none of them nest — the
 * character sheet and the links are the only ones with markup inside, and it
 * is `<div>`, `<ul>` and `<a>`.
 */
function sectionsOf(html: string): Map<string, string> {
  const sections = new Map<string, string>();
  const re = /<section id="([a-z0-9-]+)"[^>]*>([\s\S]*?)<\/section>/gi;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    /**
     * The label is markup, not data: `<h2>Gender</h2> Female` is a section
     * whose value is `Female`, and keeping the heading would file every
     * gender as "Gender Female".
     */
    const body = m[2]!.replace(/^\s*<h2\b[\s\S]*?<\/h2>/i, "");
    sections.set(m[1]!.toLowerCase(), body);
  }
  return sections;
}

function anchorsOf(html: string): { text: string; href: string }[] {
  const out: { text: string; href: string }[] = [];
  const re = /<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    out.push({ href: decodeEntities(m[1]!), text: textOf(m[2]!) });
  }
  return out;
}

/**
 * The values of a list section.
 *
 * The site writes the same thing three ways — anchors separated by commas,
 * `<li>` items, and plain comma-separated text — so the parser reads the
 * richest form present rather than guessing from the section name.
 */
function itemsOf(html: string): string[] {
  const out: string[] = [];
  const push = (value: string | null) => {
    if (value && !out.includes(value)) out.push(value);
  };
  for (const { text } of anchorsOf(html)) push(valueOf(text));
  if (out.length) return out;
  for (const m of html.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)) {
    push(valueOf(textOf(m[1]!)));
  }
  if (out.length) return out;
  for (const text of textOf(html).split(",")) push(valueOf(text));
  return out;
}

/** The platforms whose profile URL is worth keeping, by host. */
function platformOfLink(url: string): string | null {
  let host: string;
  try {
    host = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
  if (/(^|\.)youtube\.com$|(^|\.)youtu\.be$/.test(host)) return "youtube";
  if (host === "twitch.tv") return "twitch";
  if (host === "x.com" || host === "twitter.com") return "twitter";
  if (host === "instagram.com") return "instagram";
  if (host === "tiktok.com") return "tiktok";
  if (host.endsWith("bilibili.com")) return "bilibili";
  if (host === "nicovideo.jp" || host === "nico.ms") return "niconico";
  if (host.endsWith("vk.com") || host === "vkvideo.ru") return "vk";
  if (host.endsWith("chzzk.naver.com")) return "chzzk";
  if (host === "kick.com") return "kick";
  if (host.endsWith("sooplive.com") || host === "sooplive.co.kr") return "soop";
  if (host === "ci.me") return "ci.me";
  return null;
}

/**
 * The links that are a performer's profile, not a share button or a support
 * page. The `#links` section groups them under "Channels", "Socials", "Q&A"
 * and "Supports"; only the first two are identities.
 */
function linksOf(section: string | undefined): HoloListLink[] {
  if (!section) return [];
  const out: HoloListLink[] = [];
  const seen = new Set<string>();
  for (const { href } of anchorsOf(section)) {
    const platform = platformOfLink(href);
    if (!platform) continue;
    const key = `${platform}:${href}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ platform, url: href });
  }
  return out;
}

/**
 * A section whose value is one or more links — `L2D`, `3D , L2D` — read from
 * the anchors so the join is the site's own comma and not a stray space.
 */
function valuesOf(section: string | undefined): string | null {
  if (!section) return null;
  const anchors = anchorsOf(section)
    .map((a) => valueOf(a.text))
    .filter((value): value is string => value !== null);
  if (anchors.length) return anchors.join(", ");
  return valueOf(textOf(section));
}

/** An exact count from a `title="63,600"` attribute beside a label. */
function titleCountOf(html: string, label: string): number | null {
  const re = new RegExp(
    `title="([\\d,]+)"[^>]*>[^<]*</a>\\s*<span[^>]*>\\s*${label}\\s*</span>`,
    "i",
  );
  const m = re.exec(html);
  if (!m) return null;
  const value = Number(m[1]!.replace(/,/g, ""));
  return Number.isFinite(value) ? value : null;
}

function slugOf(url: string): string {
  try {
    const path = new URL(url).pathname.replace(/^\/|\/$/g, "");
    return path || url;
  } catch {
    return url;
  }
}

/**
 * One entry page.
 *
 * Returns `null` when the page has no name — a Cloudflare interstitial, a 404
 * body or a redirect to the home page would all parse to nothing, and a row
 * without a name is worse than no row.
 */
export function parseHoloListEntry(
  html: string,
  url: string,
  lastmod: string | null = null,
): HoloListEntry | null {
  const sections = sectionsOf(html);

  const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1];
  const ogTitle = /<meta[^>]+property="og:title"[^>]+content="([^"]*)"/i.exec(html)?.[1];
  let name = valueOf(textOf(h1 ?? ""));
  if (!name && ogTitle) {
    /* `Akugaki Koa (ChromaSHIFT)` — the affiliation in parentheses. */
    name = valueOf(decodeEntities(ogTitle).replace(/\s*\([^)]*\)\s*$/, ""));
  }
  if (!name) return null;

  const typeAnchors = anchorsOf(sections.get("type") ?? "").map((a) => a.text);
  const affiliationLinks = anchorsOf(sections.get("affiliation") ?? "").map((a) => a.text);
  const languageNames = anchorsOf(sections.get("language") ?? "")
    .map((a) => a.text)
    .filter(Boolean);

  const statusText = valueOf(textOf(sections.get("status") ?? ""));
  const debut = parseHoloListDate(textOf(sections.get("debut") ?? ""), true);
  const birthday = parseHoloListDate(textOf(sections.get("birthday") ?? ""), false);
  const height = parseHoloListHeight(textOf(sections.get("height") ?? ""));

  return {
    url,
    slug: slugOf(url),
    name,
    nicknames: itemsOf(sections.get("nickname") ?? ""),
    types: typeAnchors.length ? typeAnchors : itemsOf(sections.get("type") ?? ""),
    categories: itemsOf(sections.get("category") ?? ""),
    tags: itemsOf(sections.get("tags") ?? ""),
    content: itemsOf(sections.get("content") ?? ""),
    birthday,
    debut,
    height,
    zodiac: valueOf(textOf(sections.get("zodiac") ?? "")),
    affiliation: affiliationLinks.length ? affiliationLinks.join(", ") : valueOf(textOf(sections.get("affiliation") ?? "")),
    languages: languageCodesFromNames(languageNames),
    languageNames,
    gender: valuesOf(sections.get("gender")),
    model: valuesOf(sections.get("model")),
    oshiMark: valueOf(textOf(sections.get("oshi-mark") ?? "")),
    fanbase: valueOf(textOf(sections.get("fanbase") ?? "")),
    status: statusText,
    description: valueOf(textOf(sections.get("description") ?? "")),
    lore: valueOf(textOf(sections.get("lore") ?? "")),
    /**
     * `#AkugakiKoa - General #AKGKart - Fan Art` — the tag is the first word
     * of each line; the rest is the site's own annotation of it.
     */
    hashtags: textOf(sections.get("hashtag") ?? "")
      .split(/\s+/)
      .filter((token) => token.startsWith("#") && token.length > 1)
      .map((token) => token.replace(/[.,;:]+$/, "")),
    links: linksOf(sections.get("links")),
    subscribers: titleCountOf(html, "subscribers on YouTube"),
    twitchFollowers: titleCountOf(html, "followers on Twitch"),
    lastmod,
  };
}

/* -------------------------------------------------------------------------- */
/* Sitemap                                                                    */
/* -------------------------------------------------------------------------- */

/** Every `<url>` in a WordPress core sitemap, with its `<lastmod>`. */
export function parseHoloListSitemap(xml: string): HoloListSitemapEntry[] {
  const out: HoloListSitemapEntry[] = [];
  const re = /<url>([\s\S]*?)<\/url>/gi;
  for (let m = re.exec(xml); m; m = re.exec(xml)) {
    const block = m[1]!;
    const url = /<loc>([\s\S]*?)<\/loc>/i.exec(block)?.[1]?.trim();
    if (!url) continue;
    const lastmod = /<lastmod>([\s\S]*?)<\/lastmod>/i.exec(block)?.[1]?.trim() ?? null;
    out.push({ url, lastmod });
  }
  return out;
}

/** The sitemap index's own `<loc>` list. */
export function parseSitemapIndex(xml: string): string[] {
  return [...xml.matchAll(/<sitemap>[\s\S]*?<loc>([\s\S]*?)<\/loc>[\s\S]*?<\/sitemap>/gi)].map(
    (m) => m[1]!.trim(),
  );
}

/* -------------------------------------------------------------------------- */
/* The snapshot                                                               */
/* -------------------------------------------------------------------------- */

/** The merged roster file the harvester writes and the importer reads. */
export interface HoloListSnapshot {
  generatedAt: string;
  source: string;
  /** The `<lastmod>` each entry had when it was last fetched. */
  entries: HoloListEntry[];
}

/** A YouTube identity a link carries: `UC…`, or an `@handle` to resolve. */
export function youTubeIdentityOf(
  links: readonly HoloListLink[],
): { channelId: string | null; handles: string[] } {
  let channelId: string | null = null;
  const handles: string[] = [];
  for (const { platform, url } of links) {
    if (platform !== "youtube") continue;
    const m = /youtube\.com\/channel\/(UC[\w-]{20,})/i.exec(url);
    if (m) {
      channelId ??= m[1]!;
      continue;
    }
    const handle = /youtube\.com\/@([A-Za-z0-9._-]+)/i.exec(url)?.[1];
    if (handle && !handles.includes(handle)) handles.push(handle);
  }
  return { channelId, handles };
}

/**
 * The activity a status states.
 *
 * `Active` is the normal case and `Retired` is the site's word for a
 * graduation — the one fact a roster knows that the platform never publishes.
 * `Inactive` and `Hiatus` are deliberately **not** a graduation: a performer
 * who has stopped streaming has not necessarily announced one, and the
 * dataset's `graduated` is a statement, not a guess.
 */
export function activityOfStatus(status: string | null): "active" | "graduated" | "unknown" {
  const value = (status ?? "").trim().toLowerCase();
  if (!value) return "unknown";
  if (value === "active" || value === "upcoming") return "active";
  if (value.includes("retire") || value.includes("graduat")) {
    return "graduated";
  }
  return "unknown";
}
