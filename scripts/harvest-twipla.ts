#!/usr/bin/env tsx
/**
 * Harvest VTuber singing-event hashtags from TwiPla (twipla.jp).
 *
 * TwiPla is Japan's open event dashboard — indie VTubers and collaboration
 * organizers post recruitment and event announcements there. This searches
 * for 歌枠リレー-style posts, extracts event hashtags, and merges them into
 * lists/singing-events.json — the same unified file the other harvesters use.
 *
 *   npm run data:singing-events-twipla
 *
 * TODO: inspect the site's HTML and update the selectors below. TwiPla may
 * require JavaScript rendering or may block non-browser user agents.
 */

import fs from "node:fs";
import path from "path";

import { REQUEST_TIMEOUT_MS } from "./lib/io";
import type { SingingEventEntry, SingingEventsFile } from "./lib/singing-events";

const OUT = "lists/singing-events.json";

/** Search URLs to try — adjust once the site structure is known. */
const URLS = [
  "https://twipla.jp/search?q=%E6%AD%8C%E5%85%A4%E3%83%AA%E3%83%AC%E3%83%BC",
  "https://twipla.jp/tags/%E6%AD%8C%E5%85%A4%E3%83%AA%E3%83%AC%E3%83%BC",
];

/** A hashtag that names a singing event. */
const SINGING_EVENT_TAG = /#\w*歌枠リレー\w*|#\w*歌リレー\w*|#\w*歌ってみた\w*/;

function namesFromHtml(html: string): string[] {
  const names: string[] = [];
  const text = html.replace(/<[^>]*>/g, " ");
  for (const line of text.split(/[\n\r]+/)) {
    const name = line.trim().replace(/\s+/g, " ");
    if (!name) continue;
    if (!SINGING_EVENT_TAG.test(name)) continue;
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

  // Existing entries, keyed by name.
  const existing: SingingEventEntry[] = (() => {
    try {
      const data = JSON.parse(fs.readFileSync(OUT, "utf-8"));
      return Array.isArray(data.entries) ? data.entries : [];
    } catch {
      return [];
    }
  })();

  const byName = new Map<string, SingingEventEntry>();
  for (const e of existing) byName.set(e.name, { ...e });

  let fetched = 0;
  let added = 0;

  for (const url of URLS) {
    const html = await fetchText(url);
    if (!html) continue;
    fetched++;
    for (const m of html.match(SINGING_EVENT_TAG) ?? []) {
      const tag = m.replace(/^#/, "");
      const existingEntry = byName.get(tag);
      if (existingEntry) {
        if (!existingEntry.sources.includes("twipla")) {
          existingEntry.sources.push("twipla");
        }
        continue;
      }
      byName.set(tag, {
        name: tag,
        month: null,
        count: 1,
        firstSeen: now,
        sources: ["twipla"],
      });
      added++;
    }
  }

  const entries = [...byName.values()].sort(
    (a, b) => (b.count ?? 0) - (a.count ?? 0) || a.name.localeCompare(b.name),
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
