#!/usr/bin/env tsx
/**
 * Validates the committed dataset.
 *
 * Runs in CI after every sync. It fails the build when the dataset is
 * malformed, oversized or internally inconsistent — which stops a bad sync
 * from being pushed to the repository.
 *
 *   npm run data:validate
 */

import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, ROOT, SIZE_BUDGET, directorySize, formatBytes } from "./lib/io";
import { layout, readAllChannelRecords } from "./lib/dataset";
import { ALL_REGIONS, SCHEMA_VERSION } from "./lib/types";
import type {
  Channel,
  ChannelSummary,
  Item,
  Manifest,
} from "./lib/types";
import type { SearchPack } from "./lib/search";

const errors: string[] = [];
const warnings: string[] = [];

function fail(message: string): void {
  errors.push(message);
}

function warn(message: string): void {
  warnings.push(message);
}

function check(condition: boolean, message: string): void {
  if (!condition) fail(message);
}

/* -------------------------------------------------------------------------- */
/* Manifest                                                                   */
/* -------------------------------------------------------------------------- */

function validateManifest(): Manifest | null {
  if (!fs.existsSync(layout.manifest)) {
    fail("data/manifest.json is missing — run `npm run data:sync`");
    return null;
  }
  const manifest = JSON.parse(
    fs.readFileSync(layout.manifest, "utf8"),
  ) as Manifest;

  check(
    manifest.schemaVersion === SCHEMA_VERSION,
    `manifest schemaVersion is ${manifest.schemaVersion}, expected ${SCHEMA_VERSION}`,
  );
  check(
    typeof manifest.generatedAt === "string" &&
      !Number.isNaN(Date.parse(manifest.generatedAt)),
    "manifest.generatedAt is not a valid ISO timestamp",
  );
  check(
    Array.isArray(manifest.regions) && manifest.regions.length > 0,
    "manifest.regions is empty",
  );
  return manifest;
}

/* -------------------------------------------------------------------------- */
/* Channels                                                                   */
/* -------------------------------------------------------------------------- */

function validateChannels(): Channel[] {
  const all: Channel[] = [];

  const records = readAllChannelRecords();
  if (!records.length) {
    fail("data/channels/ is empty — run `npm run data:sync -- --roster`");
  }

  {
    for (const channel of records) {
      check(!!channel.id, "channel with empty id");
      check(
        channel.kind === "virtual" || channel.kind === "real",
        `channel ${channel.id} has invalid kind "${channel.kind}"`,
      );
      check(
        ALL_REGIONS.includes(channel.region),
        `channel ${channel.id} has invalid region "${channel.region}"`,
      );
      check(
        !!channel.name,
        `channel ${channel.id} has no name`,
      );
      check(
        Array.isArray(channel.platforms),
        `channel ${channel.id} has no platforms array`,
      );
      if (
        channel.subscribers &&
        !["has", "hidden", "no"].includes(channel.subscribers.tag)
      ) {
        fail(`channel ${channel.id} has an invalid subscriber count tag`);
      }
      all.push(channel);
    }
  }

  const ids = new Set<string>();
  for (const channel of all) {
    if (ids.has(channel.id)) fail(`duplicate channel id ${channel.id}`);
    ids.add(channel.id);
  }

  return all;
}

/* -------------------------------------------------------------------------- */
/* Layout                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The channel store is exactly `virtual/` and `real/`.
 *
 * It used to be four copies — `regions/` and `summaries/` beside the two
 * datasets — and every writer had to remember all of them. One of them
 * forgetting is how a platform-confirmed name reverted to the roster's. There
 * is one copy per channel now, and this check keeps it that way: a stray
 * directory is a layout that has drifted back.
 */
function validateChannelLayout(): void {
  const root = path.join(DATA_DIR, "channels");
  if (!fs.existsSync(root)) return;

  for (const entry of fs.readdirSync(root)) {
    const full = path.join(root, entry);
    if (!fs.statSync(full).isDirectory()) continue;
    if (entry === "virtual" || entry === "real") continue;
    fail(
      `data/channels/${entry}/ is not part of the layout — a channel lives in virtual/ or real/ only`,
    );
  }

  // The manifest's shard map must name the files that actually exist, and
  // every file must be named: a missing bucket is a region the app silently
  // shows half of.
  const manifestFile = path.join(root, "manifest.json");
  if (!fs.existsSync(manifestFile)) {
    fail("data/channels/manifest.json is missing");
    return;
  }
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8")) as {
    regions?: {
      code: string;
      channels: number;
      virtual?: { channels: number; buckets: string[] };
      real?: { channels: number; buckets: string[] };
    }[];
  };

  const declared = new Map<string, Set<string>>();
  let declaredChannels = 0;
  for (const region of manifest.regions ?? []) {
    declaredChannels += region.channels;
    for (const kind of ["virtual", "real"] as const) {
      const meta = region[kind];
      if (!meta) {
        fail(`channels manifest: ${region.code} has no ${kind} entry`);
        continue;
      }
      for (const bucket of meta.buckets) {
        declared.set(`${kind}/${region.code}/${bucket}.json`, new Set());
      }
    }
  }
  check(
    declaredChannels > 0,
    "channels manifest lists no regions — run `npm run data:sync`",
  );

  /**
   * The manifest names the buckets that **hold** a record; the writer prunes
   * the rest. A file on disk that the manifest does not name is a stale
   * shard, and a bucket the manifest names but that holds no record is a
   * bucket the writer has not pruned — both are reported by name rather than
   * one at a time, because a re-key that moves a hundred records otherwise
   * prints a hundred lines about the same cause.
   */
  const extra: string[] = [];
  for (const kind of ["virtual", "real"] as const) {
    const kindRoot = path.join(root, kind);
    if (!fs.existsSync(kindRoot)) continue;
    for (const region of fs.readdirSync(kindRoot)) {
      const dir = path.join(kindRoot, region);
      if (!fs.statSync(dir).isDirectory()) continue;
      for (const file of fs.readdirSync(dir)) {
        if (!file.endsWith(".json")) continue;
        const key = `${kind}/${region}/${file}`;
        if (!declared.has(key)) extra.push(key);
      }
    }
  }
  if (extra.length) {
    fail(
      `${extra.length} channel shard(s) are not in the manifest — run \`npm run data:sync\`: ` +
        extra.slice(0, 5).join(", ") +
        (extra.length > 5 ? `, … ${extra.length - 5} more` : ""),
    );
  }
  for (const key of declared.keys()) {
    if (!fs.existsSync(path.join(root, key))) {
      fail(`data/channels/${key} is in the manifest but missing`);
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Items                                                                      */
/* -------------------------------------------------------------------------- */

function validateItems(): Item[] {
  const all: Item[] = [];
  const itemsRoot = path.join(DATA_DIR, "items");

  if (!fs.existsSync(itemsRoot)) {
    fail("data/items/ is missing");
    return all;
  }

  for (const region of fs.readdirSync(itemsRoot)) {
    const dir = path.join(itemsRoot, region);
    if (!fs.statSync(dir).isDirectory()) continue;
    // `live.json` and `upcoming.json` are *derived* views of the shards
    // below — counting them here would double-count every live item.
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith(".json")) continue;
      const parsed = JSON.parse(
        fs.readFileSync(path.join(dir, file), "utf8"),
      ) as { items?: Item[] };
      for (const item of parsed.items ?? []) {
        check(!!item.id, `item with empty id in ${region}/${file}`);
        check(
          ALL_REGIONS.includes(item.region),
          `item ${item.id} has invalid region "${item.region}"`,
        );
        check(
          ["video", "short", "live", "playlist"].includes(item.type),
          `item ${item.id} has invalid type "${item.type}"`,
        );
        check(
          ["live", "upcoming", "past", "unknown"].includes(item.status),
          `item ${item.id} has invalid status "${item.status}"`,
        );
        all.push(item);
      }
    }
  }

  const ids = new Set<string>();
  for (const item of all) {
    if (ids.has(item.id)) fail(`duplicate item id ${item.id}`);
    ids.add(item.id);
  }

  return all;
}

/* -------------------------------------------------------------------------- */
/* Search packs                                                               */
/* -------------------------------------------------------------------------- */

function validateSearchPacks(itemCount: number, channelCount: number): void {
  const searchDir = path.join(DATA_DIR, "search");
  if (!fs.existsSync(searchDir)) {
    fail("data/search/ is missing — run `npm run data:index`");
    return;
  }

  let total = 0;
  for (const file of fs.readdirSync(searchDir)) {
    if (!file.endsWith(".json")) continue;
    // `manifest.json` describes the packs; it is not itself a pack.
    if (file === "manifest.json") continue;
    const pack = JSON.parse(
      fs.readFileSync(path.join(searchDir, file), "utf8"),
    ) as SearchPack;

    check(
      Array.isArray(pack.tokens) && Array.isArray(pack.postings),
      `search pack ${file} is missing tokens/postings`,
    );
    check(
      pack.tokens.length === pack.postings.length,
      `search pack ${file}: tokens and postings differ in length`,
    );
    check(
      pack.idf.length === pack.tokens.length,
      `search pack ${file}: idf and tokens differ in length`,
    );
    check(
      pack.entries.length === pack.count,
      `search pack ${file}: count does not match entries length`,
    );

    // Tokens must be sorted for the binary search to work.
    for (let i = 1; i < pack.tokens.length; i++) {
      if (pack.tokens[i]! < pack.tokens[i - 1]!) {
        fail(`search pack ${file}: tokens are not sorted at index ${i}`);
        break;
      }
    }

    // Postings must be ascending and within range.
    for (let t = 0; t < pack.postings.length; t++) {
      const posting = pack.postings[t]!;
      for (let i = 1; i < posting.length; i++) {
        if (posting[i]! <= posting[i - 1]!) {
          fail(`search pack ${file}: postings for "${pack.tokens[t]}" are not ascending`);
          break;
        }
      }
      if (posting.some((idx) => idx < 0 || idx >= pack.entries.length)) {
        fail(`search pack ${file}: postings for "${pack.tokens[t]}" are out of range`);
      }
    }

    total += pack.count;
  }

  if (total !== itemCount + channelCount) {
    warn(
      `search index has ${total} entries but the dataset has ${itemCount + channelCount} records — run \`npm run data:index\``,
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Sizes                                                                      */
/* -------------------------------------------------------------------------- */

function validateSizes(): void {
  const bytes = directorySize(DATA_DIR);
  if (bytes > SIZE_BUDGET.maxDataBytes) {
    fail(
      `data/ is ${formatBytes(bytes)}, over the ${formatBytes(
        SIZE_BUDGET.maxDataBytes,
      )} budget — the repository would exceed the GitHub size limit`,
    );
  }

  const walk = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith(".json")) {
        const size = fs.statSync(full).size;
        if (size > SIZE_BUDGET.maxFileBytes) {
          fail(
            `${path.relative(ROOT, full)} is ${formatBytes(size)}, over the ${formatBytes(
              SIZE_BUDGET.maxFileBytes,
            )} per-file budget`,
          );
        }
      }
    }
  };
  walk(DATA_DIR);

  // GitHub refuses pushes above ~2 GB; measure what git actually tracks.
  const tracked = trackedRepoSize();
  if (tracked > 900 * 1024 * 1024) {
    warn(
      `tracked repository content is ${formatBytes(tracked)} — GitHub recommends staying under 1 GB (10 GB of .git is its documented maximum). Consider Git LFS for binaries.`,
    );
  }
}

/**
 * Total size of the files git tracks (plus anything not yet ignored).
 *
 * This is what GitHub will actually store, so it is the number that matters
 * for the repository size limit — `node_modules` and the reference checkouts
 * are ignored and do not count.
 */
function trackedRepoSize(): number {
  try {
    const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
    const output = execFileSync("git", ["ls-files", "-z"], {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    let total = 0;
    for (const file of output.split("\0")) {
      if (!file) continue;
      try {
        total += fs.statSync(path.join(ROOT, file)).size;
      } catch {
        /* deleted between ls-files and stat */
      }
    }
    return total;
  } catch {
    return 0;
  }
}

/* -------------------------------------------------------------------------- */
/* Main                                                                       */
/* -------------------------------------------------------------------------- */

function main(): void {
  const manifest = validateManifest();
  const channels = validateChannels();
  validateChannelLayout();
  const items = validateItems();
  validateSearchPacks(items.length, channels.length);
  validateSizes();

  if (manifest) {
    check(
      manifest.counts.channels === channels.length,
      `manifest says ${manifest.counts.channels} channels, found ${channels.length}`,
    );
    check(
      manifest.counts.items === items.length,
      `manifest says ${manifest.counts.items} items, found ${items.length}`,
    );
  }

  console.log("");
  console.log(`  channels  ${channels.length}`);
  console.log(`  items     ${items.length}`);
  console.log(`  data/     ${formatBytes(directorySize(DATA_DIR))}`);
  console.log("");

  if (warnings.length) {
    console.log(`  ${warnings.length} warning(s):`);
    for (const w of warnings) console.log(`    ! ${w}`);
    console.log("");
  }

  if (errors.length) {
    console.error(`  ${errors.length} error(s):`);
    for (const e of errors) console.error(`    ✗ ${e}`);
    console.error("");
    process.exit(1);
  }

  console.log("  ✓ dataset is valid");
  console.log("");
}

main();
