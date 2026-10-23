/**
 * vdb — the Virtual YouTuber Name List Database.
 *
 * Source: https://vdb.vtbs.moe
 * Data:   https://vdb.vtbs.moe/json/list.json
 *
 * A community-maintained roster of **~10,000 VTubers**, and the most
 * complete cross-platform catalogue available for free. Each record looks
 * like this:
 *
 * ```jsonc
 * {
 *   "uuid": "8e9b02ae-78ba-5f8b-b825-0c0af068abb7",
 *   "type": "vtuber",          // vtuber | group | fan | misc
 *   "bot": false,              // true for AI / bot accounts
 *   "accounts": [
 *     { "id": "UCoO6PIMIwatyMWRp7l6CvKQ", "type": "official", "platform": "youtube" },
 *     { "id": "333325107",       "type": "official", "platform": "bilibili" },
 *     { "id": "90274745",        "type": "official", "platform": "niconico" }
 *   ],
 *   "name": { "cn": "A.I.D", "en": "A.I.D", "default": "en" },
 *   "group": "…", "group_name": "…"
 * }
 * ```
 *
 * ## Why it matters here
 *
 * - **10,134 performers**, mostly Chinese, where the other sources are thin.
 * - **`name.default` is the language the catalogue displays**, which is a
 *   weak region signal: vdb is a Chinese wiki, so a Japanese performer is
 *   listed with `default: "cn"` whenever a Chinese rendition of the name
 *   exists. Kana in the `jp` name and a YouTube channel say more.
 * - **`bot` marks AI performers**, which is exactly the `isAi` flag the
 *   project needs.
 * - **`accounts[]` spans 35 platforms**, and `meta.linkSyntax` gives the URL
 *   template for each one — so the "all links" block can be filled in for
 *   performers who have no YouTube channel at all.
 */

import { detectLanguage } from "./regions";
import { classifyChannel } from "./classify";
import type { ArtistKind, PlatformId, RegionCode } from "./types";
import type { PlatformLink } from "./types";

const LIST_URL = "https://vdb.vtbs.moe/json/list.json";

/**
 * Hiragana and katakana.
 *
 * They occur in Japanese and nowhere else — not in Chinese, not in Korean —
 * so their presence in a name is a decisive statement that the name is
 * Japanese.
 */
const KANA = /[\u3040-\u309f\u30a0-\u30ff]/;

interface VdbAccount {
  id: string;
  type: string;
  platform: string;
}

interface VdbRecord {
  uuid: string;
  type: string;
  bot: boolean;
  accounts: VdbAccount[];
  name: {
    default?: string;
    cn?: string;
    jp?: string;
    en?: string;
    extra?: string[];
    [key: string]: unknown;
  };
  group?: string;
  group_name?: string;
}

interface VdbFile {
  meta?: {
    linkSyntax?: Record<string, string>;
  };
  vtbs?: VdbRecord[];
}

/** Normalizes vdb aliases for platforms with a project-wide canonical id. */
const PLATFORM_MAP: Record<string, PlatformId> = {
  youtube: "youtube",
  youtubeAt: "youtube",
};

function platformId(value: string): PlatformId | null {
  const mapped = PLATFORM_MAP[value];
  if (mapped) return mapped;
  return /^[a-z][a-zA-Z0-9.-]{0,31}$/.test(value) ? value : null;
}

/**
 * Maps the language a performer lists as their default onto a region.
 *
 * This is the authoritative region signal vdb provides — the performer's own
 * listing says which language they perform in.
 */
const REGION_BY_LANGUAGE: Record<string, RegionCode> = {
  cn: "cn",
  CN: "cn",
  Cn: "cn",
  "zh-cn": "cn",
  "cn+": "cn",
  cnen: "en",
  jp: "jp",
  JP: "jp",
  en: "en",
  EN: "en",
  ID: "id",
  "ID(印度尼西亚)": "id",
  kr: "kr",
  KR: "kr",
};

/**
 * The region a vdb group belongs to.
 *
 * vdb records the agency in `group_name`, and an agency's branch is one of
 * the strongest region signals there is: a Hololive EN member is English, a
 * VirtuaReal member is Chinese, a Hololive member is Japanese — whatever
 * language their name is written in.
 *
 * The keys are matched against the lowercased group name, longest first, so
 * `hololive en` always beats `hololive`.
 */
const GROUP_REGION: Record<string, RegionCode> = {
  hololive: "jp",
  "hololive en": "en",
  "hololive english": "en",
  "hololive indonesia": "id",
  "hololive id": "id",
  "hololive dev_is": "id",
  "hololivecn": "cn",
  nijisanji: "jp",
  "nijisanji en": "en",
  "nijisanji id": "id",
  "nijisanji kr": "kr",
  "nijisanji cn": "cn",
  virtuareal: "cn",
  "propro production": "jp",
  entum: "jp",
  upd8: "jp",
  noripro: "jp",
  noreact: "jp",
  "re:act": "jp",
  "vspo!": "jp",
  vspo: "jp",
  "honey strap": "jp",
  "riot music": "jp",
  kamitsubaki: "jp",
  "kamitsubaki studio": "jp",
  winks: "jp",
  "神楽组": "jp",
  wactor: "jp",
};

/** The region of the longest group name that matches, if any. */
function regionOfGroup(group: string | null | undefined): RegionCode | null {
  if (!group) return null;
  const needle = group.trim().toLowerCase();
  if (!needle) return null;
  let best: string | null = null;
  for (const key of Object.keys(GROUP_REGION)) {
    if (!needle.includes(key)) continue;
    if (!best || key.length > best.length) best = key;
  }
  return best ? (GROUP_REGION[best] ?? null) : null;
}

export interface VdbVTuber {
  /** vdb's own uuid. */
  uuid: string;
  /** The canonical channel id for this project. */
  id: string;
  /** Display name. */
  name: string;
  /** Alternative names. */
  aliases: string[];
  /** `virtual` | `real`. */
  kind: ArtistKind;
  /** The region, from the performer's own language listing. */
  region: RegionCode;
  /** How the region was determined. */
  regionSource: "declared" | "platform" | "script" | "agency" | "name";
  /** Agency or group. */
  group: string | null;
  /** True for AI / bot accounts. */
  isAi: boolean;
  /** True for fan or clip channels. */
  isAggregator: boolean;
  /** Every platform identity. */
  platforms: PlatformLink[];
}

/** Locale keys that vdb sometimes records as the performer's name. */
const LOCALE_KEYS = new Set([
  "cn", "jp", "en", "id", "kr", "zh-cn", "zh-hant", "cn+", "cnen",
]);

export class VdbSource {
  private cache: VdbVTuber[] | null = null;
  private linkSyntax: Record<string, string> = {};
  private available = false;

  get isAvailable(): boolean {
    return this.available;
  }

  /** Fetches and parses the roster. Cached for the process lifetime. */
  async fetch(): Promise<VdbVTuber[]> {
    if (this.cache) return this.cache;

    try {
      const res = await fetch(LIST_URL, {
        headers: {
          Accept: "application/json",
          "User-Agent": "VSingerSingerTracker/1.0",
        },
      });
      if (!res.ok) return [];
      const json = (await res.json()) as VdbFile;
      if (!Array.isArray(json.vtbs) || json.vtbs.length === 0) return [];
      this.linkSyntax = json.meta?.linkSyntax ?? {};

      const out: VdbVTuber[] = [];
      for (const record of json.vtbs ?? []) {
        const parsed = this.parse(record);
        if (parsed) out.push(parsed);
      }
      this.available = out.length > 0;
      this.cache = out;
      return out;
    } catch {
      return [];
    }
  }

  private buildUrl(platform: string, id: string): string {
    /**
     * A `youtube` account that is not a `UC…` channel id is a handle.
     *
     * vdb files one performer under both `youtubeAt` (a handle) and `youtube`
     * (a channel id), and the second value is sometimes another handle —
     * `youtube.com/channel/KiichanYT` is not a page, `youtube.com/@KiichanYT`
     * is.
     */
    if (platform === "youtube" && !id.startsWith("UC")) {
      return `https://www.youtube.com/@${encodeURIComponent(id)}`;
    }
    const template = this.linkSyntax[platform];
    if (!template) return `https://${platform}/${id}`;
    return template.replace("{id}", encodeURIComponent(id));
  }

  private parse(record: VdbRecord): VdbVTuber | null {
    const names = record.name ?? {};
    const name =
      (typeof names.cn === "string" && names.cn) ||
      (typeof names.jp === "string" && names.jp) ||
      (typeof names.en === "string" && names.en) ||
      names.default ||
      "";
    if (!name || typeof name !== "string") return null;

    // Some vdb entries have the locale key as the name (`name.cn === "cn"`).
    // Those are malformed records, not performers.
    if (LOCALE_KEYS.has(name.trim().toLowerCase())) return null;

    /**
     * Every name the performer is listed under.
     *
     * vdb keeps a name per locale — `cn`, `jp`, `en` — and the ones that do
     * not fit a locale in `extra`. The record shows one of them; the rest
     * are **aliases**, so a channel is findable under the name it is known
     * by in each language.
     *
     * 「空星きらめ」 and 「Sorahoshi Kirame」 are one performer, and a search
     * for either has to find them.
     */
    const aliases: string[] = [];
    for (const key of ["cn", "jp", "en", "extra"]) {
      const value = (names as Record<string, unknown>)[key];
      if (typeof value === "string") {
        if (value.trim()) aliases.push(value.trim());
        continue;
      }
      if (Array.isArray(value)) {
        for (const item of value) {
          if (typeof item === "string" && item.trim()) {
            aliases.push(item.trim());
          }
        }
      }
    }
    // Every variant, once. Which one the record *shows* is decided below,
    // from the region — so 「巫天翼」 is not filtered out here.
    const uniqueAliases: string[] = [];
    for (const alias of aliases) {
      if (
        !uniqueAliases.some(
          (a) => a.toLowerCase() === alias.toLowerCase(),
        )
      ) {
        uniqueAliases.push(alias);
      }
    }

    /* --- platform identities ------------------------------------------- */
    const platforms: PlatformLink[] = [];
    /** How good a YouTube identity is: a channel id, then a handle. */
    const youtubeRank = (account: VdbAccount): number =>
      account.platform === "youtubeAt"
        ? 2
        : account.id.startsWith("UC")
          ? 3
          : 1;
    let youtubeAccount: VdbAccount | null = null;
    for (const account of record.accounts ?? []) {
      if (!account?.id || typeof account.platform !== "string") continue;
      const mapped = platformId(account.platform);
      if (!mapped) continue;

      /**
       * One YouTube identity per performer.
       *
       * vdb lists the same channel twice — once as `youtubeAt` and once as
       * `youtube` — so taking both would give the record two links to the
       * same channel, and the weaker one is usually a handle stored where a
       * `UC…` id belongs.
       */
      if (mapped === "youtube") {
        if (!youtubeAccount || youtubeRank(account) > youtubeRank(youtubeAccount)) {
          youtubeAccount = account;
        }
        continue;
      }

      const url = this.buildUrl(account.platform, account.id);
      platforms.push({
        platform: mapped,
        id: account.id,
        handle: null,
        name,
        url,
        subscribers: { tag: "hidden" },
        avatar: null,
        lastCheckedAt: new Date().toISOString(),
      });
    }
    if (youtubeAccount) {
      platforms.unshift({
        platform: "youtube",
        id: youtubeAccount.id,
        handle: youtubeAccount.platform === "youtubeAt" ? youtubeAccount.id : null,
        name,
        url: this.buildUrl(youtubeAccount.platform, youtubeAccount.id),
        subscribers: { tag: "hidden" },
        avatar: null,
        lastCheckedAt: new Date().toISOString(),
      });
    }

    /* --- the canonical id ---------------------------------------------- */
    const youtube = platforms.find((p) => p.platform === "youtube");
    const id = youtube
      ? youtube.id.startsWith("UC")
        ? youtube.id
        : `youtube:${youtube.id}`
      : platforms[0]
        ? `${platforms[0].platform}:${platforms[0].id}`
        : `vdb:${record.uuid}`;

    /* --- region ---------------------------------------------------------- */
    /**
     * Where the performer belongs.
     *
     * vdb offers three signals, and they are **not** equally good:
     *
     * 1. **The platforms.** A performer who only exists on Bilibili is
     *    mainland Chinese; one who only exists on Niconico is Japanese. A
     *    name written entirely in characters shared with Japanese
     *    (「樱咲奈央」, 「川烈」) would otherwise be read as Japanese.
     * 2. **A Japanese name and a YouTube channel.** Kana are unique to
     *    Japanese, so a `jp` variant that contains them belongs to a
     *    Japanese performer — and a performer with a YouTube channel who is
     *    also mirrored to Bilibili is still Japanese.
     * 3. **`name.default`** — the language the catalogue *displays*. It is
     *    the weakest of the three, and it is not a declaration of origin:
     *    vdb is a Chinese wiki, so 「巫てんり / Kannagi Tenri」 — a Japanese
     *    VTuber — is listed with `default: "cn"` because the Chinese
     *    rendition of her name (「巫天翼」) is the one the wiki shows.
     * 4. **The script of the name** — a guess, for everything left over.
     */
    const defaultLanguage =
      typeof names.default === "string" ? names.default : "";
    let region: RegionCode = "unknown";
    let regionSource: "declared" | "platform" | "script" | "agency" | "name" =
      "declared";

    const platformSet = new Set(platforms.map((p) => p.platform));
    const hasYouTube = platformSet.has("youtube");

    /**
     * The agency branch comes first.
     *
     * It is a statement about the group the performer belongs to, and it is
     * the same priority the classifier gives it — stronger than the platform
     * they stream on. A Hololive EN member with a Bilibili mirror is English,
     * and a VirtuaReal member with a Japanese-style name is Chinese.
     */
    const groupRegion = regionOfGroup(record.group_name ?? record.group);
    if (groupRegion) {
      region = groupRegion;
      regionSource = "agency";
    }

    /**
     * A performer with a **Bilibili account and no YouTube account** presents
     * to a mainland Chinese audience — that is where their audience is, and
     * the region records where they stream. The same goes for Niconico and
     * Japan. Their Chinese-subtitled Bilibili channel does not make a
     * YouTube performer a Chinese speaker.
     */
    if (!hasYouTube && region === "unknown") {
      if (platformSet.has("bilibili")) {
        region = "cn";
        regionSource = "platform";
      } else if (platformSet.has("niconico")) {
        region = "jp";
        regionSource = "platform";
      }
    }

    /**
     * A Japanese name and a YouTube channel.
     *
     * Kana are unique to Japanese — no Chinese or Korean name contains them —
     * so a `jp` variant with kana is a Japanese performer. That is a stronger
     * statement than `name.default`, and it is what keeps a Japanese VTuber
     * with a Bilibili mirror out of the Chinese region.
     */
    const jpName = typeof names.jp === "string" ? names.jp : "";
    if (region === "unknown" && hasYouTube && KANA.test(jpName)) {
      region = "jp";
      regionSource = "name";
    }

    if (region === "unknown") {
      region = REGION_BY_LANGUAGE[defaultLanguage] ?? "unknown";
      if (region !== "unknown") regionSource = "declared";
    }

    if (region === "unknown") {
      const lang = detectLanguage(name);
      if (lang === "ja") region = "jp";
      else if (lang === "ko") region = "kr";
      else if (lang === "zh-Hans") region = "cn";
      else if (lang === "zh-Hant") region = "tw";
      else if (lang === "en") region = "en";
      regionSource = "script";
    }

    /**
     * The name the record shows follows the region.
     *
     * vdb lists one name per locale, and picking `cn` first would show the
     * Chinese rendition of a Japanese performer's name — 「巫天翼」 for
     * 「巫てんり」. The region is the fact; the name should agree with it.
     */
    const displayName =
      (region === "jp" && typeof names.jp === "string" && names.jp) ||
      (region === "cn" && typeof names.cn === "string" && names.cn) ||
      (region === "tw" && typeof names.cn === "string" && names.cn) ||
      name;

    /* --- kind and role --------------------------------------------------- */
    const classification = classifyChannel({
      name: displayName,
      description: null,
      tags: [],
      country: null,
    });

    return {
      uuid: record.uuid,
      id,
      name: displayName,
      aliases: uniqueAliases.filter(
        (a) => a.toLowerCase() !== displayName.trim().toLowerCase(),
      ),
      kind: "virtual",
      region,
      regionSource,
      group: record.group_name ?? record.group ?? null,
      isAi: record.bot === true,
      isAggregator: record.type === "fan" || record.type === "misc",
      platforms,
    };
  }
}
