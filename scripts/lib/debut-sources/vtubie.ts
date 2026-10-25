/**
 * vTubie directory source.
 *
 * vTubie is a VTuber / VStreamer directory with roughly 20,000 performers,
 * ten to a page at `https://vtubie.com/allvtubers/?pg=N`. Two facts shape
 * this adapter:
 *
 * 1. **There is no API.** Their FAQ answers "Is there a vTubie API?" with
 *    "In development", and every path on the site — including
 *    `/wp-json/` — sits behind a Cloudflare managed challenge. A plain
 *    `fetch` gets `403 Just a moment...`; only a client that runs the
 *    challenge JavaScript sees the page. That is why this source drives a
 *    real browser instead of an HTTP request.
 *
 * 2. **`puppeteer-core` is optional and ships no browser.** When the module
 *    or a Chrome/Chromium binary is missing, `isConfigured()` is false and
 *    the run continues without vTubie. Point the adapter at a browser with
 *    `VTUBIE_CHROME_PATH` (or `PUPPETEER_EXECUTABLE_PATH`); GitHub's Ubuntu
 *    runners already have `google-chrome` installed.
 *
 * A challenge that never clears is a *normal* outcome on a datacenter IP, and
 * it is treated as one: after `challengeTimeoutMs` the adapter logs why and
 * returns no candidates. Nothing here throws.
 *
 * The listing carries a name and a profile slug — no YouTube id — so a
 * candidate is keyed by its vTubie slug (`vtubie:<slug>`) and everything else
 * is left for the identity registry to reconcile with the sources that do
 * know the channel id.
 */

import fs from "node:fs";
import path from "node:path";
import type { Candidate } from "../identity";
import type { DebutSource } from "./types";

export const VTUBIE_ORIGIN = "https://vtubie.com";

/** The directory listing, ten performers per page. */
export const VTUBIE_DIRECTORY_URL = `${VTUBIE_ORIGIN}/allvtubers/`;

/** Titles a Cloudflare interstitial puts on the page while it is checking. */
const CHALLENGE_TITLE = /just a moment|security verification|attention required/i;

export interface VtubieOptions {
  /**
   * Directory URL. Overridable so a fixture or a mirror can stand in;
   * `VTUBIE_DIRECTORY_URL` does the same from the environment.
   */
  directoryUrl?: string;
  /** First page to read (1-based). */
  startPage?: number;
  /** How many pages one run may read. */
  maxPages?: number;
  /** Navigation timeout for one page. */
  timeoutMs?: number;
  /** How long to wait for the Cloudflare challenge to clear. */
  challengeTimeoutMs?: number;
  /** Pause between pages — the directory is not ours to hammer. */
  delayMs?: number;
  /** Show the browser window. Implies a display (Xvfb, or a desktop). */
  headed?: boolean;
  /** Explicit Chrome/Chromium binary. */
  executablePath?: string;
  /** Where log lines go. */
  onLog?: (message: string) => void;
}

/** One entry as the directory listing renders it. */
export interface VtubieEntry {
  /** Profile slug: `ironmouse` for `https://vtubie.com/ironmouse/`. */
  slug: string;
  /** The name vTubie publishes. */
  name: string;
}

/* -------------------------------------------------------------------------- */
/* The module boundary                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The slice of `puppeteer-core` this adapter uses.
 *
 * It is declared here rather than imported so that a checkout without the
 * optional dependency still type-checks — the same reason the legacy SQLite
 * migration keeps `better-sqlite3` optional.
 */
interface BrowserLike {
  newPage(): Promise<PageLike>;
  close(): Promise<void>;
}
interface PageLike {
  goto(
    url: string,
    options: { waitUntil: string; timeout: number },
  ): Promise<unknown>;
  title(): Promise<string>;
  content(): Promise<string>;
  close(): Promise<void>;
}
interface PuppeteerLike {
  launch(options: {
    executablePath: string;
    headless: boolean;
    args: string[];
  }): Promise<BrowserLike>;
}

/**
 * Loads `puppeteer-core`.
 *
 * The specifier is a variable so the TypeScript compiler does not try to
 * resolve a module that is deliberately optional; a missing package is a
 * `null`, not a crash.
 */
async function loadPuppeteer(): Promise<PuppeteerLike | null> {
  const specifier = "puppeteer-core";
  try {
    const mod = (await import(specifier)) as unknown as {
      default?: PuppeteerLike;
    } & Partial<PuppeteerLike>;
    const api = mod.default ?? (mod as PuppeteerLike);
    return typeof api.launch === "function" ? api : null;
  } catch {
    return null;
  }
}

/** Environment overrides, in the order they win. */
const EXECUTABLE_ENV = [
  "VTUBIE_CHROME_PATH",
  "PUPPETEER_EXECUTABLE_PATH",
  "CHROME_PATH",
  "CHROME_BIN",
];

/** The binaries the common platforms install. */
const EXECUTABLE_CANDIDATES = [
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/snap/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
];

/** The Chrome that `npx @puppeteer/browsers install chrome@stable` leaves. */
function cachedChrome(): string | null {
  const root = path.join(
    process.env.PUPPETEER_CACHE_DIR ?? path.join(process.env.HOME ?? "", ".cache"),
    "puppeteer",
    "chrome",
  );
  try {
    for (const version of fs.readdirSync(root)) {
      const candidate = path.join(root, version, "chrome-linux64", "chrome");
      if (fs.existsSync(candidate)) return candidate;
    }
  } catch {
    // No cache: fall through.
  }
  return null;
}

/** Finds a Chrome/Chromium binary, or `null` when there is none. */
export function findChrome(): string | null {
  for (const name of EXECUTABLE_ENV) {
    const value = process.env[name];
    if (value && fs.existsSync(value)) return value;
  }
  for (const candidate of EXECUTABLE_CANDIDATES) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return cachedChrome();
}

/* -------------------------------------------------------------------------- */
/* The source                                                                 */
/* -------------------------------------------------------------------------- */

export class VtubieSource implements DebutSource {
  readonly id = "vtubie";
  readonly label = "vTubie directory";

  private readonly directoryUrl: string;
  private readonly startPage: number;
  private readonly maxPages: number;
  private readonly timeoutMs: number;
  private readonly challengeTimeoutMs: number;
  private readonly delayMs: number;
  private readonly headed: boolean;
  private readonly executablePath: string | null;
  private readonly onLog: (message: string) => void;

  constructor(options: VtubieOptions = {}) {
    this.directoryUrl =
      options.directoryUrl ??
      process.env.VTUBIE_DIRECTORY_URL ??
      VTUBIE_DIRECTORY_URL;
    this.startPage = Math.max(1, options.startPage ?? 1);
    this.maxPages = Math.max(1, options.maxPages ?? 20);
    this.timeoutMs = options.timeoutMs ?? 45_000;
    this.challengeTimeoutMs = options.challengeTimeoutMs ?? 45_000;
    this.delayMs = Math.max(0, options.delayMs ?? 2_000);
    this.headed = options.headed ?? false;
    this.executablePath =
      options.executablePath ?? findChrome();
    this.onLog = options.onLog ?? (() => {});
  }

  isConfigured(): boolean {
    return this.executablePath !== null;
  }

  unavailableReason(): string | null {
    return this.executablePath
      ? null
      : "no Chrome/Chromium binary — set VTUBIE_CHROME_PATH";
  }

  async fetch(_since: string | null): Promise<Candidate[]> {
    /**
     * `since` is accepted and ignored: the listing publishes no dates, so
     * there is nothing to filter on. Repeated runs are cheap anyway — a
     * performer already in the registry is a merge, not a new record.
     */
    if (!this.executablePath) {
      this.onLog(`vtubie: ${this.unavailableReason()}`);
      return [];
    }
    const puppeteer = await loadPuppeteer();
    if (!puppeteer) {
      this.onLog(
        "vtubie: puppeteer-core is not installed — `npm i puppeteer-core` to read the directory",
      );
      return [];
    }

    let browser: BrowserLike;
    try {
      browser = await puppeteer.launch({
        executablePath: this.executablePath,
        headless: !this.headed,
        args: [
          "--no-sandbox",
          "--disable-dev-shm-usage",
          "--disable-background-timer-throttling",
          "--disable-renderer-backgrounding",
        ],
      });
    } catch (error) {
      this.onLog(`vtubie: could not start the browser (${messageOf(error)})`);
      return [];
    }

    const entries: VtubieEntry[] = [];
    const seen = new Set<string>();

    try {
      const page = await browser.newPage();
      for (let index = 0; index < this.maxPages; index++) {
        const pageNumber = this.startPage + index;
        const url = pageUrl(this.directoryUrl, pageNumber);
        const html = await this.readPage(page, url);
        if (html === null) break;

        const parsed = parseVtubieListing(html);
        const fresh = parsed.filter((entry) => !seen.has(entry.slug));
        for (const entry of fresh) seen.add(entry.slug);
        entries.push(...fresh);

        this.onLog(
          `vtubie: page ${pageNumber} → ${parsed.length} entries` +
            (fresh.length === parsed.length ? "" : `, ${fresh.length} new`),
        );

        // Three signals end the walk: an empty page, no "Next" link, or a
        // page whose cards are all ones we have already seen (pagination
        // clamped at the last page keeps serving it).
        if (!fresh.length || !hasNextPage(html)) break;
        if (index < this.maxPages - 1) await sleep(this.delayMs);
      }
      await page.close();
    } catch (error) {
      this.onLog(`vtubie: stopped early (${messageOf(error)})`);
    } finally {
      await browser.close().catch(() => {});
    }

    if (!entries.length) {
      this.onLog(
        "vtubie: no entries — the Cloudflare challenge did not clear, or the directory markup changed",
      );
      return [];
    }

    return entries.map((entry) => ({
      /**
       * The profile is the identity the directory guarantees. Making it the
       * canonical id keeps `data/identities.json` deterministic — the
       * registry's fallback id is random, and a fresh run would otherwise
       * rewrite every record it already had.
       */
      id: `vtubie:${entry.slug}`,
      name: entry.name,
      region: null,
      affiliation: null,
      externals: { vtubie: [entry.slug] },
      source: this.id,
    }));
  }

  /**
   * Reads one directory page, waiting for the challenge to clear.
   *
   * Returns `null` when the page never becomes readable, so the caller ends
   * the walk rather than spinning on more blocked requests.
   */
  private async readPage(page: PageLike, url: string): Promise<string | null> {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: this.timeoutMs });
    } catch (error) {
      this.onLog(`vtubie: ${url} failed (${messageOf(error)})`);
      return null;
    }

    const deadline = Date.now() + this.challengeTimeoutMs;
    let waited = false;
    while (Date.now() < deadline) {
      const title = await page.title().catch(() => "");
      if (!CHALLENGE_TITLE.test(title)) return page.content().catch(() => null);
      waited = true;
      await sleep(1_500);
    }

    if (waited) {
      this.onLog(
        `vtubie: still on the Cloudflare challenge after ${Math.round(
          this.challengeTimeoutMs / 1000,
        )}s — the directory is not readable from this network`,
      );
    }
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Listing parsing                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Extracts the performers in one directory page.
 *
 * The markup is a table of `<td class="ma-n-bro-cont">` cards, each holding
 * the profile link and `<div class="ma-n-bro-title">Name</div>`. The parse is
 * deliberately forgiving: it keys off the card class and the title element
 * rather than the surrounding table, so a layout tweak does not empty the
 * result.
 */
export function parseVtubieListing(html: string): VtubieEntry[] {
  const entries: VtubieEntry[] = [];
  const seen = new Set<string>();

  for (const card of html.split("ma-n-bro-cont").slice(1)) {
    const slice = card.slice(0, 4_000);
    const name = decodeEntities(
      /class="ma-n-bro-title"[^>]*>([\s\S]*?)<\/div>/.exec(slice)?.[1] ?? "",
    )
      .replace(/<[^>]*>/g, "")
      .trim();
    if (!name) continue;

    const slug = profileSlug(slice);
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    entries.push({ slug, name });
  }

  return entries;
}

/** `https://vtubie.com/<slug>/` (or `/<slug>/`) → `<slug>`. */
function profileSlug(card: string): string | null {
  const absolute =
    /href="https:\/\/vtubie\.com\/([A-Za-z0-9%._~-]+)\/"/.exec(card)?.[1] ??
    /href="\/([A-Za-z0-9%._~-]+)\/"/.exec(card)?.[1];
  if (!absolute) return null;
  // Index pages live at the same depth as profiles; they are not performers.
  if (SLUG_STOPLIST.has(absolute.toLowerCase())) return null;
  try {
    return decodeURIComponent(absolute);
  } catch {
    return absolute;
  }
}

/** Root-level paths that are sections of the site, not profiles. */
const SLUG_STOPLIST = new Set([
  "allvtubers",
  "vtubers",
  "groups",
  "tag-list",
  "faq",
  "add-vtuber",
  "add-group",
  "guestedit",
  "verifiedmess",
  "login",
  "register",
]);

/** Does this page link to the next one? */
export function hasNextPage(html: string): boolean {
  return /class="ma-pag-next"/.test(html);
}

/** `https://vtubie.com/allvtubers/?pg=3` */
export function pageUrl(directoryUrl: string, page: number): string {
  const url = new URL(directoryUrl);
  url.searchParams.set("pg", String(page));
  return url.toString();
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
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

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message.split("\n")[0]! : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
