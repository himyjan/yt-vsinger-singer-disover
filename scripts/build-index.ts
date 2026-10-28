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
  SIZE_BUDGET,
  ensureDir,
  formatBytes,
  readJson,
  writeJson,
  writeJsonIfChanged,
} from "./lib/io";
import { layoutFor, readAllChannelRecords } from "./lib/dataset";
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
  /**
   * One row per **pack**, in the order they belong together: `shard` 0 is
   * `<region>.json`, shard 1 `<region>.1.json`, and so on.
   */
  regions: { code: RegionCode; shard: number; entries: number; bytes: number }[];
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
export function buildSearchIndex(root: string = DATA_DIR): void {
  const now = new Date().toISOString();
  const l = layoutFor(root);

  // Full channel records live in the kind datasets, sharded by region; the
  // index file only holds lightweight summaries.
  const channels: Channel[] = readAllChannelRecords(root);

  const items: Item[] = [];
  const itemsRoot = path.join(root, "items");
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

  const searchDir = path.join(root, "search");
  ensureDir(searchDir);

  const keep = new Set<string>();
  const meta: SearchManifestFile["regions"] = [];
  let total = 0;

  for (const region of ALL_REGIONS) {
    const records = byRegion.get(region);
    if (!records?.length) continue;

    /**
     * A pack is a file, and a file has a ceiling. `en` outgrew it — 19,000
     * records of token list, postings and idf came to 9.8 MB — so a region is
     * written as as many packs as the budget needs, the first one keeping the
     * historical `<region>.json` name so an older reader still finds it.
     * Each pack is a complete inverted index over its own slice, which is why
     * the browser concatenates them: token lookups are per pack anyway.
     */
    const bytesOf = (list: typeof records): number =>
      Buffer.byteLength(JSON.stringify(buildPack(region, list, now, aliasText)), "utf8") + 1;

    const parts = Math.max(
      1,
      Math.ceil(bytesOf(records) / SIZE_BUDGET.maxSearchPackBytes),
    );
    const per = Math.ceil(records.length / parts);

    for (let shard = 0; shard < parts; shard++) {
      const slice = records.slice(shard * per, (shard + 1) * per);
      if (!slice.length) continue;
      const file = shard === 0 ? `${region}.json` : `${region}.${shard}.json`;
      const pack = buildPack(region, slice, now, aliasText);
      keep.add(file);
      const target = l.searchRegion(region, shard);
      writeJsonIfChanged(target, pack);
      const bytes = fs.statSync(target).size;
      meta.push({ code: region, shard, entries: pack.count, bytes });
      total += pack.count;
    }
  }

  // Drop packs for regions that no longer exist.
  for (const file of fs.readdirSync(searchDir)) {
    if (!file.endsWith(".json")) continue;
    if (keep.has(file)) continue;
    fs.rmSync(path.join(searchDir, file), { force: true });
  }

  writeJson(l.searchManifest, {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: now,
    regions: meta,
    total,
  } satisfies SearchManifestFile);

  const bytes = meta.reduce((sum, m) => sum + m.bytes, 0);
  console.log(
    `[build:index] ${total} entries across ${meta.length} pack(s) of ` +
      `${byRegion.size} region(s) · ${formatBytes(bytes)}`,
  );
  for (const m of meta) {
    console.log(
      `  ${(m.shard === 0 ? m.code : `${m.code}.${m.shard}`).padEnd(10)} ` +
        `${String(m.entries).padStart(7)} entries  ${formatBytes(m.bytes).padStart(9)}`,
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

if (invokedDirectly) {
  const rootFlag = process.argv.indexOf("--root");
  const root = rootFlag >= 0 ? process.argv[rootFlag + 1] : DATA_DIR;
  buildSearchIndex(root);
}
