/**
 * bacharu.io — the roster and its records, reduced to what the dataset uses.
 *
 * bacharu publishes a JSON API in front of an Astro-or-Svelte front end:
 *
 *   `GET /api/vtubers?limit=100&page=N` — 100 full records a page
 *   `GET /api/vtubers/<_id>`           — one record
 *   `GET /api/vtubers?search=<name>`   — the same full records, filtered
 *   `GET /api/groups?limit=100`        — the groups, without their members
 *
 * There is no field projection worth the name: `fields=card` trims a record to
 * thirteen keys and **drops `social`**, so a card page has no YouTube id, and
 * every other value of `fields` returns the whole record. A full record is
 * about 25 KB — most of it `activity` (schedules, recent streams, tweets),
 * `beingMap`, `aiSummary` and the accent palette — against roughly 3 s per
 * hundred on the wire. The roster is 109,828 entries, so the whole thing is
 * 1,099 requests and about 2.9 GB, which is why this file throws the weight
 * away as soon as the record arrives and the harvester keeps only the extract.
 *
 * `robots.txt` says `Disallow: /api/` for every agent, so this is a source to
 * read once in a while, not to poll: see `harvest-bacharu.ts` for the pacing.
 *
 * What is worth keeping is what the dataset cannot get anywhere else at this
 * scale: the **YouTube channel id** — `social.youtube` is a `/channel/UC…`
 * URL or a `@handle` — beside the group, the debut, the status, the aliases
 * and the country the roster files the performer under.
 */

/** One link from `social.all`, narrowed to the platforms the dataset knows. */
export interface BacharuLink {
  platform: string;
  url: string;
  /** `main`, `alt`, `clips`, `shop`, … — bacharu's own label, when it has one. */
  role?: string;
}

/**
 * One performer, as bacharu records it and as the dataset wants it.
 *
 * The fields are deliberately flat and short: at ~800 bytes per entry the
 * whole roster is 90 MB, where the raw records would be 2.9 GB.
 */
export interface BacharuVtuber {
  /** bacharu's own ObjectId — the key its detail endpoint takes. */
  id: string;
  name: string | null;
  /** `rine-vartist` — the slug in `https://bacharu.io/vtuber/rine-vartist`. */
  canonicalName: string | null;
  /** `vtuber`, `vstreamer`, … — bacharu's own classification. */
  entityType: string | null;
  /** `active`, `graduated`, `hiatus`, … */
  status: string | null;
  /** Free text: `Twitch: 2022/04/15 Glitch Stars: 2024/06/14`. */
  debut: string | null;
  graduationDate: string | null;
  /** `current` and `former`, in bacharu's order. */
  groups: { name: string; canonicalName: string; status: string | null }[];
  /** ISO 3166-1 alpha-2 codes, lower-cased. */
  countries: string[];
  nationality: string | null;
  languages: string[];
  gender: string | null;
  /** Every other name the roster lists — romanisations, former names, stage names. */
  aliases: string[];
  tags: string[];
  social: { youtube: string | null; twitter: string | null; twitch: string | null };
  /** The whitelisted platforms, with their roles: the "all links" block. */
  links: BacharuLink[];
  /** `UC…` when `social.youtube` is a `/channel/` URL — the dataset's key. */
  youtubeId: string | null;
  /** `@handle` when the roster only publishes one. */
  youtubeHandle: string | null;
  subscribers: number | null;
  twitchFollowers: number | null;
  twitterFollowers: number | null;
  description: string | null;
  /** The avatar bacharu caches on its own CDN — a fallback until `data:details` runs. */
  avatar: string | null;
  banner: string | null;
  /** When bacharu first accepted the row (ObjectId time, ms). */
  addedAt: string | null;
  lastActiveAt: string | null;
  /** Set when the roster has merged this row into another: a duplicate. */
  redirectTo: string | null;
  /** `public`, `hidden`, … — a hidden row is not part of the roster. */
  visibility: string | null;
}

/** Platforms worth keeping from `social.all` — everything else is a shop link. */
const LINK_PLATFORMS = new Set([
  "youtube",
  "twitch",
  "twitter",
  "x",
  "bilibili",
  "niconico",
  "kick",
  "chzzk",
  "soop",
  "vk",
  "tiktok",
  "instagram",
  "website",
]);

/**
 * Reads the channel out of a YouTube URL.
 *
 * bacharu publishes three shapes: `youtube.com/channel/UC…` (the id, which is
 * what the dataset is keyed by), `youtube.com/@handle` (a name, so only a
 * candidate) and the legacy `youtube.com/c/…` and `/user/…` forms.
 */
export function parseYouTubeUrl(
  url: string | null | undefined,
): { youtubeId: string | null; youtubeHandle: string | null } {
  if (!url || typeof url !== "string") return { youtubeId: null, youtubeHandle: null };
  const text = url.trim();
  const id = /youtube\.com\/channel\/(UC[\w-]{20,})/i.exec(text)?.[1] ?? null;
  if (id) return { youtubeId: id, youtubeHandle: null };
  const handle =
    /youtube\.com\/@([\w.-]+)/i.exec(text)?.[1] ??
    /youtube\.com\/(?:c|user)\/([\w.-]+)/i.exec(text)?.[1] ??
    null;
  return { youtubeId: null, youtubeHandle: handle };
}

/** A trimmed string, or `null` — bacharu sends `""` as often as it sends `null`. */
function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** The first number in a value that may be a number, a numeric string or null. */
function count(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : null;
}

/** Epoch milliseconds → `2026-01-31`, so a diff stays readable. */
function day(value: unknown): string | null {
  const ms = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return new Date(ms).toISOString().slice(0, 10);
}

/** A string array, dropped when empty. */
function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(text).filter((entry): entry is string => entry !== null);
}

/** `social.youtube` and friends, normalised to a URL with a scheme. */
function socialUrl(value: unknown): string | null {
  const raw = text(value);
  if (!raw) return null;
  return /^https?:\/\//i.test(raw) ? raw : `https://${raw.replace(/^\/+/, "")}`;
}

/**
 * One raw record → the extract the dataset can use.
 *
 * Tolerates every missing field: the roster is user-contributed, and a record
 * with no group, no country and no YouTube link is still a name worth diffing
 * against the dataset.
 */
export function extractVtuber(raw: unknown): BacharuVtuber | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const id = text(record._id);
  const canonicalName = text(record.canonicalName);
  if (!id && !canonicalName) return null;

  const social = (record.social ?? {}) as Record<string, unknown>;
  const activity = (record.activity ?? {}) as Record<string, unknown>;
  const youtube = socialUrl(social.youtube);
  const { youtubeId, youtubeHandle } = parseYouTubeUrl(youtube);

  const groups = Array.isArray(record.groups)
    ? record.groups
        .map((group) => {
          if (!group || typeof group !== "object") return null;
          const entry = group as Record<string, unknown>;
          const name = text(entry.name);
          if (!name) return null;
          return {
            name,
            canonicalName: text(entry.canonicalName) ?? name,
            status: text(entry.status),
          };
        })
        .filter((group): group is BacharuVtuber["groups"][number] => group !== null)
    : [];

  const links: BacharuLink[] = Array.isArray(social.all)
    ? social.all
        .map((entry) => {
          if (!entry || typeof entry !== "object") return null;
          const link = entry as Record<string, unknown>;
          const platform = text(link.platform)?.toLowerCase();
          const url = socialUrl(link.url);
          if (!platform || !url || !LINK_PLATFORMS.has(platform)) return null;
          return {
            platform: platform === "x" ? "twitter" : platform,
            url,
            ...(text(link.role) ? { role: text(link.role) as string } : {}),
          };
        })
        .filter((link): link is BacharuLink => link !== null)
    : [];

  const youtubeActivity = (activity.youtube ?? {}) as Record<string, unknown>;
  const twitchActivity = (activity.twitch ?? {}) as Record<string, unknown>;
  const twitterActivity = (activity.twitter ?? {}) as Record<string, unknown>;

  return {
    id: id ?? canonicalName!,
    name: text(record.name),
    canonicalName: canonicalName ?? id,
    entityType: text(record.entityType),
    status: text(record.status),
    debut: text(record.debut),
    graduationDate: text(record.graduationDate),
    groups,
    countries: strings(record.countries).map((country) => country.toLowerCase()),
    nationality: text(record.nationality),
    languages: strings(record.languages),
    gender: text(record.gender),
    aliases: strings(record.aliases),
    tags: strings(record.tags),
    social: {
      youtube,
      twitter: socialUrl(social.twitter),
      twitch: socialUrl(social.twitch),
    },
    links,
    youtubeId,
    youtubeHandle,
    subscribers: count(youtubeActivity.subscriberCount),
    twitchFollowers: count(twitchActivity.followerCount),
    twitterFollowers: count(twitterActivity.followerCount),
    description: text(record.description),
    avatar: socialUrl(record.img),
    banner: socialUrl(record.banner),
    addedAt: day(record.createdAt),
    lastActiveAt: day(record.lastActiveAt),
    redirectTo: text(record.redirectTo),
    visibility: text(record.visibility),
  };
}

/** `extractVtuber` over a page, skipping the rows it cannot key. */
export function extractPage(raw: unknown): BacharuVtuber[] {
  const rows = Array.isArray(raw) ? raw : [];
  return rows
    .map(extractVtuber)
    .filter((entry): entry is BacharuVtuber => entry !== null);
}

/* -------------------------------------------------------------------------- */
/* Comparing a roster name with the platform's                                */
/* -------------------------------------------------------------------------- */

/**
 * A name reduced to the characters a comparison can use.
 *
 * Rosters stylise names with digits — `0sito_08` for `Osito_08`,
 * `1sei0dzi1` for `_Seidzi_` — so the digits are folded to the letters they
 * stand in for **on both sides**, and the punctuation is dropped. Folding both
 * is what makes the substitution a match rather than a difference.
 */
export function foldName(text: string | null | undefined): string {
  if (!text) return "";
  return text
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/0/g, "o")
    .replace(/1/g, "i")
    .replace(/3/g, "e")
    .replace(/4/g, "a")
    .replace(/5/g, "s")
    .replace(/7/g, "t")
    .replace(/[^a-z\u3040-\u30ff\u4e00-\u9fff]/g, "");
}

/**
 * How much of the longer string the shorter one covers, as a subsequence.
 *
 * `1sei0dzi1` and `_Seidzi_` are the same channel, and so are `0mr_sane0` and
 * `Mr Sane`; two names that share almost nothing — `0chroma` and
 * `Lilith Tepes Ch.` — share about a fifth.
 */
export function nameSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  const rows = a.length + 1;
  const cols = b.length + 1;
  const dp: number[][] = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1] + 1
          : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[rows - 1][cols - 1] / Math.max(a.length, b.length);
}

/** How close two names have to be to be called the same performer. */
const NAME_SIMILARITY = 0.55;

/**
 * Whether the platform's title could be the name the roster gave.
 *
 * This is a **report**, not a gate: bacharu's link is the performer's own, and
 * refusing a row because a roster wrote `0sito_08` where the channel writes
 * `Osito_08` would throw away a fifth of the roster. The importer counts the
 * disagreements instead, so a genuinely wrong id — `0chroma` pointing at
 * `Lilith Tepes Ch.` — is reviewable without being a silent record.
 */
export function namesAgree(
  platformName: string | null | undefined,
  expected: string[],
): boolean {
  const candidate = foldName(platformName);
  const needles = expected.map(foldName).filter(Boolean);
  if (needles.length === 0) return true;
  if (!candidate) return false;
  return needles.some(
    (needle) =>
      candidate.includes(needle) ||
      needle.includes(candidate) ||
      nameSimilarity(needle, candidate) >= NAME_SIMILARITY,
  );
}

/* -------------------------------------------------------------------------- */
/* Languages                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * bacharu's language names in this dataset's codes.
 *
 * The roster writes a language the way a person does — `Japanese`,
 * `taiwanese`, `cantonese` — and the pipeline needs a code, because the code
 * is what picks the UI language YouTube answers a profile in. A language
 * outside this table is dropped rather than guessed: the profile then falls
 * back to the region, which is the answer it had before.
 */
const LANGUAGE_CODES: Record<string, string> = {
  english: "en",
  japanese: "ja",
  chinese: "zh-Hans",
  mandarin: "zh-Hans",
  taiwanese: "zh-Hant",
  cantonese: "yue",
  hakka: "zh-Hant",
  indonesian: "id",
  malay: "ms",
  filipino: "tl",
  tagalog: "tl",
  spanish: "es",
  portuguese: "pt",
  german: "de",
  french: "fr",
  italian: "it",
  dutch: "nl",
  polish: "pl",
  swedish: "sv",
  danish: "da",
  norwegian: "no",
  finnish: "fi",
  russian: "ru",
  ukrainian: "uk",
  czech: "cs",
  slovak: "sk",
  hungarian: "hu",
  romanian: "ro",
  croatian: "hr",
  serbian: "sr",
  bosnian: "bs",
  greek: "el",
  turkish: "tr",
  arabic: "ar",
  hebrew: "he",
  hindi: "hi",
  thai: "th",
  vietnamese: "vi",
  khmer: "km",
  burmese: "my",
  bengali: "bn",
  tamil: "ta",
  korean: "ko",
  javanese: "jv",
  sundanese: "su",
  catalan: "ca",
  galician: "gl",
  irish: "ga",
  afrikaans: "af",
  latin: "la",
  hmong: "hmn",
  guarani: "gn",
  armenian: "hy",
  luxembourgish: "lb",
  persian: "fa",
  kazakh: "kk",
  belarusian: "be",
};

/**
 * The codes for the languages a roster row states.
 *
 * Duplicates are collapsed and order is kept: the first language a performer
 * lists is the one their stream is in, and that is the one the profile is
 * asked for in.
 */
export function rosterLanguageCodes(values: readonly string[]): string[] {
  const codes: string[] = [];
  for (const value of values) {
    const code = LANGUAGE_CODES[value.trim().toLowerCase()];
    if (code && !codes.includes(code)) codes.push(code);
  }
  return codes;
}
