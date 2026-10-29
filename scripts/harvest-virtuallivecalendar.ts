#!/usr/bin/env tsx
/**
 * Harvest VTuber singing-event names from virtuallivecalendar.jp.
 *
 * Best-effort: the site is scraped for event names carrying 歌枠/歌リレー/
 * カラオケ-style tags. New names are merged into lists/singing-events.json
 * alongside the Google Sheet source — nothing is overwritten.
 *
 *   npm run data:singing-events-virtuallivecalendar
 *
 * TODO: inspect the site's HTML and update the selectors below.
 */

import fs from "node:fs";
import path from "path";

import { REQUEST_TIMEOUT_MS } from "./lib/io";
import type { SingingEventEntry, SingingEventsFile } from "./lib/singing-events";

const OUT = "lists/singing-events.json";

/** Candidate URLs to try — adjust once the site structure is known. */
const URLS = [
  "https://virtuallivecalendar.jp/",
  "https://virtuallivecalendar.jp/events",
];

/** A cell/line that names a singing event rather than a date or a link. */
const SINGING_EVENT = /歌枠リレー|歌リレー|カラオケ|歌配信|歌ってみた|歌枠/;

/** Not-an-event boilerplate. */
const NOT_AN_EVENT =
  /カレンダー|月別に|イベント一覧|検索|ログイン|会員|お問い合わせ/;

function namesFromHtml(html: string): string[] {
  const names: string[] = [];
  // Crude first pass: strip tags, split on whitespace/punctuation, keep
  // anything that looks like an event name.
  const text = html.replace(/<[^>]*>/g, " ");
  for (const line of text.split(/[\n\r]+/)) {
    const name = line.trim().replace(/\s+/g, " ");
    if (!name) continue;
    if (NOT_AN_EVENT.test(name)) continue;
    if (!SINGING_EVENT.test(name)) continue;
    names.push(name);
  }
  return names;
}

async function fetchText(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        Accept: "text/html,application/xhtml+xml",
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const now = new Date().toISOString();

  // Existing entries, keyed by name so we can merge.
  const existing: SingingEventEntry[] = (() => {
    try {
      const data = JSON.parse(fs.readFileSync(OUT, "utf-8"));
      return Array.isArray(data.entries) ? data.entries : [];
    } catch {
      return [];
    }
  })();

  const byName = new Map<string, SingingEventEntry>();
  for (const entry of existing) byName.set(entry.name, { ...entry });

  let fetched = 0;
  let added = 0;

  for (const url of URLS) {
    const html = await fetchText(url);
    if (!html) continue;
    fetched++;
    for (const name of namesFromHtml(html)) {
      const existingEntry = byName.get(name);
      if (existingEntry) {
        if (!existingEntry.sources.includes("virtuallivecalendar")) {
          existingEntry.sources.push("virtuallivecalendar");
        }
        continue;
      }
      byName.set(name, {
        name,
        month: now.slice(0, 7),
        count: null,
        firstSeen: null,
        sources: ["virtuallivecalendar"],
      });
      added++;
    }
  }

  const entries = [...byName.values()].sort((a, b) =>
    a.name.localeCompare(b.name),
  );

  const sources = [
    ...new Set(entries.flatMap((e) => e.sources).filter(Boolean)),
  ].sort();

  const out: SingingEventsFile = {
    generatedAt: now,
    sources,
    entries,
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.error(
    `${fetched} page(s) fetched → ${added} new → ${entries.length} total → ${OUT}`,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
