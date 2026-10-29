#!/usr/bin/env tsx
/**
 * Harvests VTuber singing-event names from the 歌枠リレーカレンダー Google Sheet.
 *
 * @shimesaba_krm (〆鯖の切り身) maintains the community's canonical calendar of
 * VTuber singing relays — every event's name, filed under the day it runs. The
 * calendar is a public Google Sheet, so the CSV export needs no key:
 *
 *   GET /spreadsheets/d/<id>/export?format=csv            the current month
 *   GET /spreadsheets/d/<id>/gviz/tq?tqx=out:csv&sheet=…  one named month tab
 *
 * The **current month** is a sheet of its own (its id changes when the month
 * rolls over), and completed months live as tabs of the year sheet. This
 * harvests the current month plus the previous two, which is the window in
 * which a new participant's videos are still being uploaded.
 *
 *   npm run data:singing-events                 # current + previous 2 months
 *   npm run data:singing-events -- --months 6   # a wider window
 *   npm run data:singing-events -- --names-only # print the event names
 *
 * Output: `lists/singing-events.json`, which `scripts/sync.ts` reads and turns
 * into YouTube video searches.
 */

import fs from "node:fs";
import path from "node:path";
import type { SingingEventEntry, SingingEventsFile } from "./lib/singing-events";

const LIT_LINK = "https://lit.link/shimasabakirimi";

/** The year sheets, by year. The current month has its own sheet id. */
const YEAR_SHEETS: Record<number, string> = {
  2023: "1u5zhWNtvIesRmIWCmAanZugTnTzBiFc7yhgJEcCr1Sg",
  2024: "10K6rMkenqsfjnCdyUQR7jl5WUxloqM80W9RXNKp49HI",
  2025: "1AOJWR0XHFbad56BZMHJcxqLMTBRpO0NS4TlqB1n550c",
  2026: "1VUd7BtE-82F4gVVLoKbBGwiRmr9FnTEVr-Wjr7ggWaI",
};

const MONTH_NAMES = [
  "1月",
  "2月",
  "3月",
  "4月",
  "5月",
  "6月",
  "7月",
  "8月",
  "9月",
  "10月",
  "11月",
  "12月",
];

/** A cell that names a singing event rather than a date or a link. */
const SINGING_EVENT = /歌枠リレー|歌リレー|カラオケ|歌配信|歌ってみた|歌枠/;

/** The calendar's own table-of-contents rows, which are not events. */
const NOT_AN_EVENT =
  /歌枠リレーカレンダー|月別にシート|現行の|年の歌枠|終了分の/;

interface Options {
  months: number;
  namesOnly: boolean;
  out: string;
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    months: 3,
    namesOnly: false,
    out: "lists/singing-events.json",
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const value = argv[i + 1];
    switch (arg) {
      case "--months":
        options.months = Math.max(1, Math.min(24, Number(value ?? 3)));
        i++;
        break;
      case "--names-only":
        options.namesOnly = true;
        break;
      case "--out":
        options.out = value ?? options.out;
        i++;
        break;
      case "--help":
      case "-h":
        console.log(
          [
            "Usage: npm run data:singing-events -- [options]",
            "",
            "  --months <n>    harvest the current month and n-1 before it (default 3)",
            "  --names-only    print the event names, one per line",
            "  --out <path>    snapshot path (default lists/singing-events.json)",
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

async function fetchText(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: {
        Accept: "text/csv,text/html;q=0.9,*/*;q=0.8",
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

/** Parses one CSV cell, including the quoted multi-line cells the sheet uses. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (ch !== "\r") {
      field += ch;
    }
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** Every event name in a calendar CSV. */
function eventsOf(csv: string): string[] {
  const names: string[] = [];
  for (const row of parseCsv(csv)) {
    for (const cell of row) {
      if (!cell) continue;
      for (const line of cell.split("\n")) {
        const name = line.trim();
        if (!name) continue;
        if (NOT_AN_EVENT.test(name)) continue;
        if (!SINGING_EVENT.test(name)) continue;
        names.push(name);
      }
    }
  }
  return names;
}

/** The current month sheet's id, read from the Lit.Link page. */
async function currentMonthSheet(): Promise<string | null> {
  const html = await fetchText(LIT_LINK);
  if (!html) return null;
  const ids = [
    ...new Set(
      [...html.matchAll(/spreadsheets\/d\/([A-Za-z0-9_-]{20,})/g)].map(
        (m) => m[1]!,
      ),
    ),
  ];
  const known = new Set(Object.values(YEAR_SHEETS));
  // The current month is the sheet that is not a year sheet and not the stats
  // sheet — the one whose CSV export starts with the month's date grid.
  for (const id of ids) {
    if (known.has(id)) continue;
    const csv = await fetchText(
      `https://docs.google.com/spreadsheets/d/${id}/export?format=csv`,
    );
    if (csv && /歌枠リレー|歌リレー|カラオケ/.test(csv)) return id;
  }
  return null;
}

/** One named month tab of a year sheet. */
function monthSheetUrl(year: number, month: number): string | null {
  const id = YEAR_SHEETS[year];
  if (!id) return null;
  const name = `${year} ${MONTH_NAMES[month - 1]}カレンダー`;
  return `https://docs.google.com/spreadsheets/d/${id}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(name)}`;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1;

  const events = new Map<string, { name: string; month: string }>();

  // The current month is a sheet of its own.
  const currentId = await currentMonthSheet();
  if (currentId) {
    const csv = await fetchText(
      `https://docs.google.com/spreadsheets/d/${currentId}/export?format=csv`,
    );
    if (csv) {
      for (const name of eventsOf(csv)) {
        events.set(name, { name, month: `${year}-${String(month).padStart(2, "0")}` });
      }
    }
  } else {
    console.error("warn: the current month's sheet could not be found");
  }

  // The previous months live as tabs of the year sheet.
  for (let back = 1; back < options.months; back++) {
    let m = month - back;
    let y = year;
    while (m < 1) {
      m += 12;
      y -= 1;
    }
    const url = monthSheetUrl(y, m);
    if (!url) continue;
    const csv = await fetchText(url);
    if (!csv) continue;
    for (const name of eventsOf(csv)) {
      if (!events.has(name)) {
        events.set(name, { name, month: `${y}-${String(m).padStart(2, "0")}` });
      }
    }
  }

  // Merge with existing unified file so previously harvested entries are kept
  // and new ones are added without duplicating.
  const existingEntries: SingingEventEntry[] = (() => {
    try {
      const data = JSON.parse(fs.readFileSync(options.out, "utf-8"));
      return Array.isArray(data.entries) ? data.entries : [];
    } catch {
      return [];
    }
  })();

  const byName = new Map<string, SingingEventEntry>();
  for (const entry of existingEntries) byName.set(entry.name, entry);
  for (const [name, entry] of events) {
    const existing = byName.get(name);
    if (!existing) {
      byName.set(name, {
        name,
        month: entry.month,
        count: null,
        firstSeen: null,
        sources: ["calendar"],
      });
    } else {
      if (!existing.sources.includes("calendar")) {
        existing.sources.push("calendar");
      }
      if (entry.month && (!existing.month || entry.month < existing.month)) {
        existing.month = entry.month;
      }
    }
  }

  const list = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));

  if (options.namesOnly) {
    for (const entry of list) console.log(entry.name);
    return;
  }

  const sources = [
    ...new Set(list.flatMap((e) => e.sources).filter(Boolean)),
  ].sort();

  const snapshot: SingingEventsFile = {
    generatedAt: now.toISOString(),
    sources,
    entries: list,
  };
  fs.mkdirSync(path.dirname(options.out), { recursive: true });
  fs.writeFileSync(options.out, JSON.stringify(snapshot, null, 2));
  console.error(
    `${list.length} singing event(s) total (${events.size} new) → ${options.out}`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
