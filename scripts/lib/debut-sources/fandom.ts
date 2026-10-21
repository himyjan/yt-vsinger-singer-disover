/**
 * Virtual YouTuber Wiki (Fandom) debut source.
 *
 * The wiki exposes a public MediaWiki API — no key, no rate-limit quota of
 * consequence — and every performer page carries a `{{Character}}` infobox
 * with exactly the fields this project needs:
 *
 *   {{Character
 *   | title1        = Sameko Saba
 *   | nick_name     = Mack the Fish Girl
 *   | debut_date    = YouTube: 2025/06/28
 *   | retirement_date =
 *   | affiliation   = Independent
 *   | channel       = [https://www.youtube.com/@SamekoSaba YouTube]
 *   | social_media  = [https://x.com/samekosaba Twitter]
 *   }}
 *
 * That gives debut dates (so "new VTuber" is a date filter, not a guess),
 * graduation dates, YouTube handles and X handles — all of which feed the
 * identity registry and let the dataset fill in `debutDate` / `graduateDate`
 * for channels it already knows.
 *
 * API: https://virtualyoutuber.fandom.com/api.php
 */

import type { Candidate } from "../identity";
import type { DebutSource } from "./types";

const API = "https://virtualyoutuber.fandom.com/api.php";
const WIKI_HOST = "virtualyoutuber.fandom.com";

const USER_AGENT =
  "VSingerSingerTracker/1.0 (dataset builder; +https://github.com/)";

interface WikiPage {
  pageid: number;
  title: string;
  revisions?: { slots: { main: { "*": string } } }[];
}

interface WikiResponse {
  query?: {
    pages?: Record<string, WikiPage>;
    allpages?: { pageid: number; title: string }[];
    categorymembers?: { pageid: number; title: string }[];
    search?: { title: string; pageid: number }[];
  };
  continue?: Record<string, string>;
}

export interface FandomOptions {
  /** Wiki host to query. Defaults to the Virtual YouTuber wiki. */
  host?: string;
  /** Maximum number of pages to scan per run. */
  maxPages?: number;
  /** How many days back to consider a debut "new". */
  windowDays?: number;
}

export class FandomSource implements DebutSource {
  readonly id = "fandom";
  readonly label = "Virtual YouTuber Wiki";

  private readonly host: string;
  private readonly maxPages: number;
  private readonly windowDays: number;

  constructor(options: FandomOptions = {}) {
    this.host = options.host ?? WIKI_HOST;
    this.maxPages = options.maxPages ?? 400;
    this.windowDays = options.windowDays ?? 30;
  }

  isConfigured(): boolean {
    return true;
  }

  unavailableReason(): string | null {
    return null;
  }

  private async api(params: Record<string, string>): Promise<WikiResponse | null> {
    const url = new URL(`https://${this.host}/api.php`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    try {
      const res = await fetch(url.toString(), {
        headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      });
      if (!res.ok) return null;
      return (await res.json()) as WikiResponse;
    } catch {
      return null;
    }
  }

  /**
   * Lists the wiki's performer pages.
   *
   * `allpages` is used with a namespace filter and the "recently changed"
   * variant, because a debut almost always comes with a brand-new page —
   * and a newly created page is exactly what "recently changed" surfaces.
   */
  private async listPages(): Promise<{ pageid: number; title: string }[]> {
    const out: { pageid: number; title: string }[] = [];
    let cont: string | undefined;

    do {
      const res = await this.api({
        action: "query",
        list: "allpages",
        apnamespace: "0",
        aplimit: "100",
        apfilterredir: "nonredirects",
        ...(cont ? { apcontinue: cont } : {}),
        format: "json",
      });
      const pages = res?.query?.allpages ?? [];
      out.push(...pages);
      cont = res?.continue?.apcontinue;
      if (pages.length < 100) break;
    } while (cont && out.length < this.maxPages);

    return out.slice(0, this.maxPages);
  }

  /** Fetches the wikitext of a batch of pages. */
  private async fetchWikitext(
    titles: string[],
  ): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (let i = 0; i < titles.length; i += 20) {
      const chunk = titles.slice(i, i + 20);
      const res = await this.api({
        action: "query",
        prop: "revisions",
        rvprop: "content",
        rvslots: "main",
        titles: chunk.join("|"),
        format: "json",
      });
      for (const page of Object.values(res?.query?.pages ?? {})) {
        const text = page.revisions?.[0]?.slots?.main?.["*"];
        if (text) out.set(page.title, text);
      }
    }
    return out;
  }

  async fetch(since: string | null): Promise<Candidate[]> {
    const cutoff = since
      ? new Date(since).getTime()
      : Date.now() - this.windowDays * 24 * 60 * 60 * 1000;

    const pages = await this.listPages();
    if (!pages.length) return [];

    const wikitext = await this.fetchWikitext(pages.map((p) => p.title));
    const candidates: Candidate[] = [];

    for (const [title, text] of wikitext) {
      const infobox = parseCharacterInfobox(text);
      if (!infobox) continue;

      const debut = infobox.debutDate ? parseWikiDate(infobox.debutDate) : null;
      if (!debut) continue;

      const debutTime = new Date(debut).getTime();
      // "New" means debuted inside the window. Older pages are still useful
      // for filling in debut dates, but they are not "new performers".
      if (debutTime < cutoff) continue;

      const youtubeUrl = infobox.channel;
      const youtubeId = youtubeUrl
        ? /youtube\.com\/(?:channel\/|@)([A-Za-z0-9_-]{6,})/.exec(youtubeUrl)?.[1]
        : null;

      const externals: Record<string, string[]> = {};
      const xHandle = infobox.socialMedia
        ? /(?:x|twitter)\.com\/([A-Za-z0-9_]{2,20})/i.exec(
            infobox.socialMedia,
          )?.[1]
        : null;
      if (xHandle) externals.x = [xHandle];

      candidates.push({
        id: youtubeId ?? undefined,
        name: infobox.title ?? title,
        handle: youtubeUrl ? youtubeHandle(youtubeUrl) : null,
        region: null,
        affiliation: infobox.affiliation ?? null,
        debutDate: debut,
        graduateDate: infobox.retirementDate
          ? parseWikiDate(infobox.retirementDate)
          : null,
        externals,
        wikiPage: title,
        source: this.id,
      });
    }

    return candidates;
  }
}

/* -------------------------------------------------------------------------- */
/* Infobox parsing                                                            */
/* -------------------------------------------------------------------------- */

interface CharacterInfobox {
  title: string | null;
  nickName: string | null;
  debutDate: string | null;
  retirementDate: string | null;
  affiliation: string | null;
  channel: string | null;
  socialMedia: string | null;
}

/**
 * Extracts the `{{Character}}` infobox from a page's wikitext.
 *
 * The wiki uses a consistent template layout, so a line-based scan of the
 * template body is enough — no full parser needed.
 */
export function parseCharacterInfobox(text: string): CharacterInfobox | null {
  const start = text.search(/\{\{\s*Character\b/i);
  if (start < 0) return null;

  // Find the matching closing braces.
  let depth = 0;
  let end = -1;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end < 0) return null;

  const body = text.slice(start, end);
  const field = (name: string): string | null => {
    const re = new RegExp(
      `\\|\\s*${name}\\s*=\\s*([^\\n]*?)\\s*(?:\\n\\||$|=)`,
      "i",
    );
    const m = re.exec(body);
    return m?.[1]?.trim() || null;
  };

  const title = field("title1") ?? field("title") ?? field("name");

  return {
    title,
    nickName: field("nick_name"),
    debutDate: field("debut_date"),
    retirementDate: field("retirement_date"),
    affiliation: field("affiliation"),
    channel: field("channel"),
    socialMedia: field("social_media"),
  };
}

/**
 * Parses the wiki's date format.
 *
 * The infobox uses `YouTube: 2025/06/28`, sometimes with a `<ref>` tail that
 * has to be stripped first.
 */
export function parseWikiDate(value: string | null): string | null {
  if (!value) return null;
  const cleaned = value
    .replace(/<ref[^>]*>.*$/is, "")
    .replace(/\{\{[^}]*\}\}/g, "")
    .trim();

  const m = /(\d{4})[/-](\d{1,2})[/-](\d{1,2})/.exec(cleaned);
  if (!m) return null;
  const [, y, mo, d] = m;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  if (!year || !month || !day || month > 12 || day > 31) return null;
  return new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10);
}

/** Extracts `@handle` from a YouTube channel URL. */
function youtubeHandle(url: string): string | null {
  const m = /youtube\.com\/@([A-Za-z0-9_.-]{3,})/.exec(url);
  return m?.[1] ?? null;
}
