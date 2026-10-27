/**
 * vTubie's **groups** directory — parsing.
 *
 * `/groups/?pg=N` lists the groups (agencies and circles) ten to a page, and
 * `/g/<slug>/` lists that group's members. A member's own page then states
 * the group it belongs to, the debut date, the status, the Twitter handle and
 * — the reason this file exists — a YouTube RSS link carrying the real
 * `channel_id`.
 *
 * That `channel_id` is what makes this directory worth reading: the
 * `/allvtubers/` listing only publishes a *name*, which then has to be
 * searched for and guessed at, while a group page hands over the id that the
 * dataset is keyed by.
 *
 * The markup is a WordPress theme, so the parse is deliberately narrow: it
 * keys off the classes the theme uses (`ma-n-bro-cont`, `ma-section-title`)
 * rather than the shape of the surrounding page, and returns nothing rather
 * than throwing when a page has been redesigned.
 */

/** One row of the groups listing. */
export interface VtubieGroupCard {
  /** `zig` for `https://vtubie.com/g/zig/`. */
  slug: string;
  /** The name the directory publishes. */
  name: string;
  /** How many members the card claims, when it says. */
  memberCount: number | null;
  /** How many videos the card claims, when it says. */
  videoCount: number | null;
}

/** One member as a group page lists it. */
export interface VtubieMemberRef {
  /** `musubi-kokoa` for `https://vtubie.com/musubi-kokoa/`. */
  slug: string;
  /** The name the group page prints. */
  name: string;
}

/** A performer's profile page, reduced to the fields the dataset uses. */
export interface VtubieProfile {
  slug: string;
  name: string;
  /** `VTuber`, `VStreamer`, … */
  types: string[];
  /** The region the profile tags, as the tag's own code: `jp`, `en`, `id`. */
  region: string | null;
  /** The groups the profile claims, by name. */
  groups: string[];
  /** `2018-07-26`, when the profile dates the debut. */
  debutDate: string | null;
  /** `active`, `graduated`, `hiatus` — lower-cased, or `null` when unstated. */
  status: string | null;
  /** Twitter/X handle, without the `@`. */
  twitter: string | null;
  /** The YouTube channel id from the RSS link — the dataset's key. */
  youtubeId: string | null;
  /** `female`, `male`, `non-binary`, … */
  gender: string | null;
  /** `japanese`, `english`, … */
  languages: string[];
  /** The directory's own description, trimmed. */
  description: string | null;
  /** `8000` from `8k subs`, when the page prints a count. */
  subscribers: number | null;
}

/* -------------------------------------------------------------------------- */
/* Groups listing                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Reads one page of `/groups/`.
 *
 * A card is a `<td class="ma-n-bro-cont">` holding the title, an optional
 * description and a stats line; the same group appears twice per row (the
 * cover image links there too), so entries are de-duplicated by slug.
 */
export function parseGroupListing(html: string): VtubieGroupCard[] {
  const cards: VtubieGroupCard[] = [];
  const seen = new Set<string>();

  for (const chunk of html.split('class="ma-n-bro-cont"').slice(1)) {
    const slice = chunk.slice(0, 3_000);
    const slug = /href="https:\/\/vtubie\.com\/g\/([^"]+)\/"/.exec(slice)?.[1];
    if (!slug) continue;
    const decoded = decodeSlug(slug);
    if (!decoded || seen.has(decoded)) continue;

    const name = text(
      /class="ma-n-bro-title"[^>]*>([\s\S]*?)<\/div>/.exec(slice)?.[1] ?? "",
    );
    if (!name) continue;

    seen.add(decoded);
    cards.push({
      slug: decoded,
      name,
      memberCount: number(
        /class="ma-n-bro-stats-series"[^>]*>\s*VTubers\s*([0-9,]+)/.exec(slice)?.[1],
      ),
      videoCount: number(
        /class="ma-n-bro-stats-rel"[^>]*>\s*Videos\s*([0-9,]+)/.exec(slice)?.[1],
      ),
    });
  }

  return cards;
}

/** Does this page have a next one? */
export function groupListingHasNext(html: string): boolean {
  return /class="ma-pag-next"/.test(html);
}

/* -------------------------------------------------------------------------- */
/* One group's members                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Reads the member list from `/g/<slug>/`.
 *
 * The members sit in `div.ma-group-series-listing ul li a`. A large group is
 * sometimes split into more than one such block — current members and former
 * ones — so every block is read, each ending at the next section title so the
 * "Latest Videos" table below cannot leak its performers into the list. The
 * sidebar "random VTuber" links are a different container and are deliberately
 * not read.
 */
export function parseGroupMembers(html: string): VtubieMemberRef[] {
  const members: VtubieMemberRef[] = [];
  const seen = new Set<string>();

  for (const block of memberBlocks(html)) {
    for (const match of block.matchAll(
      /<a href="https:\/\/vtubie\.com\/([^"/]+)\/">([\s\S]*?)<\/a>/g,
    )) {
      const slug = decodeSlug(match[1]!);
      const name = text(match[2]!);
      if (!slug || !name || seen.has(slug)) continue;
      seen.add(slug);
      members.push({ slug, name });
    }
  }

  return members;
}

/**
 * Every member block on the page, each cut at the section that follows it.
 *
 * Cutting at `ma-section-title` rather than at the block's own `</ul>` is what
 * makes this work: a member list can nest a `<ul>` (a group inside a group),
 * and the first `</ul>` would end the block in the middle of the roster.
 */
function memberBlocks(html: string): string[] {
  const blocks: string[] = [];
  for (const start of classIndexAll(html, "ma-group-series-listing")) {
    const nextTitle = html.indexOf("ma-section-title", start + 20);
    const end = nextTitle > start ? nextTitle : Math.min(html.length, start + 20_000);
    blocks.push(html.slice(start, end));
  }
  return blocks;
}

/* -------------------------------------------------------------------------- */
/* One profile                                                                */
/* -------------------------------------------------------------------------- */

/** Reads `/ <slug> /`, returning `null` when the page is not a profile. */
export function parseProfile(html: string, slug: string): VtubieProfile | null {
  const name = text(
    /<h1 class="ma-nov-page-title">([\s\S]*?)<\/h1>/.exec(html)?.[1] ?? "",
  );
  if (!name) return null;

  return {
    slug,
    name,
    types: list(html, "ma-nov-field-ul-type"),
    region: regionOf(html),
    groups: list(html, "ma-nov-field-ul-groups"),
    debutDate: isoDate(sectionBody(html, "Debut")),
    status: lower(sectionBody(html, "Status")),
    twitter: twitterHandle(html),
    youtubeId: youtubeChannelId(html),
    gender: lower(/href="\/gender\/([a-z-]+)\/"/.exec(html)?.[1] ?? ""),
    languages: [...html.matchAll(/href="\/language\/([a-z-]+)\/"/g)].map(
      (m) => m[1]!,
    ),
    description: text(
      /class="ma-section-body ma-section-description"[^>]*>\s*<p>([\s\S]*?)<\/p>/.exec(
        html,
      )?.[1] ?? "",
    ) || null,
    subscribers: count(/title="([0-9]+) subscribers"/.exec(html)?.[1]),
  };
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/** The `<li>` anchors inside one `ul` with the given class. */
function list(html: string, className: string): string[] {
  const start = classIndex(html, className);
  if (start < 0) return [];
  const block = html.slice(start, html.indexOf("</ul>", start));
  return [...block.matchAll(/<a [^>]*>([\s\S]*?)<\/a>/g)]
    .map((match) => text(match[1]!))
    .filter(Boolean);
}

/**
 * Where `class="… <className> …"` starts.
 *
 * The theme inlines its stylesheet, and that stylesheet names every class it
 * styles — so a plain `indexOf("ma-nov-field-ul-type")` finds the rule in
 * `<head>` and happily reads the navigation between the two. Anchoring on the
 * attribute is what keeps the parse inside the document.
 */
function classIndex(html: string, className: string): number {
  const match = new RegExp(`class="[^"]*\\b${className}\\b[^"]*"`).exec(html);
  return match ? match.index : -1;
}

/** Every place the document opens an element with this class. */
function classIndexAll(html: string, className: string): number[] {
  const pattern = new RegExp(`class="[^"]*\\b${className}\\b[^"]*"`, "g");
  return [...html.matchAll(pattern)].map((match) => match.index ?? -1).filter((index) => index >= 0);
}

/**
 * The body of the section titled `label`.
 *
 * A field such as `Debut` is a title followed by one `ma-section-body`; the
 * body ends at the next title. Reading it this way keeps the parse working
 * whether or not the value is wrapped in a link, which the theme varies.
 */
function sectionBody(html: string, label: string): string {
  const title = new RegExp(`>${label}(?=[\\s<])`);
  const found = title.exec(html);
  if (!found) return "";
  const after = html.slice(found.index, found.index + 1_500);
  const body = /class="ma-section-body"[^>]*>([\s\S]*?)<\/div>/.exec(after)?.[1];
  return text(body ?? "");
}

/** `[JP]` → `jp`, from the tag printed beside the type. */
function regionOf(html: string): string | null {
  const short = /class="ma-lang-short ma-lang-short-([a-z]{2,3})"/.exec(html)?.[1];
  return short ?? null;
}

function youtubeChannelId(html: string): string | null {
  const id =
    /youtube\.com\/feeds\/videos\.xml\?channel_id=([A-Za-z0-9_-]+)/.exec(html)?.[1] ??
    /youtube\.com\/channel\/([A-Za-z0-9_-]{20,})/.exec(html)?.[1];
  return id && /^UC[\w-]{20,}$/.test(id) ? id : null;
}

function twitterHandle(html: string): string | null {
  const handle =
    /href="https:\/\/(?:www\.)?(?:twitter|x)\.com\/([A-Za-z0-9_]{1,15})"/.exec(
      html,
    )?.[1] ?? null;
  if (!handle) return null;
  // The site's own account is in the footer of every page.
  return /^(vtubie|intent|share)$/i.test(handle) ? null : handle;
}

/** `2018/07/26` or `July 26, 2018` → `2018-07-26`. */
function isoDate(value: string): string | null {
  const slashed = /(\d{4})[/-](\d{1,2})[/-](\d{1,2})/.exec(value);
  if (slashed) {
    return `${slashed[1]}-${slashed[2]!.padStart(2, "0")}-${slashed[3]!.padStart(2, "0")}`;
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return null;
  return new Date(parsed).toISOString().slice(0, 10);
}

/** `8k` → 8000, `1.2m` → 1200000. */
function count(value: string | undefined): number | null {
  if (!value) return null;
  const match = /^([0-9]+(?:\.[0-9]+)?)\s*([km])?$/i.exec(value.trim());
  if (!match) return null;
  const scale = match[2]?.toLowerCase() === "m" ? 1_000_000 : match[2] ? 1_000 : 1;
  return Math.round(Number(match[1]) * scale);
}

function number(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value.replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function lower(value: string): string | null {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed || trimmed === "+ add") return null;
  return trimmed;
}

function decodeSlug(value: string): string | null {
  try {
    return decodeURIComponent(value.replace(/&#0*38;/g, "&"));
  } catch {
    return value;
  }
}

/** Strips tags, decodes the entities the theme emits, and trims. */
function text(value: string): string {
  return decodeEntities(value.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  hellip: "…",
  rsquo: "’",
  lsquo: "‘",
  ldquo: "“",
  rdquo: "”",
  mdash: "—",
  ndash: "–",
};

function decodeEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, dec: string) =>
      String.fromCodePoint(Number.parseInt(dec, 10)),
    )
    .replace(/&([a-z]+);/gi, (match, name: string) => ENTITIES[name.toLowerCase()] ?? match);
}
