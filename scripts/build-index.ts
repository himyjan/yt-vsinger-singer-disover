#!/usr/bin/env tsx
/**
 * Builds the inverted search index.
 *
 * Produces one *search pack* per region under `data/search/`. A pack contains
 * the display-ready records for that region plus an inverted index
 * (sorted token list + posting lists + IDF weights) so the browser can answer
 * a query with a few binary searches instead of scanning every record.
 *
 *   npm run build:index
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DATA_DIR,
  ensureDir,
  formatBytes,
  readJson,
  writeJson,
  writeJsonIfChanged,
} from "./lib/io";
import { layout, readAllChannelRecords } from "./lib/dataset";
import { primaryPlatformOf } from "./lib/platforms";
import { ALL_REGIONS, SCHEMA_VERSION } from "./lib/types";
import type {
  Channel,
  ChannelFile,
  Item,
  ItemFile,
  RegionCode,
} from "./lib/types";
import { tokenize } from "./lib/search";
import type { SearchEntryRecord, SearchPack } from "./lib/search";
import { countValue } from "./lib/types";

export interface SearchManifestFile {
  schemaVersion: number;
  generatedAt: string;
  regions: { code: RegionCode; entries: number; bytes: number }[];
  total: number;
}

/* -------------------------------------------------------------------------- */
/* Record construction                                                        */
/* -------------------------------------------------------------------------- */

function channelRecord(c: Channel): SearchEntryRecord {
  return {
    k: "c",
    id: c.id,
    n: c.name,
    g: c.kind,
    r: c.region,
    ts: c.updatedAt ? Date.parse(c.updatedAt) || 0 : 0,
    cn: c.name,
    th: c.avatar,
    sb: countValue(c.subscribers),
  };
}

function itemRecord(i: Item): SearchEntryRecord {
  return {
    k: "i",
    id: i.id,
    n: i.title,
    g: i.channelKind,
    r: i.region,
    c: i.category,
    ts:
      (i.scheduledStart ? Date.parse(i.scheduledStart) : 0) ||
      (i.publishedAt ? Date.parse(i.publishedAt) : 0) ||
      0,
    ch: i.channelId,
    cn: i.channelName,
    th: i.thumbnail,
    s: i.songTitle,
    o: i.originalArtist,
    st: i.status,
    d: i.duration,
    ac: i.isAcoustic ? 1 : 0,
    gd: i.gender,
    ai: i.isAi ? 1 : 0,
    vr: i.variant,
  };
}

/**
 * The text that gets indexed for a record.
 *
 * Field order matters slightly: the title/name is repeated once so that
 * queries matching it get a slightly higher term frequency.
 *
 * There is deliberately **no** generic word here. An earlier version indexed
 * the literal `channel` for every channel record, which made the commonest
 * token in the corpus carry no information — it matched all 14,665 channels
 * and buried the specific results under a limit of 120. A word that every
 * record shares is noise, not a field.
 */
function haystackFor(record: SearchEntryRecord): string {
  const parts: (string | null | undefined)[] = [
    record.n,
    record.n,
    record.cn,
    record.s,
    record.o,
  ];
  return parts.filter(Boolean).join(" ");
}


/* -------------------------------------------------------------------------- */
/* Inverted index                                                             */
/* -------------------------------------------------------------------------- */

export function buildPack(
  region: string,
  records: SearchEntryRecord[],
  generatedAt: string,
  aliasText: Map<string, string> = new Map(),
): SearchPack {
  /** token → Set of entry indices. */
  const inverted = new Map<string, number[]>();
  const seen = new Set<number>();

  for (let idx = 0; idx < records.length; idx++) {
    const record = records[idx]!;
    const extra = aliasText.get(record.id);
    const tokens = tokenize(
      extra ? `${haystackFor(record)} ${extra}` : haystackFor(record),
    );
    for (const token of tokens) {
      const list = inverted.get(token);
      if (!list) {
        inverted.set(token, [idx]);
        continue;
      }
      // Postings are kept ascending and de-duplicated.
      if (list[list.length - 1] !== idx) list.push(idx);
    }
    seen.add(idx);
  }

  const tokens = [...inverted.keys()].sort();
  const postings = tokens.map((t) => inverted.get(t)!);

  // IDF = log(1 + N / df). Rare tokens therefore score higher.
  const total = Math.max(1, records.length);
  const idf = postings.map((p) => Math.log(1 + total / Math.max(1, p.length)));

  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt,
    region,
    count: records.length,
    tokens,
    postings,
    idf,
    entries: records,
  };
}

/* -------------------------------------------------------------------------- */
/* Main                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Rebuilds every search pack.
 *
 * Exported because the subscription import creates channel records after the
 * app has started, and a record that is not in a pack is not searchable —
 * the list would show the channel while the search box did not.
 */
export function buildSearchIndex(): void {
  const now = new Date().toISOString();

  // Full channel records live in the kind datasets, sharded by region; the
  // index file only holds lightweight summaries.
  const channels: Channel[] = readAllChannelRecords();

  const items: Item[] = [];
  const itemsRoot = path.join(DATA_DIR, "items");
  if (fs.existsSync(itemsRoot)) {
    for (const region of fs.readdirSync(itemsRoot)) {
      const dir = path.join(itemsRoot, region);
      if (!fs.statSync(dir).isDirectory()) continue;
      for (const file of fs.readdirSync(dir)) {
        if (!file.endsWith(".json")) continue;
        const parsed = readJson<ItemFile>(path.join(dir, file), {
          schemaVersion: SCHEMA_VERSION,
          generatedAt: "",
          items: [],
        });
        items.push(...parsed.items);
      }
    }
  }

  /**
   * The extra text indexed for a channel — its other names.
   *
   * A performer is found under the name they used to have, so the aliases
   * have to be searchable even though they are not displayed.
   *
   * A Bilibili record also indexes the **name its platform gave it**. vdb
   * files 「カグラナナ / ななかぐら」 under Bilibili, and the display name is
   * what the app shows — but the audience that found the performer on
   * Bilibili knows the Bilibili name. Only the record's own platform may
   * decide that name, so this is the link's name on its own platform, never
   * another platform's.
   */
  const aliasText = new Map<string, string>();

  const byRegion = new Map<RegionCode, SearchEntryRecord[]>();
  const push = (r: RegionCode, rec: SearchEntryRecord) => {
    const list = byRegion.get(r) ?? [];
    list.push(rec);
    byRegion.set(r, list);
  };

  for (const c of channels) {
    const record = channelRecord(c);
    const extra = [...(c.aliases ?? [])];

    const primary = primaryPlatformOf(c);
    if (primary && primary !== "youtube" && primary !== "twitch") {
      const own = c.platforms?.find((p) => p.platform === primary);
      const ownName = (own?.name ?? "").trim();
      if (ownName && ownName !== c.name) extra.push(ownName);
    }

    if (extra.length) {
      // Aliases are indexed but not stored, so the pack stays small; the full
      // record keeps them for the drawer.
      aliasText.set(record.id, extra.join(" "));
    }
    push(c.region, record);
  }
  for (const i of items) push(i.region, itemRecord(i));

  const searchDir = path.join(DATA_DIR, "search");
  ensureDir(searchDir);

  const keep = new Set<string>();
  const meta: SearchManifestFile["regions"] = [];
  let total = 0;

  for (const region of ALL_REGIONS) {
    const records = byRegion.get(region);
    if (!records?.length) continue;
    const pack = buildPack(region, records, now, aliasText);
    const file = `${region}.json`;
    keep.add(file);
    writeJsonIfChanged(layout.searchRegion(region), pack);
    const bytes = fs.statSync(layout.searchRegion(region)).size;
    meta.push({ code: region, entries: pack.count, bytes });
    total += pack.count;
  }

  // Drop packs for regions that no longer exist.
  for (const file of fs.readdirSync(searchDir)) {
    if (!file.endsWith(".json")) continue;
    if (keep.has(file)) continue;
    fs.rmSync(path.join(searchDir, file), { force: true });
  }

  writeJson(layout.searchManifest, {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: now,
    regions: meta,
    total,
  } satisfies SearchManifestFile);

  const bytes = meta.reduce((sum, m) => sum + m.bytes, 0);
  console.log(
    `[build:index] ${total} entries across ${meta.length} region packs · ${formatBytes(bytes)}`,
  );
  for (const m of meta) {
    console.log(
      `  ${m.code.padEnd(8)} ${String(m.entries).padStart(7)} entries  ${formatBytes(m.bytes).padStart(9)}`,
    );
  }
}

/**
 * `npm run data:index` runs this file directly; importing it (the import
 * endpoint does) must not rebuild a 30 MB index as a side effect.
 */
const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) buildSearchIndex();
