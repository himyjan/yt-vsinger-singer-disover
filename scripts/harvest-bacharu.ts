#!/usr/bin/env tsx
/**
 * Harvests bacharu.io's roster into a reviewable snapshot.
 *
 * bacharu answers plain JSON — no browser, no challenge — but it answers
 * *whole* records: a page of a hundred is about 2.6 MB and three seconds, of
 * which the dataset needs a few hundred bytes. So this reads the pages, keeps
 * the extract `extractVtuber()` makes and throws the rest away, one file per
 * page so a run that stops can resume and so the merge never rewrites a
 * hundred megabytes.
 *
 *   npm run data:bacharu                      # the whole roster
 *   npm run data:bacharu -- --pages 1-20      # a slice to check the shape
 *   npm run data:bacharu -- --limit 100       # stop after a hundred pages
 *   npm run data:bacharu -- --merge-only      # rebuild the snapshot only
 *
 * **Politeness.** `robots.txt` disallows `/api/` for every agent, and the
 * roster is 109,828 entries — 1,099 requests. The defaults therefore read two
 * pages at a time with a 400 ms gap, which is about one request a second and
 * half an hour of wall clock: a one-off census, not a crawl to run on a
 * schedule. A 429 or a 503 doubles the gap for the rest of the pass and cools
 * down for two minutes, exactly as the vTubie harvester does; the state file
 * carries the rest to a later run rather than hammering a source that has
 * asked for less.
 *
 * Nothing here writes `data/`: the snapshot lands in `.cache/` and adding the
 * channels is a separate, gated step.
 */

import fs from "node:fs";
import path from "node:path";
import { extractPage } from "./lib/bacharu";
import type { BacharuVtuber } from "./lib/bacharu";

const ORIGIN = "https://bacharu.io";
const API = `${ORIGIN}/api/vtubers`;

/* -------------------------------------------------------------------------- */
/* Options                                                                    */
/* -------------------------------------------------------------------------- */

interface Options {
  from: number;
  to: number | null;
  limit: number | null;
  delayMs: number;
  concurrency: number;
  pageSize: number;
  statePath: string;
  pagesDir: string;
  /** Further page sets to union in, when a crawl had to be repeated. */
  mergeDirs: string[];
  outPath: string;
  reset: boolean;
  mergeOnly: boolean;
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    from: 1,
    to: null,
    limit: null,
    delayMs: 400,
    concurrency: 2,
    pageSize: 100,
    statePath: ".cache/bacharu-state.json",
    pagesDir: ".cache/bacharu/pages",
    mergeDirs: [],
    outPath: ".cache/bacharu-vtubers.json",
    reset: false,
    mergeOnly: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = argv[i + 1];
    switch (arg) {
      case "--pages": {
        const match = /^(\d+)(?:-(\d+))?$/.exec(value ?? "");
        if (!match) {
          console.error("--pages wants `N` or `a-b`");
          process.exit(1);
        }
        options.from = Number(match[1]);
        options.to = match[2] ? Number(match[2]) : options.from;
        i++;
        break;
      }
      case "--limit":
        options.limit = Math.max(1, Number(value ?? 0));
        i++;
        break;
      case "--delay":
        options.delayMs = Math.max(0, Number(value ?? 400));
        i++;
        break;
      case "--concurrency":
        options.concurrency = Math.max(1, Math.min(4, Number(value ?? 2)));
        i++;
        break;
      case "--page-size":
        options.pageSize = Math.max(1, Math.min(100, Number(value ?? 100)));
        i++;
        break;
      case "--state":
        options.statePath = value ?? options.statePath;
        i++;
        break;
      case "--pages-dir":
        options.pagesDir = value ?? options.pagesDir;
        i++;
        break;
      case "--merge-dir":
        if (value) options.mergeDirs.push(value);
        i++;
        break;
      case "--out":
        options.outPath = value ?? options.outPath;
        i++;
        break;
      case "--reset":
        options.reset = true;
        break;
      case "--merge-only":
        options.mergeOnly = true;
        break;
      case "--help":
      case "-h":
        console.log(
          [
            "Usage: npm run data:bacharu -- [options]",
            "",
            "  --pages <a-b>        page range to read (default the whole roster)",
            "  --limit <n>          stop after n pages in this pass",
            "  --delay <ms>         pause between requests (default 400)",
            "  --concurrency <n>    parallel page reads, 1-4 (default 2)",
            "  --page-size <n>      rows per request, 1-100 (default 100)",
            "  --state <path>       resume file (default .cache/bacharu-state.json)",
            "  --pages-dir <path>   one file per page (default .cache/bacharu/pages)",
            "  --merge-dir <path>   another page set to union in (repeatable)",
            "  --out <path>         snapshot written at the end",
            "  --reset              discard the state file and every page file",
            "  --merge-only         rebuild the snapshot from the page files",
          ].join("\n"),
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

/* -------------------------------------------------------------------------- */
/* State                                                                      */
/* -------------------------------------------------------------------------- */

interface State {
  startedAt: string;
  updatedAt: string;
  /** The page size the files were read with; the roster counts depend on it. */
  pageSize: number;
  /** Entries the roster claimed, when the last run asked. */
  total: number | null;
  /** Pages the roster claimed, when the last run asked. */
  totalPages: number | null;
  /** Pages whose file is on disk. */
  done: number[];
  /** Pages that answered badly, for the report. */
  failed: { page: number; reason: string; at: string }[];
}

function loadState(file: string, reset: boolean): State {
  if (!reset && fs.existsSync(file)) {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8")) as State;
    } catch {
      // A truncated state file is a half-written one; start again.
    }
  }
  const now = new Date().toISOString();
  return {
    startedAt: now,
    updatedAt: now,
    pageSize: 100,
    total: null,
    totalPages: null,
    done: [],
    failed: [],
  };
}

function saveState(file: string, state: State): void {
  state.updatedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state));
}

/* -------------------------------------------------------------------------- */
/* Reading one page                                                           */
/* -------------------------------------------------------------------------- */

type PageResult =
  | {
      kind: "ok";
      rows: BacharuVtuber[];
      total: number | null;
      totalPages: number | null;
    }
  | { kind: "http"; status: number }
  | { kind: "error"; message: string };

/**
 * One page of the roster.
 *
 * The response is a whole record apiece, so the timeout is generous: a
 * hundred rows take about three seconds on a good day, and a slow one should
 * be waited out rather than abandoned halfway through the body.
 */
async function fetchPage(page: number, pageSize: number): Promise<PageResult> {
  const url = `${API}?limit=${pageSize}&page=${page}`;
  try {
    const response = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) {
      await response.arrayBuffer().catch(() => {});
      return { kind: "http", status: response.status };
    }
    const payload = (await response.json()) as {
      data?: unknown;
      pagination?: Record<string, unknown>;
    };
    const totalPages = Number(payload.pagination?.totalPages);
    const total = Number(payload.pagination?.total);
    return {
      kind: "ok",
      rows: extractPage(payload.data),
      total: Number.isFinite(total) ? total : null,
      totalPages: Number.isFinite(totalPages) ? totalPages : null,
    };
  } catch (error) {
    return { kind: "error", message: error instanceof Error ? error.message : String(error) };
  }
}

/* -------------------------------------------------------------------------- */
/* The pass                                                                   */
/* -------------------------------------------------------------------------- */

/** The ceiling the adaptive gap may grow to: one page every ten seconds. */
const MAX_DELAY_MS = 10_000;

/** How long to leave the roster alone after it answers 429 or 503. */
const COOLDOWN_MS = 120_000;

/** Waits before asking again after a network error or a 5xx. */
const RETRY_BACKOFF_MS = [5_000, 20_000, 60_000];

/** A run stops after this many pages in a row that never answered. */
const MAX_CONSECUTIVE_FAILURES = 8;

function pageFile(dir: string, page: number): string {
  return path.join(dir, `${page}.json`);
}

function writePage(dir: string, page: number, rows: BacharuVtuber[]): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    pageFile(dir, page),
    JSON.stringify({ page, fetchedAt: new Date().toISOString(), rows }),
  );
}

async function readRoster(state: State, options: Options, log: (message: string) => void): Promise<void> {
  /**
   * Pages are taken from a counter rather than a list: the roster's last page
   * is only known once a page has answered, and a roster of 110,000 entries
   * cannot be enumerated up front when the count is still `null`.
   */
  let nextPage = options.from;
  const lastPage = (): number => options.to ?? state.totalPages ?? Infinity;
  const take = (): number | null => {
    while (nextPage <= lastPage()) {
      const page = nextPage++;
      if (!fs.existsSync(pageFile(options.pagesDir, page))) return page;
    }
    return null;
  };

  log(
    `roster: from page ${options.from}` +
      (state.totalPages ? ` of ${state.totalPages}` : ", last page unknown until the first answer") +
      `, ${state.done.length} page(s) already on disk`,
  );

  const startedAt = Date.now();
  let done = 0;
  let rows = 0;
  let consecutiveFailures = 0;
  /** Set when the roster has stopped answering; every worker returns. */
  let stopReason: string | null = null;
  /** The gap between pages, grown when the roster asks for less traffic. */
  let delayMs = options.delayMs;
  const limit = options.limit ?? Infinity;
  /** Pages already on disk when the pass started — `expected()` must not recount them. */
  const doneAtStart = state.done.length;

  /** Pages this pass expects to read, once the roster's size is known. */
  const expected = (): number | null => {
    const end = options.to ?? state.totalPages;
    if (end === null) return null;
    return Math.max(0, end - options.from + 1 - doneAtStart);
  };

  const workers = Array.from({ length: options.concurrency }, async () => {
    for (;;) {
      if (stopReason !== null) return;
      if (done >= limit) return;
      const page = take();
      if (page === null) return;

      let result = await fetchPage(page, options.pageSize);
      let attempt = 0;

      /** Retry while there is a reason to: 429, 503, 5xx, a dead socket. */
      while (result.kind !== "ok") {
        const status = result.kind === "http" ? result.status : 0;
        const reason = result.kind === "http" ? `HTTP ${result.status}` : result.message;

        /** 403 and 404 are answers: the page is not ours to read. */
        if (result.kind === "http" && (status === 403 || status === 404 || status === 410)) {
          break;
        }
        /**
         * A rate limit is the host asking for less. Slow the whole pass down
         * and leave it alone for two minutes, then ask once more.
         */
        if (status === 429 || status === 503) {
          delayMs = Math.min(MAX_DELAY_MS, Math.max(1_500, delayMs * 2));
          log(
            `roster: page ${page} — ${reason}, cooling down ${COOLDOWN_MS / 1_000}s and ` +
              `slowing to one page every ${(delayMs / 1_000).toFixed(1)}s`,
          );
          await sleep(COOLDOWN_MS);
        } else if (status === 400 || status === 422) {
          /** The request shape is wrong; asking again will not fix it. */
          break;
        } else {
          const wait = RETRY_BACKOFF_MS[Math.min(attempt, RETRY_BACKOFF_MS.length - 1)];
          log(`roster: page ${page} — ${reason}, retrying in ${Math.round(wait / 1_000)}s`);
          await sleep(wait);
        }

        attempt++;
        if (attempt > RETRY_BACKOFF_MS.length) break;
        result = await fetchPage(page, options.pageSize);
      }

      if (result.kind !== "ok") {
        const reason = result.kind === "http" ? `HTTP ${result.status}` : result.message;
        state.failed = state.failed.filter((entry) => entry.page !== page);
        state.failed.push({ page, reason, at: new Date().toISOString() });
        consecutiveFailures++;
        log(`roster: page ${page} — ${reason}, recorded and moving on`);
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          stopReason = `${consecutiveFailures} pages in a row did not answer`;
          log(`roster: ${stopReason}, stopping this pass`);
          return;
        }
        await sleep(delayMs);
        continue;
      }

      consecutiveFailures = 0;
      writePage(options.pagesDir, page, result.rows);
      state.done = [...new Set([...state.done, page])].sort((a, b) => a - b);
      state.failed = state.failed.filter((entry) => entry.page !== page);
      if (result.total !== null) state.total = result.total;
      if (result.totalPages !== null) state.totalPages = result.totalPages;
      state.pageSize = options.pageSize;

      done++;
      rows += result.rows.length;
      const total = expected();
      if (done % 5 === 0 || (total !== null && done >= total)) {
        saveState(options.statePath, state);
        log(
          `roster: ${total === null ? `${done} page(s)` : `${done}/${total}`} ·` +
            `${total === null ? "" : eta(done, total, startedAt)} · ` +
            `${rows} vtuber(s) this pass`,
        );
      }
      await sleep(delayMs);
    }
  });

  await Promise.all(workers);
  saveState(options.statePath, state);
  log(
    `roster: read ${done} page(s), ${rows} vtuber(s)` +
      (state.failed.length ? `, ${state.failed.length} page(s) failed` : "") +
      (stopReason ? ` — stopped: ${stopReason}` : ""),
  );
}

/** ` at 1.4 pages/s, 32 min left` — enough to tell a stuck run from a slow one. */
function eta(done: number, total: number, startedAt: number): string {
  const seconds = Math.max(1, (Date.now() - startedAt) / 1_000);
  const rate = done / seconds;
  if (!Number.isFinite(rate) || rate <= 0) return " rate unknown";
  const left = Math.max(0, total - done) / rate;
  const minutes = Math.round(left / 60);
  return ` ${rate.toFixed(1)} pages/s, ${minutes > 90 ? `${Math.round(minutes / 60)}h` : `${minutes} min`} left`;
}

/* -------------------------------------------------------------------------- */
/* The snapshot                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Every page file on disk, in page order, merged into one roster.
 *
 * More than one directory can be given. The roster is sorted by
 * `last_active_at`, which moves as the site refreshes its live data, so a
 * long crawl can skip a row whose position shifted past the page being read
 * — and repeat it on another page. A second pass at a different page size
 * fills those gaps, and `--merge-dir` unions the two without either pass
 * having to overwrite the other's files.
 */
function mergePages(dirs: string[]): BacharuVtuber[] {
  const byId = new Map<string, BacharuVtuber>();

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    const pages = fs
      .readdirSync(dir)
      .filter((name) => /^\d+\.json$/.test(name))
      .map((name) => Number(name.replace(/\.json$/, "")))
      .sort((a, b) => a - b);

    for (const page of pages) {
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(dir, `${page}.json`), "utf8")) as {
          rows?: BacharuVtuber[];
        };
        for (const row of parsed.rows ?? []) {
          if (!row?.id) continue;
          const known = byId.get(row.id);
          /**
           * The same entry from two passes: keep the one that resolved a
           * YouTube link, since a pass that saw it before the site filled
           * `social.youtube` would otherwise overwrite the better extract.
           */
          if (!known || (!known.youtubeId && !known.youtubeHandle && (row.youtubeId || row.youtubeHandle))) {
            byId.set(row.id, row);
          }
        }
      } catch {
        // A half-written page file is not a page; the state file still lists it,
        // and the next run re-reads it because the file is unreadable.
        continue;
      }
    }
  }

  return [...byId.values()].sort((a, b) =>
    (a.canonicalName ?? a.id).localeCompare(b.canonicalName ?? b.id),
  );
}

function writeSnapshot(rows: BacharuVtuber[], state: State, outPath: string): void {
  const withId = rows.filter((row) => row.youtubeId).length;
  const withHandle = rows.filter((row) => !row.youtubeId && row.youtubeHandle).length;
  const withYouTube = rows.filter((row) => row.youtubeId || row.youtubeHandle).length;
  const byStatus = new Map<string, number>();
  const byType = new Map<string, number>();
  for (const row of rows) {
    byStatus.set(row.status ?? "unknown", (byStatus.get(row.status ?? "unknown") ?? 0) + 1);
    byType.set(row.entityType ?? "unknown", (byType.get(row.entityType ?? "unknown") ?? 0) + 1);
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(
    outPath,
    JSON.stringify({
      generatedAt: new Date().toISOString(),
      source: "bacharu",
      origin: ORIGIN,
      roster: { total: state.total, totalPages: state.totalPages, pagesRead: state.done.length },
      counts: {
        vtubers: rows.length,
        youtubeId: withId,
        youtubeHandle: withHandle,
        noYouTube: rows.length - withYouTube,
        withGroup: rows.filter((row) => row.groups.length > 0).length,
      },
      vtubers: rows,
    }),
  );

  const top = (counts: Map<string, number>): string =>
    [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([name, count]) => `${name} ${count}`)
      .join(" · ");

  console.log(
    `snapshot: ${outPath} · ${rows.length} vtuber(s) · ` +
      `${withId} with a channel id, ${withHandle} with a handle only, ` +
      `${rows.length - withYouTube} without YouTube`,
  );
  console.log(`  status: ${top(byStatus)}`);
  console.log(`  type:   ${top(byType)}`);
}

/* -------------------------------------------------------------------------- */

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const log = (message: string): void => console.log(message);

  if (options.reset) {
    fs.rmSync(options.pagesDir, { recursive: true, force: true });
    fs.rmSync(options.statePath, { force: true });
    log("reset: every page file and the state file are gone");
  }

  const state = loadState(options.statePath, false);

  if (!options.mergeOnly) {
    await readRoster(state, options, log);
  }

  writeSnapshot(mergePages([options.pagesDir, ...options.mergeDirs]), state, options.outPath);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
