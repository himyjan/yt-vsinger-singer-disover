#!/usr/bin/env tsx
/**
 * Compares a vtuberdb.com namelist harvest with the dataset and imports
 * new channels.
 *
 * `scripts/harvest-vtuber-db.ts` produces a snapshot in `.cache/`;
 * this script reads that snapshot and imports each entry through its
 * YouTube channel id (the namelist CSV publishes `チャンネルID` directly,
 * so no name search is needed).
 *
 *   npm run data:vtuber-db-import                     # report only
 *   npm run data:vtuber-db-import -- --apply          # import the new channels
 *   npm run data:vtuber-db-import -- --limit 50       # resolve at most 50 channels
 *
 * Every namelist row is a VTuber — a **virtual claim** (`reincarnationOf`-
 * eligible). Rows whose YouTube link is dead (`リンク切れ`) or that carry no
 * channel id are skipped and reported, never imported.
 *
 * The roster's agency and added date are passed as hints so `classifyChannel`
 * can fall back to them when the profile decides nothing; the platform still
 * owns the name and the record is keyed by the `UC…` channel id.
 */

import fs from "node:fs";
import path from "node:path";
import {
  detectClipAccount,
  isFanAccountName,
  classifyChannel,
} from "./lib/classify";
import { applyChannelEdits } from "./lib/roster-fill";
import {
  importYouTubeChannels,
  type RosterHint,
} from "./lib/import-channels";
import { readAllChannelRecords } from "./lib/dataset";
import { InnerTubeSource } from "./lib/youtubei";
import type { VtuberDbEntry } from "./lib/vtuber-db";
import type { Activity, Channel } from "./lib/types";

const SNAPSHOT = ".cache/vtuber-db/vtuber-db.json";

type Verdict =
  | "tracked"
  | "new"
  | "rejected"
  | "dead"
  | "no-channel"
  | "imported"
  | "skipped";

interface Row {
  entry: VtuberDbEntry;
  channelId: string | null;
  record: Channel | null | undefined;
  verdict: Verdict;
  reason?: string;
}

interface Options {
  apply: boolean;
  limit: number | null;
  batchSize: number;
}

function parseArgs(argv: string[]): Options {
  const options: Options = { apply: false, limit: null, batchSize: 50 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const value = argv[i + 1];
    switch (arg) {
      case "--apply":
        options.apply = true;
        break;
      case "--limit":
        options.limit = Math.max(1, Number(value ?? 1));
        i++;
        break;
      case "--batch":
        options.batchSize = Math.max(1, Math.min(50, Number(value ?? 50)));
        i++;
        break;
      case "--help":
      case "-h":
        console.log(
          [
            "Usage: npm run data:vtuber-db-import -- [options]",
            "",
            "  --apply         import the channels the gate admits",
            "  --limit <n>     import at most n channels",
            "  --batch <n>     channel ids per import call (max 50)",
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

/** Maps the namelist's free-text status to the controlled activity enum. */
function foldActivity(status: string | null): Activity {
  if (!status) return "unknown";
  const s = status.trim();
  if (s.includes("卒業")) return "graduated";
  if (s.includes("準備中")) return "preparing";
  if (s.includes("活動中")) return "active";
  return "unknown";
}

/** The namelist's free-text affiliation is not a controlled vocabulary. */
function foldAffiliation(value: string | null): Channel["affiliation"] {
  if (!value) return "unknown";
  return value.toLowerCase().includes("independent") ||
    value.includes("個人勢") ||
    value.includes("個人") ||
    value.includes("企業勢")
    ? "independent"
    : "group";
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(SNAPSHOT)) {
    console.error(
      `no snapshot at ${SNAPSHOT} — run npm run data:vtuber-db first`,
    );
    process.exit(1);
  }

  const snapshot: {
    entries?: VtuberDbEntry[];
    generatedAt: string;
  } = JSON.parse(fs.readFileSync(SNAPSHOT, "utf8"));
  const entries = snapshot.entries || [];

  const dataset = readAllChannelRecords();
  const byId = new Map(dataset.map((c) => [c.id, c]));

  const rows: Row[] = [];
  for (const entry of entries) {
    // Skip fan / clip accounts before anything else.
    if (
      detectClipAccount(entry.displayName ?? "", entry.agency ?? "") ||
      isFanAccountName(entry.displayName ?? "")
    ) {
      rows.push({
        entry,
        channelId: null,
        record: null,
        verdict: "rejected",
        reason: "a clip or fan account",
      });
      continue;
    }

    // A dead YouTube link can't be imported.
    if (entry.dead) {
      rows.push({
        entry,
        channelId: entry.channelId,
        record: null,
        verdict: "dead",
        reason: "the YouTube link is dead",
      });
      continue;
    }

    if (!entry.channelId) {
      rows.push({
        entry,
        channelId: null,
        record: null,
        verdict: "no-channel",
        reason: "no YouTube channel id in the namelist row",
      });
      continue;
    }

    const existingRecord = byId.get(entry.channelId);
    rows.push({
      entry,
      channelId: entry.channelId,
      record: existingRecord ?? null,
      verdict: existingRecord ? "tracked" : "new",
    });
  }

  console.log(
    `snapshot ${snapshot.generatedAt} · ${entries.length} entr(y/ies) · ${dataset.length} record(s) tracked`,
  );

  const counts = new Map<string, number>();
  for (const row of rows) {
    counts.set(row.verdict, (counts.get(row.verdict) ?? 0) + 1);
  }
  for (const verdict of [
    "tracked",
    "new",
    "rejected",
    "dead",
    "no-channel",
  ] as const) {
    const count = counts.get(verdict) ?? 0;
    if (count) console.log(`  ${verdict.padEnd(12)} ${count}`);
  }

  const fresh = rows.filter(
    (row) => row.verdict === "new" && row.channelId,
  );
  const deduped = new Map<string, Row>();
  for (const row of fresh) {
    if (!deduped.has(row.channelId!)) deduped.set(row.channelId!, row);
  }
  const newRows = [...deduped.values()];

  console.log(
    newRows.length +
      " channel(s) would be imported" +
      (newRows.length
        ? ":\n" +
          newRows
            .slice(0, 20)
            .map((row) => `  ${row.channelId}  ${row.entry.displayName}`)
            .join("\n")
        : ""),
  );

  if (!options.apply) {
    console.log("Nothing was written. Re-run with --apply.");
    return;
  }

  const now = new Date().toISOString();
  const agency: Record<string, string> = {};
  const debut: Record<string, string> = {};
  const activity: Record<string, Activity> = {};

  for (const row of newRows) {
    const entry = row.entry!;
    const id = row.channelId!;
    if (entry.agency) agency[id] = entry.agency;
    if (entry.addedDate) debut[id] = entry.addedDate;
    activity[id] = foldActivity(entry.status);
  }

  const ids = newRows.map((row) => row.channelId!).filter(Boolean);
  let added = 0;
  let existing = 0;
  let failed = 0;

  for (let offset = 0; offset < ids.length; offset += options.batchSize) {
    const batch = ids.slice(offset, offset + options.batchSize);
    const result = await importYouTubeChannels(batch, {
      limit: options.batchSize,
      rosterIds: new Set(ids),
      rosterHint: { agency, debut, activity },
      onLog: (message) => console.log("  " + message),
    });
    added += result.added.length;
    existing += result.existing;
    for (const f of result.failed) {
      console.error(`vtuber-db: ${f.id} failed — ${f.reason}`);
      failed++;
    }
    console.log(
      "import: " +
        Math.min(offset + options.batchSize, ids.length) +
        "/" +
        ids.length +
        " +" +
        result.added.length +
        " new · " +
        result.existing +
        " tracked · " +
        result.failed.length +
        " failed",
    );
  }

  const skippedDead = counts.get("dead") ?? 0;
  const skippedNoChannel = counts.get("no-channel") ?? 0;
  const skippedRejected = counts.get("rejected") ?? 0;

  console.log(
    `\n${added} channel(s) written · ${existing} already tracked · ${failed} failed · ${skippedDead} dead link(s) · ${skippedNoChannel} no channel · ${skippedRejected} rejected`,
  );
  if (added > 0) console.log("Run npm run data:index next.");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
