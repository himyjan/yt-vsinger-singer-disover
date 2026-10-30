#!/usr/bin/env tsx
/**
 * Harvests the hololist.net directory into a reviewable snapshot.
 *
 * hololist.net is WordPress with pretty permalinks, so the roster is
 * enumerable from its own core sitemaps — `/wp-sitemap.xml` lists five post
 * sitemaps holding 9,359 entry URLs — and every entry is one server-rendered
 * page with its fields in `<section id="…">` blocks. The REST API answers
 * `403` through Cloudflare and `robots.txt` disallows `/*?*`, so the sitemap
 * plus one request per entry is the readable path.
 *
 *   npm run data:hololist                    # every entry not yet on disk
 *   npm run data:hololist -- --limit 50      # a sample, for a parser check
 *   npm run data:hololist -- --refresh       # ignore <lastmod>, refetch all
 *   npm run data:hololist -- --merge-only    # rebuild the snapshot only
 *
 * The harvest is **resumable and incremental**: one file per entry under
 * `.cache/hololist/pages/`, and the sitemap's `<lastmod>` in `state.json`, so
 * a second run refetches only what the site changed. Nothing here writes
 * `data/`: adding the channels is `npm run data:hololist-import`.
 */

import { logLine, progressBar } from "./lib/progress";
import fs from "node:fs";
import path from "node:path";
import {
  parseHoloListEntry,
  parseHoloListSitemap,
  parseSitemapIndex,
  type HoloListEntry,
  type HoloListSitemapEntry,
  type HoloListSnapshot,
} from "./lib/hololist";

const BASE = "https://hololist.net";
const SITEMAP_INDEX = `${BASE}/wp-sitemap.xml`;
const CACHE_DIR = ".cache/hololist";
const PAGES_DIR = path.join(CACHE_DIR, "pages");
const STATE_PATH = path.join(CACHE_DIR, "state.json");
const OUT_PATH = ".cache/hololist.json";

const MAX_DELAY_MS = 10_000;
const COOLDOWN_MS = 120_000;
const RETRY_BACKOFF_MS = [5_000, 20_000, 60_000];
const MAX_CONSECUTIVE_FAILURES = 8;

interface Options {
  limit: number | null;
  delayMs: number;
  concurrency: number;
  refresh: boolean;
  mergeOnly: boolean;
}

interface State {
  /** The `<lastmod>` each entry had when it was last read. */
  lastmod: Record<string, string>;
  /** Entries this host would not serve, and why. */
  failed: { url: string; reason: string; at: string }[];
  /** The sitemap list the pass worked from. */
  sitemaps: string[];
  updatedAt: string;
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    limit: null,
    delayMs: 300,
    concurrency: 2,
    refresh: false,
    mergeOnly: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = argv[i + 1];
    switch (arg) {
      case "--limit":
        options.limit = Math.max(1, Number(value ?? 0));
        i++;
        break;
      case "--delay":
        options.delayMs = Math.max(0, Number(value ?? 0));
        i++;
        break;
      case "--concurrency":
        options.concurrency = Math.max(1, Math.min(4, Number(value ?? 2)));
        i++;
        break;
      case "--refresh":
        options.refresh = true;
        break;
      case "--merge-only":
        options.mergeOnly = true;
        break;
      case "--help":
      case "-h":
        console.log(
          [
            "Usage: npm run data:hololist -- [options]",
            "",
            "  --limit <n>          stop after n entries in this pass",
            "  --delay <ms>         gap between requests (default 300)",
            "  --concurrency <n>    parallel entry reads, 1-4 (default 2)",
            "  --refresh            ignore <lastmod> and refetch every entry",
            "  --merge-only         rebuild the snapshot from the page files",
          ].join("\n"),
        );
        process.exit(0);
      default:
        if (arg.startsWith("-")) {
          console.error(`unknown flag: ${arg}`);
          process.exit(1);
        }
    }
  }
  return options;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(message: string): void {
  /* The bar taps `stdout`, so this clears the line before it prints. */
  logLine(`[hololist] ${message}`);
}

function readState(): State {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_PATH, "utf8")) as Partial<State>;
    return {
      lastmod: raw.lastmod ?? {},
      failed: raw.failed ?? [],
      sitemaps: raw.sitemaps ?? [],
      updatedAt: raw.updatedAt ?? "",
    };
  } catch {
    return { lastmod: {}, failed: [], sitemaps: [], updatedAt: "" };
  }
}

function writeState(state: State): void {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  state.updatedAt = new Date().toISOString();
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 0));
}

/**
 * One request, with a timeout.
 *
 * A `fetch` without a deadline never rejects, it hangs, and a hung request in
 * a loop of thousands stalls the run with no output and no error
 * (`AGENTS.md` rule 11).
 */
async function get(url: string): Promise<{ ok: true; body: string } | { ok: false; status: number; message: string }> {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(30_000),
      headers: {
        "user-agent": "vsinger-tracker/1.0 (+https://github.com/; roster harvest)",
        accept: "text/html,application/xml",
      },
    });
    if (!response.ok) {
      return { ok: false, status: response.status, message: `HTTP ${response.status}` };
    }
    return { ok: true, body: await response.text() };
  } catch (error) {
    return { ok: false, status: 0, message: (error as Error).message };
  }
}

function pageFile(url: string): string {
  const slug =
    new URL(url).pathname.replace(/^\/|\/$/g, "").replace(/[^a-z0-9._-]+/gi, "_") || "index";
  return path.join(PAGES_DIR, `${slug}.json`);
}

function writePage(entry: HoloListEntry): void {
  fs.mkdirSync(PAGES_DIR, { recursive: true });
  fs.writeFileSync(pageFile(entry.url), JSON.stringify(entry));
}

function readPages(): HoloListEntry[] {
  let files: string[] = [];
  try {
    files = fs.readdirSync(PAGES_DIR).filter((file) => file.endsWith(".json"));
  } catch {
    return [];
  }
  const entries: HoloListEntry[] = [];
  for (const file of files) {
    try {
      const entry = JSON.parse(fs.readFileSync(path.join(PAGES_DIR, file), "utf8")) as HoloListEntry;
      if (entry?.url && entry?.name) entries.push(entry);
    } catch {
      /* A half-written page is rewritten by the next pass. */
    }
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

function mergeSnapshot(): HoloListEntry[] {
  const entries = readPages();
  const snapshot: HoloListSnapshot = {
    generatedAt: new Date().toISOString(),
    source: `${SITEMAP_INDEX} → ${BASE}/wp-sitemap-posts-post-*.xml`,
    entries,
  };
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(snapshot, null, 0));
  log(`wrote ${OUT_PATH}: ${entries.length} entr(y/ies)`);

  const types = new Map<string, number>();
  const statuses = new Map<string, number>();
  let linked = 0;
  let youTube = 0;
  for (const entry of entries) {
    for (const type of entry.types) types.set(type, (types.get(type) ?? 0) + 1);
    const status = entry.status ?? "unknown";
    statuses.set(status, (statuses.get(status) ?? 0) + 1);
    if (entry.links.length) linked++;
    if (entry.links.some((link) => link.platform === "youtube")) youTube++;
  }
  const top = (map: Map<string, number>) =>
    [...map.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([name, count]) => `${count} ${name}`)
      .join(" · ");
  log(`types: ${top(types)}`);
  log(`status: ${top(statuses)}`);
  log(`links: ${linked} with any link, ${youTube} with a YouTube channel`);
  return entries;
}

/** The entry sitemaps, from the index or the WordPress default shape. */
async function sitemapUrls(state: State): Promise<string[]> {
  const index = await get(SITEMAP_INDEX);
  if (index.ok) {
    const listed = parseSitemapIndex(index.body);
    if (listed.length) {
      state.sitemaps = listed;
      return listed;
    }
  }
  /**
   * The index is the normal path. If it is unreadable the five post sitemaps
   * are asked for directly, because the roster's shape is not going to change
   * without the site moving off WordPress.
   */
  return Array.from({ length: 5 }, (_, i) => `${BASE}/wp-sitemap-posts-post-${i + 1}.xml`);
}

async function readSitemaps(state: State): Promise<HoloListSitemapEntry[]> {
  const urls = await sitemapUrls(state);
  const seen = new Set<string>();
  const entries: HoloListSitemapEntry[] = [];
  for (const url of urls) {
    if (!/posts-post-\d+\.xml$/.test(url)) continue;
    const result = await get(url);
    if (!result.ok) {
      log(`  ${url} — ${result.message}, skipped`);
      continue;
    }
    const rows = parseHoloListSitemap(result.body);
    let fresh = 0;
    for (const row of rows) {
      if (seen.has(row.url)) continue;
      seen.add(row.url);
      entries.push(row);
      fresh++;
    }
    log(`  ${url} → ${rows.length} URL(s)`);
  }
  log(`sitemaps: ${entries.length} entry URL(s)`);
  return entries;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  if (options.mergeOnly) {
    mergeSnapshot();
    return;
  }

  fs.mkdirSync(PAGES_DIR, { recursive: true });
  const state = readState();
  log(
    `${Object.keys(state.lastmod).length} entr(y/ies) already on disk` +
      (state.failed.length ? `, ${state.failed.length} previously failed` : ""),
  );

  const sitemap = await readSitemaps(state);
  if (!sitemap.length) {
    log("the sitemaps answered nothing — the snapshot was not touched");
    process.exit(1);
  }

  /**
   * What to read: an entry whose page file is missing, or whose `<lastmod>`
   * moved since the last pass. `--refresh` asks for all of them.
   */
  const todo = sitemap.filter((row) => {
    if (options.refresh) return true;
    if (!fs.existsSync(pageFile(row.url))) return true;
    const known = state.lastmod[row.url];
    if (!known) return true;
    return row.lastmod !== null && row.lastmod > known;
  });
  log(
    `to read: ${todo.length} of ${sitemap.length}` +
      (todo.length < sitemap.length ? ` (${sitemap.length - todo.length} unchanged)` : ""),
  );
  if (!todo.length) {
    mergeSnapshot();
    return;
  }

  let index = 0;
  let taken = 0;
  let done = 0;
  let failures = 0;
  let consecutiveFailures = 0;
  let stopReason: string | null = null;
  let delayMs = options.delayMs;
  const limit = options.limit ?? Infinity;
  const lastmodByUrl = new Map(sitemap.map((row) => [row.url, row.lastmod]));

  /**
   * The next entry to read, or `null` when there is none or the `--limit` is
   * spent. `started` counts what the workers took, not what they finished,
   * so two workers cannot overshoot the limit together.
   */
  const take = (): HoloListSitemapEntry | null => {
    if (taken >= limit) return null;
    if (index >= todo.length) return null;
    taken++;
    return todo[index++]!;
  };

  const bar = progressBar(
    "hololist",
    Number.isFinite(limit) ? Math.min(limit, todo.length) : todo.length,
    { unit: "pages" },
  );

  const workers = Array.from({ length: options.concurrency }, async () => {
    for (;;) {
      if (stopReason !== null) return;
      const row = take();
      if (!row) return;

      let result = await get(row.url);
      let attempt = 0;
      while (!result.ok) {
        const status = result.ok ? 0 : result.status;
        const reason = result.ok ? "" : result.message;
        /** 403 and 404 are answers: the entry is not ours to read. */
        if (status === 403 || status === 404 || status === 410) break;
        if (status === 429 || status === 503) {
          delayMs = Math.min(MAX_DELAY_MS, Math.max(1_500, delayMs * 2));
          log(`${row.url} — ${reason}, cooling down ${COOLDOWN_MS / 1_000}s, delay ${delayMs}ms`);
          await sleep(COOLDOWN_MS);
        } else {
          const wait = RETRY_BACKOFF_MS[Math.min(attempt, RETRY_BACKOFF_MS.length - 1)]!;
          log(`${row.url} — ${reason}, retrying in ${Math.round(wait / 1_000)}s`);
          await sleep(wait);
        }
        attempt++;
        if (attempt > RETRY_BACKOFF_MS.length) break;
        result = await get(row.url);
      }

      if (!result.ok) {
        failures++;
        consecutiveFailures++;
        state.failed = state.failed.filter((entry) => entry.url !== row.url);
        state.failed.push({ url: row.url, reason: result.message, at: new Date().toISOString() });
        log(`${row.url} — ${result.message}, recorded and moving on`);
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          stopReason = `${consecutiveFailures} entries in a row did not answer`;
          log(`${stopReason}, stopping this pass`);
          return;
        }
        await sleep(delayMs);
        continue;
      }

      consecutiveFailures = 0;
      const entry = parseHoloListEntry(result.body, row.url, row.lastmod);
      if (!entry) {
        failures++;
        state.failed.push({
          url: row.url,
          reason: "no name — not an entry page",
          at: new Date().toISOString(),
        });
        await sleep(delayMs);
        continue;
      }

      writePage(entry);
      state.lastmod[row.url] = row.lastmod ?? lastmodByUrl.get(row.url) ?? new Date().toISOString();
      state.failed = state.failed.filter((failed) => failed.url !== row.url);

      done++;
      bar.tick(entry.name);
      if (done % 25 === 0) writeState(state);
      await sleep(delayMs);
    }
  });

  await Promise.all(workers);
  writeState(state);
  bar.done(
    `read ${done} entr(y/ies)` +
      (failures ? `, ${failures} could not be read` : "") +
      (stopReason ? ` — stopped: ${stopReason}` : ""),
  );

  mergeSnapshot();
}

main();
