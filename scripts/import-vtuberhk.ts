#!/usr/bin/env tsx
/**
 * Compares a VtuberHK harvest with the dataset, and can import the new
 * channels and fill the counts the platform does not publish.
 *
 * `scripts/harvest-vtuberhk.ts` produces a snapshot in `.cache/`; this is the
 * gate between that snapshot and `data/`. It prints what would change and
 * writes nothing without `--apply`.
 *
 * The site publishes the `UC…` id of every channel it lists, so unlike the
 * vTubie listing there is no name search anywhere in this path: the only
 * question is whether an account is a *performer* (`AGENTS.md` rule 15).
 *
 *   - the roster is a Hong Kong directory, so every entry it carries is a
 *     **virtual claim** — `rosterIds` — and its region is `hk` **when the
 *     profile decides nothing** (a Japanese performer who streams with a Hong
 *     Kong group keeps `jp`);
 *   - 「己引退」 (retired) is the roster's `activity: "graduated"` and
 *     「準備中」 is `preparing`; a roster is the only source that states them;
 *   - 「相關組織」 are agencies, not performers, and are reported separately;
 *   - `detectClipAccount()` and `isFanAccountName()` must both be false, since
 *     a clip channel happily calls itself a VTuber while duplicating the
 *     performer it clips.
 *
 * ## The counts
 *
 * `channels.json` is a `channels.list` dump, so it carries the channel's total
 * **view count** — a field InnerTube's profile does not publish and the
 * dataset has therefore never filled — and the video count. A new record takes
 * them through the import's roster hint; `--stats` also backfills the records
 * that are already tracked, where a field is still empty. It never overwrites
 * a number the platform supplied: a college dump is older than a profile read
 * a moment ago.
 *
 *   npm run data:vtuberhk-import                # report only
 *   npm run data:vtuberhk-import -- --limit 50  # report 50 rows
 *   npm run data:vtuberhk-import -- --apply     # import, 50 at a time
 *   npm run data:vtuberhk-import -- --stats --apply  # + fill view/video counts
 */

import fs from "node:fs";
import {
  readAllChannelRecords,
  rebuildChannelsManifest,
  refreshManifestChannelCounts,
  writeChannelShards,
} from "./lib/dataset";
import { detectClipAccount, isFanAccountName } from "./lib/classify";
import { acquireRunLock } from "./lib/io";
import { importYouTubeChannels, type RosterHint } from "./lib/import-channels";
import {
  activityOf,
  type VtuberHkMeta,
  type VtuberHkSnapshot,
} from "./lib/vtuberhk";
import type { Activity, Channel } from "./lib/types";

const SNAPSHOT = ".cache/vtuberhk-channels.json";

interface Options {
  apply: boolean;
  limit: number | null;
  batchSize: number;
  stats: boolean;
}

function parseArgs(argv: string[]): Options {
  const options: Options = { apply: false, limit: null, batchSize: 50, stats: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--apply") options.apply = true;
    else if (arg === "--stats") options.stats = true;
    else if (arg === "--limit") options.limit = Number(argv[++i] ?? 50);
    else if (arg === "--batch") options.batchSize = Math.min(50, Number(argv[++i] ?? 50));
    else if (arg === "--help" || arg === "-h") {
      console.log(
        [
          "Usage: npm run data:vtuberhk-import -- [options]",
          "",
          "  --apply        import the channels the gate admits",
          "  --limit <n>    import at most n channels",
          "  --batch <n>    ids per import call (max 50)",
          "  --stats        fill viewCount / videoCount / subscribers from channels.json",
        ].join("\n"),
      );
      process.exit(0);
    }
  }
  return options;
}

type Verdict = "new" | "tracked" | "organization" | "fan" | "duplicate";

interface Row {
  id: string;
  name: string;
  status: VtuberHkSnapshot["channels"][number]["status"];
  activity: Activity;
  verdict: Verdict;
  reason?: string;
}

/**
 * A field the record is missing and the roster can fill.
 *
 * `subscribers` is a `CountRef`, and `hidden` is a real answer a channel
 * gives — so only `hidden` is filled when the roster says the count is public,
 * and only `no` when the roster has a number. A count the platform published
 * is never replaced.
 */
function missingCounts(channel: Channel, meta: VtuberHkMeta): string[] {
  const fields: string[] = [];
  const subscriberMissing =
    channel.subscribers.tag !== "has" &&
    !(channel.subscribers.tag === "hidden" && meta.subscribersHidden) &&
    (meta.subscribers != null || meta.subscribersHidden);
  if (subscriberMissing) fields.push("subscribers");
  if (channel.videoCount == null && meta.videos != null) fields.push("videoCount");
  if (channel.viewCount == null && meta.views != null) fields.push("viewCount");
  return fields;
}

/**
 * Fills the empty counts of the records already on disk.
 *
 * Only empty ones: `--stats` is a backfill, not a refresh, and a number the
 * platform supplied is never replaced by a roster's older dump.
 */
function backfillStats(
  records: Channel[],
  meta: Record<string, VtuberHkMeta>,
  apply: boolean,
): { records: number; fields: number } {
  let touched = 0;
  let fields = 0;
  for (const channel of records) {
    const entry = meta[channel.id];
    if (!entry) continue;
    const missing = missingCounts(channel, entry);
    if (!missing.length) continue;
    touched++;
    fields += missing.length;
    if (!apply) continue;
    if (missing.includes("subscribers")) {
      channel.subscribers = entry.subscribersHidden
        ? { tag: "hidden" }
        : { tag: "has", count: entry.subscribers ?? 0 };
    }
    if (missing.includes("videoCount")) channel.videoCount = entry.videos;
    if (missing.includes("viewCount")) channel.viewCount = entry.views;
  }
  return { records: touched, fields };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(SNAPSHOT)) {
    console.error(
      `no snapshot at ${SNAPSHOT} — run \`npm run data:vtuberhk\` first`,
    );
    process.exit(1);
  }
  const snapshot = JSON.parse(fs.readFileSync(SNAPSHOT, "utf8")) as VtuberHkSnapshot;
  const meta = snapshot.meta ?? {};
  const dataset = readAllChannelRecords();
  const tracked = new Map(dataset.map((channel) => [channel.id, channel]));

  const seen = new Set<string>();
  const rows: Row[] = [];
  for (const channel of snapshot.channels) {
    const activity = activityOf(channel.status);
    if (channel.status === "organization") {
      rows.push({ ...channel, activity, verdict: "organization", reason: "an agency, not a performer" });
      continue;
    }
    /**
     * The roster's virtual claim does not make a clip channel a performer:
     * 切片 channels are named after the person they clip, and a directory
     * that lists "any VTuber" lists them too.
     */
    if (detectClipAccount(channel.name, "") || isFanAccountName(channel.name)) {
      rows.push({ ...channel, activity, verdict: "fan", reason: "a clip or fan account" });
      continue;
    }
    if (seen.has(channel.id)) {
      rows.push({ ...channel, activity, verdict: "duplicate", reason: "another row lists the same channel" });
      continue;
    }
    seen.add(channel.id);
    rows.push({
      ...channel,
      activity,
      verdict: tracked.has(channel.id) ? "tracked" : "new",
    });
  }

  const counts = new Map<Verdict, number>();
  for (const row of rows) counts.set(row.verdict, (counts.get(row.verdict) ?? 0) + 1);

  console.log(
    `snapshot ${snapshot.generatedAt} · ${snapshot.channels.length} channel(s) · ` +
      `${Object.keys(meta).length} metadata row(s)`,
  );
  for (const verdict of ["new", "tracked", "organization", "fan", "duplicate"] as const) {
    const count = counts.get(verdict) ?? 0;
    if (count) console.log(`  ${verdict.padEnd(14)} ${count}`);
  }
  for (const verdict of ["organization", "fan", "duplicate"] as const) {
    const rejected = rows.filter((row) => row.verdict === verdict);
    if (!rejected.length) continue;
    console.log(`\n${verdict} (${rejected.length}):`);
    for (const row of rejected.slice(0, 12)) {
      console.log(`  ${row.name} — ${row.reason}`);
    }
    if (rejected.length > 12) console.log(`  … ${rejected.length - 12} more`);
  }

  const fresh = rows.filter((row) => row.verdict === "new");
  if (options.stats) {
    const preview = backfillStats(dataset, meta, false);
    console.log(
      `\n${preview.records} tracked record(s) are missing ${preview.fields} count(s) ` +
        `channels.json can fill` +
        (options.apply ? "" : " (dry run)"),
    );
  }
  if (!options.apply) {
    console.log(
      `\n${fresh.length} channel(s) would be imported` +
        (fresh.length
          ? `:\n${fresh
              .slice(0, 20)
              .map((row) => `  ${row.id}  ${row.name}  [${row.status}]`)
              .join("\n")}`
          : "") +
        "\n\nNothing was written. Re-run with --apply.",
    );
    return;
  }

  /**
   * What the roster knows and the profile does not: the scene, whether the
   * performer has graduated, and the counts. The region is applied only where
   * the profile decided nothing, and a count only where the record is empty.
   */
  const activity: Record<string, Activity> = {};
  const stats: RosterHint["stats"] = {};
  for (const row of rows) {
    if (row.verdict === "organization") continue;
    if (row.activity !== "unknown") activity[row.id] = row.activity;
    const entry = meta[row.id];
    if (entry) {
      stats[row.id] = {
        subscribers: entry.subscribers,
        videoCount: entry.videos,
        viewCount: entry.views,
      };
    }
  }
  const ids = (options.limit === null ? fresh : fresh.slice(0, options.limit)).map(
    (row) => row.id,
  );
  const rosterIds = new Set(ids);

  let added = 0;
  let existing = 0;
  let failed = 0;
  for (let offset = 0; offset < ids.length; offset += options.batchSize) {
    const result = await importYouTubeChannels(
      ids.slice(offset, offset + options.batchSize),
      {
        limit: options.batchSize,
        rosterIds,
        rosterHint: { region: "hk", activity, stats },
        onLog: (message) => console.log(`  ${message}`),
      },
    );
    added += result.added.length;
    existing += result.existing;
    failed += result.failed.length;
    for (const failure of result.failed) {
      console.log(`  failed ${failure.id}: ${failure.reason}`);
    }
    console.log(
      `  batch ${Math.floor(offset / options.batchSize) + 1}: ` +
        `+${result.added.length} new · ${result.existing} tracked · ${result.failed.length} failed`,
    );
  }

  console.log(
    `\n${added} channel(s) written · ${existing} already tracked · ${failed} failed`,
  );

  if (options.stats) {
    const now = new Date().toISOString();
    const release = acquireRunLock("vtuberhk-stats");
    try {
      const all = readAllChannelRecords();
      const filled = backfillStats(all, meta, true);
      if (filled.records) {
        writeChannelShards(all, now);
        rebuildChannelsManifest(all, now);
        refreshManifestChannelCounts(all, now);
      }
      console.log(
        `${filled.records} record(s) had ${filled.fields} count(s) filled from channels.json`,
      );
    } finally {
      release();
    }
  }

  console.log("Run `npm run data:index` and `npm run data:validate` next.");
}

main();
