#!/usr/bin/env tsx
/**
 * Splits the catalogue into **volumes** — one self-contained dataset per
 * repository — and checks that the split is a partition.
 *
 *   npm run data:volumes -- --dry-run            # plan only
 *   npm run data:volumes -- --count 4            # write .volumes/vol-0 … vol-3
 *   npm run data:volumes -- --count auto         # as many as the 700 MB budget needs
 *   npm run data:volumes -- --verify .volumes    # prove an existing split holds
 *   npm run data:volumes -- --self-test          # check volumeOf() itself
 *
 * The assignment is `volumeOf(id, count)` from `scripts/lib/volume.ts`, so a
 * channel lands in the same volume on every machine and the split can be
 * verified from the ids alone.
 *
 * This writes to `--out` (default `.volumes/`, git-ignored) and never touches
 * `data/`. Each `<out>/vol-N` is a **site root**: it holds its dataset under
 * `data/`, exactly like `public/` does, so it can be published as the root of
 * its own repository. Taking the split live is still a manual step: create one
 * repository per volume, push `<out>/vol-N` into it, and point the client at
 * the origins.
 * The point of doing it here first is that the expensive, irreversible part —
 * deciding which channel belongs where — is done and checked before anything
 * is published.
 */

import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, formatBytes, readJson, writeJson } from "./lib/io";
import {
  layoutFor,
  readAllChannelRecords,
  readAllItems,
  rebuildChannelsManifest,
  writeChannelShards,
  writeItemShards,
} from "./lib/dataset";
import { buildRegionMeta } from "./lib/regions";
import { SCHEMA_VERSION } from "./lib/types";
import type {
  Channel,
  Item,
  Manifest,
  ManifestCounts,
  RegionCode,
} from "./lib/types";
import {
  MAX_VOLUMES,
  checkPartition,
  movedShare,
  parseVolumeCount,
  planVolumes,
  volumeIndexOf,
  volumeName,
  volumeOf,
  volumesNeeded,
} from "./lib/volume";
import { buildSearchIndex } from "./build-index";

interface Options {
  count: string;
  out: string;
  budgetMb: number;
  dryRun: boolean;
  verify: string | null;
  selfTest: boolean;
  index: boolean;
  items: boolean;
  /**
   * Where each volume will be served, with `{name}` and `{index}` placeholders.
   * The default — a subdirectory beside the primary — is what a local check and
   * a single-site deployment use; separate repositories pass their own host.
   */
  baseUrl: string;
  /**
   * Write **one** volume and nothing else.
   *
   * A parallel workflow gives each job a volume and a fresh checkout, and
   * writing all twenty in every job means each one spends minutes producing
   * nineteen directories it will throw away — 2.6 GB per job, twenty times.
   * `--only 7` writes `vol-7` alone; the fan-in job still needs the whole set
   * and calls this without the flag.
   */
  only: number | null;
}

function parseOptions(argv: string[]): Options {
  const value = (flag: string): string | undefined => {
    const at = argv.indexOf(flag);
    return at >= 0 ? argv[at + 1] : undefined;
  };
  const budget = Number(value("--budget-mb") ?? 700);
  return {
    count: value("--count") ?? "auto",
    out: path.resolve(value("--out") ?? ".volumes"),
    budgetMb: Number.isFinite(budget) && budget > 0 ? budget : 700,
    dryRun: argv.includes("--dry-run"),
    verify: value("--verify") ? path.resolve(value("--verify") as string) : null,
    selfTest: argv.includes("--self-test"),
    index: argv.includes("--index"),
    items: !argv.includes("--no-items"),
    baseUrl: value("--base-url") ?? "{name}/",
    only: (() => {
      const raw = value("--only");
      if (raw === undefined) return null;
      const parsed = Number(raw);
      return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
    })(),
  };
}

/* -------------------------------------------------------------------------- */
/* Counts                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The same shape `sync.ts` writes into `manifest.json`, computed for a slice.
 * A volume's counts are the counts of its own records, never the catalogue's.
 */
function countsOf(channels: Channel[], items: Item[]): ManifestCounts {
  return {
    channels: channels.length,
    channelsVirtual: channels.filter((c) => c.kind === "virtual").length,
    channelsReal: channels.filter((c) => c.kind === "real").length,
    channelsSinging: channels.filter((c) => c.isSinging).length,
    items: items.length,
    itemsLive: items.filter((i) => i.status === "live").length,
    itemsUpcoming: items.filter((i) => i.status === "upcoming").length,
    itemsVideo: items.filter((i) => i.type === "video").length,
    itemsPlaylist: items.filter((i) => i.type === "playlist").length,
    itemsCover: items.filter((i) => i.category === "cover").length,
    itemsMv: items.filter((i) => i.category === "mv").length,
    itemsOriginal: items.filter((i) => i.category === "original").length,
  };
}

/** `manifest.json` for one volume: its own counts, and no API quota at all. */
function writeVolumeManifest(
  root: string,
  channels: Channel[],
  items: Item[],
  index: number,
  count: number,
  now: string,
): void {
  const perRegion = new Map<RegionCode, { channels: number; items: number }>();
  for (const channel of channels) {
    const entry = perRegion.get(channel.region) ?? { channels: 0, items: 0 };
    entry.channels++;
    perRegion.set(channel.region, entry);
  }
  for (const item of items) {
    const entry = perRegion.get(item.region) ?? { channels: 0, items: 0 };
    entry.items++;
    perRegion.set(item.region, entry);
  }

  const manifest: Manifest = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: now,
    counts: countsOf(channels, items),
    regions: buildRegionMeta(perRegion),
    quota: { used: 0, limit: 0, remaining: 0 },
    notes:
      `Volume ${index + 1} of ${count} — one slice of the catalogue, assigned ` +
      "by volumeOf(id). The other volumes are separate repositories.",
  };
  writeJson(layoutFor(root).manifest, manifest);
}

/** The directory of one volume — the site root, holding `data/`. */
function volumeSite(out: string, index: number): string {
  return path.join(out, volumeName(index));
}

/** Fills in the placeholders of `--base-url` for one volume. */
function baseOf(template: string, index: number): string {
  return template
    .replace(/\{name\}/g, volumeName(index))
    .replace(/\{index\}/g, String(index));
}

/**
 * The descriptor a client reads to find the other volumes.
 *
 * It is written into **every** volume, and it is the same file in each: a
 * client that lands on any one of them can discover the rest without being
 * told which is the primary. `base` is where that volume is served — relative
 * to the deployment (`vol-2/`) or absolute (`https://…/vol-2/`), because the
 * volumes are separate repositories and may be separate sites.
 */
function writeVolumesDescriptor(
  out: string,
  count: number,
  totals: { channels: number; items: number }[],
  template: string,
  now: string,
  only: number | null = null,
): void {
  const file = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: now,
    count,
    volumes: totals.map((total, index) => ({
      index,
      name: volumeName(index),
      /**
       * Volume 0 is the origin the page was served from, so its base is empty
       * and its dataset is read from `data/` exactly as a single-origin
       * deployment reads it. Every other volume says where it is served.
       */
      base: index === 0 ? "" : baseOf(template, index),
      channels: total.channels,
      items: total.items,
    })),
  };
  for (let index = 0; index < count; index++) {
    /**
     * `--only` writes the descriptor into the one volume requested. The other
     * directories are not created at all — the point of the flag is that a
     * parallel job writes nothing it will not use.
     */
    if (only !== null && index !== only) continue;
    writeJson(path.join(volumeSite(out, index), "data", "volumes.json"), file);
  }
}

/**
 * Curation is not split. An override says "this record is a fan channel, hide
 * it" or "this record is really Japanese" — a volume that did not receive it
 * would show the mistake the override exists to fix. The file is small, and a
 * copy per volume keeps every volume correct on its own.
 */
function copyOverrides(root: string): void {
  const source = path.join(DATA_DIR, "overrides.json");
  if (!fs.existsSync(source)) return;
  fs.copyFileSync(source, path.join(root, "overrides.json"));
}

/* -------------------------------------------------------------------------- */
/* Split                                                                      */
/* -------------------------------------------------------------------------- */

function split(options: Options): void {
  const now = new Date().toISOString();
  const channels = readAllChannelRecords();
  const items = options.items ? readAllItems() : [];

  if (!channels.length) {
    console.error("  data/channels holds no records — run `npm run data:sync` first.");
    process.exitCode = 1;
    return;
  }

  const budgetBytes = options.budgetMb * 1024 * 1024;
  const count =
    options.count === "auto"
      ? volumesNeeded(
          channels.map((c) => ({
            id: c.id,
            bytes: Buffer.byteLength(JSON.stringify(c)),
          })),
          budgetBytes,
        )
      : Math.min(parseVolumeCount(options.count), MAX_VOLUMES);

  const slices = planVolumes(channels, count, (c) => c.id);
  const itemSlices = planVolumes(items, count, (i) => i.channelId);

  console.log("");
  console.log(
    `  ${channels.length} channel(s), ${items.length} item(s) → ${count} volume(s)`,
  );
  if (options.count === "auto") {
    console.log(
      `  count auto: the smallest split whose largest volume fits ${options.budgetMb} MB`,
    );
  }
  console.log("");
  console.log("  volume      channels   virtual     real      items       bytes");
  for (const slice of slices) {
    const sliceItems = itemSlices[slice.index].records;
    const bytes = slice.records.reduce(
      (sum, c) => sum + Buffer.byteLength(JSON.stringify(c)),
      0,
    );
    console.log(
      `  ${slice.name.padEnd(10)} ` +
        `${String(slice.records.length).padStart(10)} ` +
        `${String(slice.records.filter((c) => c.kind === "virtual").length).padStart(9)} ` +
        `${String(slice.records.filter((c) => c.kind === "real").length).padStart(9)} ` +
        `${String(sliceItems.length).padStart(10)} ` +
        `${formatBytes(bytes).padStart(11)}`,
    );
  }

  /**
   * The next volume is the one that matters. If it would move a large share of
   * the catalogue, the function is not stable and a split would rewrite every
   * repository at once.
   */
  if (count < MAX_VOLUMES) {
    const ids = channels.map((c) => c.id);
    const share = movedShare(ids, count, count + 1);
    const ideal = 1 / (count + 1);
    console.log("");
    console.log(
      `  growing to ${count + 1} volumes moves ${(share * 100).toFixed(1)} % of records ` +
        `(ideal ${(ideal * 100).toFixed(1)} %)`,
    );
  }

  if (options.dryRun) {
    console.log("\n  --dry-run: nothing written.");
    return;
  }

  if (options.only !== null) {
    /**
     * One volume, written into a fresh directory for it.
     *
     * The whole of `.volumes/` is **not** removed: a job that was given
     * `--only 7` must not delete the volumes beside it, and a re-run in the
     * same checkout has to be idempotent.
     */
    if (options.only >= count) {
      console.error(
        `  --only ${options.only} is outside the ${count} volume(s) requested`,
      );
      process.exitCode = 1;
      return;
    }
    fs.rmSync(volumeSite(options.out, options.only), {
      recursive: true,
      force: true,
    });
    fs.mkdirSync(options.out, { recursive: true });
  } else {
    fs.rmSync(options.out, { recursive: true, force: true });
    fs.mkdirSync(options.out, { recursive: true });
  }

  const totals: { channels: number; items: number }[] = [];
  for (const slice of slices) {
    const sliceItems = itemSlices[slice.index].records;
    totals.push({ channels: slice.records.length, items: sliceItems.length });
    if (options.only !== null && slice.index !== options.only) continue;

    const root = path.join(volumeSite(options.out, slice.index), "data");
    fs.mkdirSync(root, { recursive: true });

    writeChannelShards(slice.records, now, root);
    rebuildChannelsManifest(slice.records, now, root);
    if (options.items) writeItemShards(sliceItems, now, root);
    writeVolumeManifest(root, slice.records, sliceItems, slice.index, count, now);
    copyOverrides(root);
    if (options.index) buildSearchIndex(root);

    const bytes = slice.records.reduce(
      (sum, c) => sum + Buffer.byteLength(JSON.stringify(c)),
      0,
    );
    console.log(
      `\n  wrote ${slice.name}: ${slice.records.length} channel(s), ` +
        `${sliceItems.length} item(s), ${formatBytes(bytes)} of records`,
    );
  }

  writeVolumesDescriptor(
    options.out,
    count,
    totals,
    options.baseUrl,
    now,
    options.only,
  );

  const problems = checkPartition(
    channels.map((c) => c.id),
    new Map(slices.map((s) => [s.index, s.records.map((c) => c.id)])),
    count,
  );
  if (problems.length) {
    console.error(`\n  ${problems.length} partition problem(s):`);
    for (const problem of problems.slice(0, 20)) {
      console.error(`    ${problem.id} ${problem.message}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log(
    `\n  ✓ every channel is in exactly one volume, and the one volumeOf() names`,
  );
  console.log(`  ${options.out}`);
}

/* -------------------------------------------------------------------------- */
/* Verify                                                                     */
/* -------------------------------------------------------------------------- */

function verify(dir: string): void {
  if (!fs.existsSync(dir)) {
    console.error(`  ${dir} does not exist.`);
    process.exitCode = 1;
    return;
  }

  const names = fs
    .readdirSync(dir)
    .filter((entry) => volumeIndexOf(entry) !== null)
    .sort((a, b) => (volumeIndexOf(a) ?? 0) - (volumeIndexOf(b) ?? 0));

  if (!names.length) {
    console.error(`  ${dir} holds no vol-N directories.`);
    process.exitCode = 1;
    return;
  }

  const count = names.length;
  const found = new Map<number, string[]>();
  const stale: string[] = [];
  let total = 0;

  console.log("");
  console.log("  volume      channels   virtual     real   manifest");
  for (const name of names) {
    const index = volumeIndexOf(name) as number;
    /**
     * A volume is a site root with its dataset under `data/`. Older splits
     * wrote the dataset at the root itself, and a verifier that refuses to
     * read them would call a valid split broken.
     */
    const site = path.join(dir, name);
    const root = fs.existsSync(path.join(site, "data"))
      ? path.join(site, "data")
      : site;
    const records = readAllChannelRecords(root);
    found.set(index, records.map((c) => c.id));
    total += records.length;

    const manifest = readJson<{ total?: number } | null>(
      layoutFor(root).channelsManifest,
      null,
    );
    const declared = manifest?.total ?? -1;
    const ok = declared === records.length ? "✓" : `✗ ${declared}`;
    if (declared !== records.length) {
      stale.push(
        `${name}/channels/manifest.json says ${declared}, the shards hold ${records.length}`,
      );
    }
    console.log(
      `  ${name.padEnd(10)} ` +
        `${String(records.length).padStart(10)} ` +
        `${String(records.filter((c) => c.kind === "virtual").length).padStart(9)} ` +
        `${String(records.filter((c) => c.kind === "real").length).padStart(9)} ` +
        `${ok.padStart(10)}`,
    );
  }

  const expected = readAllChannelRecords().map((c) => c.id);
  const problems = checkPartition(expected, found, count);

  console.log("");
  console.log(
    `  ${total} record(s) across ${count} volume(s); source data/ holds ${expected.length}`,
  );

  if (stale.length) {
    console.error("  ✗ stale shard map(s):");
    for (const line of stale) console.error(`    ${line}`);
  }

  if (problems.length) {
    console.error(`  ✗ ${problems.length} problem(s):`);
    for (const problem of problems.slice(0, 20)) {
      console.error(`    ${problem.id} ${problem.message}`);
    }
    if (problems.length > 20) {
      console.error(`    … and ${problems.length - 20} more`);
    }
  }

  if (stale.length || problems.length) {
    process.exitCode = 1;
    return;
  }

  console.log(
    "  ✓ partition holds: no duplicate, no omission, every record where volumeOf() names it",
  );
}

/* -------------------------------------------------------------------------- */
/* Self-test                                                                  */
/* -------------------------------------------------------------------------- */

function selfTest(): void {
  const ids = readAllChannelRecords().map((c) => c.id);
  const sample = ids.length ? ids : Array.from({ length: 5000 }, (_, i) => `UC${i}`);
  let failures = 0;
  const check = (ok: boolean, label: string, detail: string): void => {
    if (!ok) failures++;
    console.log(`  ${ok ? "✓" : "✗"} ${label.padEnd(52)} ${detail}`);
  };

  // 1. Pure: the same id and count always give the same answer.
  const first = sample.map((id) => volumeOf(id, 7));
  const second = sample.map((id) => volumeOf(id, 7));
  check(
    first.every((v, i) => v === second[i]),
    "deterministic",
    "same id, same count → same volume",
  );

  // 2. Total: every id lands in range, for every count.
  let outOfRange = 0;
  for (let count = 1; count <= 12; count++) {
    for (const id of sample) {
      const v = volumeOf(id, count);
      if (!Number.isInteger(v) || v < 0 || v >= count) outOfRange++;
    }
  }
  check(outOfRange === 0, "total", "every id lands in [0, count)");

  // 3. Balanced: no volume carries twice its share.
  let worstRatio = 0;
  for (let count = 2; count <= 8; count++) {
    const sizes = new Array<number>(count).fill(0);
    for (const id of sample) sizes[volumeOf(id, count)]++;
    const ideal = sample.length / count;
    const ratio = Math.max(...sizes) / ideal;
    worstRatio = Math.max(worstRatio, ratio);
  }
  check(
    worstRatio < 1.25,
    "balanced",
    `largest volume is ${(worstRatio * 100 - 100).toFixed(1)} % over its share`,
  );

  // 4. Stable: growing by one volume moves about 1/(N+1), never more.
  let worstMove = 0;
  for (let count = 1; count <= 8; count++) {
    const share = movedShare(sample, count, count + 1);
    const ideal = 1 / (count + 1);
    worstMove = Math.max(worstMove, share / ideal);
  }
  check(
    worstMove < 1.25,
    "stable under growth",
    `adding a volume moves at most ${(worstMove * 100).toFixed(0)} % of the ideal share`,
  );

  // 5. Never moves between existing volumes: 3 → 4 only pulls into vol-3.
  let crossMoves = 0;
  for (const id of sample) {
    const before = volumeOf(id, 3);
    const after = volumeOf(id, 4);
    if (after !== before && after !== 3) crossMoves++;
  }
  check(
    crossMoves === 0,
    "no reshuffle",
    "3 → 4 moves records only into the new volume",
  );

  console.log("");
  if (failures) {
    console.error(`  ${failures} check(s) failed`);
    process.exitCode = 1;
  } else {
    console.log(`  ✓ volumeOf() passed every check over ${sample.length} ids`);
  }
}

/* -------------------------------------------------------------------------- */

function main(): void {
  const options = parseOptions(process.argv.slice(2));
  if (options.selfTest) return selfTest();
  if (options.verify) return verify(options.verify);
  split(options);
}

main();
