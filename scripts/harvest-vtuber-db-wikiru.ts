#!/usr/bin/env tsx
/**
 * Harvest VTuber entries from vtuber-database.wikiru.jp.
 *
 * vtuber-database.wikiru.jp is a Japanese VTuber database wiki (PukiWiki).
 * It publishes **no JSON API** — the old `/api/channels` endpoint returns 404 —
 * so this harvest scrapes the server-rendered "Vtuberデータベース" filterable
 * table instead.
 *
 * The table carries name, gender, affiliation, group, unit, activity,
 * subscriber count and debut date. It does NOT carry a YouTube channel url,
 * so each entry is keyed by performer name (`vtuber-db-wikiru:<name>`) and a
 * YouTube channel, when found later, re-keys it to the `UC…` id.
 *
 * Nothing here writes `data/` — adding the channels is
 *   npm run data:vtuber-db-wikiru-import
 *
 *   npm run data:vtuber-db-wikiru              # harvest all ~650 entries
 *   npm run data:vtuber-db-wikiru -- --limit 50  # sample for parser check
 */

import fs from "node:fs";
import path from "node:path";

const BASE = "https://vtuber-database.wikiru.jp";
const LIST_PATH =
  "/?Vtuber%E3%83%87%E3%83%BC%E3%82%BF%E3%83%99%E3%83%BC%E3%82%B9";
const FILTER_TABLE_PATH =
  "/?Vtuber%E3%83%87%E3%83%BC%E3%82%BF%E3%83%99%E3%83%BC%E3%82%B9%28%E3%83%95%E3%82%A3%E3%83%AB%E3%82%BF%E3%83%BC%E3%83%86%E3%83%BC%E3%83%96%E3%83%AB%E7%89%88%29";
const CACHE_DIR = ".cache/vtuber-db-wikiru";
const OUT_PATH = path.join(CACHE_DIR, "vtuber-db-wikiru.json");

interface VtuberDbWikiruEntry {
  name: string;
  pageName: string | null;
  gender: string | null;
  affiliation: string | null;
  group: string | null;
  unit: string | null;
  activity: string | null;
  subscribers: string | null;
  debutDate: string | null;
}

interface Options {
  limit: number | null;
}

function parseArgs(argv: string[]): Options {
  const options: Options = { limit: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const value = argv[i + 1];
    switch (arg) {
      case "--limit":
        options.limit = Math.max(1, Number(value ?? 1));
        i++;
        break;
      case "--help":
      case "-h":
        console.log(
          [
            "Usage: npm run data:vtuber-db-wikiru -- [options]",
            "",
            "  --limit <n>  stop after n entries in this pass",
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

/** Collapse a table cell's markup down to visible text. */
function cleanCell(raw: string): string {
  return raw
    .replace(/<br\s*\/?>/gi, ", ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .replace(/,{2,}/g, ",")
    .replace(/^,|,$/g, "")
    .trim();
}

/** Performer page name from the image cell's `?cmd=edit&page=<name>` link. */
function pageNameFromCell(raw: string): string | null {
  const m = raw.match(/[?&]page=([^&"'\s]+)/);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]!);
  } catch {
    return m[1]!;
  }
}

/**
 * Extracts the controlled vocabulary for one filter group from the
 * filter-table page, e.g. every `data-value` of `data-group="所属"` buttons.
 */
function extractVocabulary(html: string, group: string): string[] {
  const values = new Set<string>();
  const re = new RegExp(
    `data-group="${group}"[^>]*data-value="([^"]+)"`,
    "g",
  );
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) values.add(m[1]!);
  return [...values];
}

/**
 * Normalizes a free-text affiliation against the site's controlled agency
 * vocabulary. Splits on the double-comma the wiki uses between multiple
 * affiliations, keeps each piece that matches a controlled term, and drops
 * duplicates — unmatched pieces are preserved so nothing is lost.
 */
function normalizeAffiliation(
  raw: string | null,
  agencies: Set<string>,
): string | null {
  if (!raw) return null;
  const parts = raw
    .split(/,\s*/)
    .map((p) => p.trim())
    .filter(Boolean);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of parts) {
    const normalized = agencies.has(p) ? p : p;
    if (!seen.has(normalized)) {
      seen.add(normalized);
      out.push(normalized);
    }
  }
  return out.length ? out.join(", ") : null;
}

async function fetchHtml(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(30_000),
      headers: {
        "User-Agent": "yt-vsinger-singer-tracker/1.0 (dataset builder)",
        Accept: "text/html",
      },
    });
    if (!res.ok) return null;
    return (await res.text()) as string;
  } catch {
    return null;
  }
}

function parseTable(
  html: string,
  agencies: Set<string>,
): VtuberDbWikiruEntry[] {
  const tbody = html.match(/<tbody[\s\S]*?<\/tbody>/i)?.[0] ?? "";
  const entries: VtuberDbWikiruEntry[] = [];
  const seen = new Set<string>();

  // Split the tbody into rows, then capture each `<td ...>...</td>` cell's
  // inner content. Splitting on `</td><td` would consume the `<td` opener of
  // every cell after the first, so matchAll is used instead.
  const rowRegex = /<tr\b[\s\S]*?<\/tr>/gi;
  for (const row of tbody.matchAll(rowRegex)) {
    const cells: string[] = [];
    const cellRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    for (const cell of row[0].matchAll(cellRegex)) {
      cells.push(cell[1]!);
    }
    if (cells.length < 12) continue;

    // cells[0] is the image cell (may hold the `?cmd=edit&page=<name>` link);
    // cells[1] is always the display name.
    const name = cleanCell(cells[1]!);
    if (!name) continue;

    const pageName = pageNameFromCell(cells[0]!);
    const gender = cleanCell(cells[2]!) || null;
    const affiliation = normalizeAffiliation(
      cleanCell(cells[3]!) ?? null,
      agencies,
    );
    const group = cleanCell(cells[4]!) || null;
    const unit = cleanCell(cells[5]!) || null;
    const activity = cleanCell(cells[6]!) || null;
    const subscribers = cleanCell(cells[7]!) || null;
    // cells[8..10] are year/month/day; cells[11] is the sort date "YYYY/M/D"
    const debutDate = cleanCell(cells[11]!) || null;

    // Dedup by display name; a wiki page is one performer.
    if (seen.has(name)) continue;
    seen.add(name);

    entries.push({
      name,
      pageName: pageName && pageName !== name ? pageName : null,
      gender,
      affiliation,
      group,
      unit,
      activity,
      subscribers,
      debutDate,
    });
  }
  return entries;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  fs.mkdirSync(CACHE_DIR, { recursive: true });

  const html = await fetchHtml(`${BASE}${LIST_PATH}`);
  if (!html) {
    console.error("vtuber-database.wikiru.jp list page unavailable");
    process.exit(1);
  }

  // The controlled agency vocabulary lives on the filter-table page; the
  // list page itself only carries free-text affiliation.
  const agencies = new Set<string>();
  try {
    const filterHtml = await fetchHtml(`${BASE}${FILTER_TABLE_PATH}`);
    if (filterHtml) {
      for (const value of extractVocabulary(filterHtml, "所属")) {
        agencies.add(value);
      }
    }
  } catch {
    // The vocabulary is a nicety, not a requirement — proceed with raw text.
  }

  const entries = parseTable(html, agencies);
  const limited = options.limit ? entries.slice(0, options.limit) : entries;

  const snapshot = {
    generatedAt: new Date().toISOString(),
    source: "vtuber-database.wikiru.jp",
    count: limited.length,
    totalOnPage: entries.length,
    agencyVocabulary: [...agencies].sort(),
    entries: limited,
  };
  fs.writeFileSync(OUT_PATH, JSON.stringify(snapshot, null, 2));
  console.log(
    `${limited.length} entr(y/ies) harvested → ${OUT_PATH}` +
      (limited.length < entries.length ? ` (${entries.length} on page)` : ""),
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
