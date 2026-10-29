#!/usr/bin/env tsx
/**
 * Harvest VTuber singing-event hashtags from YouTube via InnerTube.
 *
 * Searches YouTube for 「歌枠リレー」 (and related terms), extracts hashtags
 * like #○○歌枠リレー from video titles and descriptions, and merges them into
 * lists/singing-events.json — the same unified file the other harvesters use.
 * Nothing is overwritten; existing entries are kept.
 *
 * Costs no YouTube Data API quota — InnerTube only.
 *
 *   npm run data:singing-events-youtube
 */

import fs from "node:fs";
import path from "path";

import { InnerTubeSource } from "./lib/youtubei";
import type { SingingEventEntry, SingingEventsFile } from "./lib/singing-events";

const OUT = "lists/singing-events.json";

/** Broad discovery queries — each surfaces videos carrying event hashtags. */
const QUERIES = [
  "歌枠リレー",
  "歌リレー",
  "歌ってみた リレー",
  "カラオケ リレー",
];

/** A hashtag that names a singing event: #○○歌枠リレー, #○○歌リレー, etc. */
const SINGING_EVENT_TAG = /#\w*歌枠リレー\w*/;

async function main(): Promise<void> {
  const innertube = new InnerTubeSource({
    onLog: (m) => console.error(m),
  });
  await innertube.connect();

  if (!innertube.isAvailable) {
    console.error(
      "warn: InnerTube unavailable — cannot harvest YouTube singing tags",
    );
    process.exit(0);
  }

  // Existing entries, keyed by name so we can merge without duplicating.
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

  const now = new Date().toISOString();
  let found = 0;
  let added = 0;

  for (const query of QUERIES) {
    const videos = await innertube.searchVideos(query, 50);
    for (const video of videos) {
      const text = `${video.title ?? ""} ${video.description ?? ""}`;
      for (const m of text.match(SINGING_EVENT_TAG) ?? []) {
        found++;
        const tag = m.replace(/^#/, "");
        const existingEntry = byName.get(tag);
        if (existingEntry) {
          if (!existingEntry.sources.includes("youtube")) {
            existingEntry.sources.push("youtube");
          }
          continue;
        }
        byName.set(tag, {
          name: tag,
          month: null,
          count: 1,
          firstSeen: now,
          sources: ["youtube"],
        });
        added++;
      }
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
    `${found} tag mention(s) → ${added} new → ${entries.length} total → ${OUT}`,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
