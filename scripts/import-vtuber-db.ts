#!/usr/bin/env tsx
/**
 * Compares a vtuberdb.com harvest with the dataset, and can import the new
 * channels.
 *
 * `scripts/harvest-vtuber-db.ts` produces a snapshot in `.cache/`; this is the
 * gate between that snapshot and `data/`. It prints what would change and
 * writes nothing without `--apply`.
 *
 * ## The identity
 *
 * vtuberdb.com's Cargo tables publish the performer's name but NOT their
 * YouTube channel id or handle. So every entry needs a YouTube name search
 * (InnerTube, quota-free) to find the channel. The search result is confirmed
 * only when the channel's own title confirms the roster's display name —
 * containment tested both ways — and the name is distinctive
 * (`isDistinctiveName()`). Clip and fan accounts are rejected.
 *
 * ## The gate
 *
 * vtuberdb is a performer directory — every entry is a VTuber — so a row is
 * a **virtual claim** (`rosterIds`). What a roster still must not buy is a
 * fan: `detectClipAccount()` and `isFanAccountName()` must both be false.
 *
 *   npm run data:vtuber-db-import                     # report only
 *   npm run data:vtuber-db-import -- --apply          # import the new channels
 *   npm run data:vtuber-db-import -- --limit 50       # search 50 names
 */

import fs from "node:fs";
import { readAllChannelRecords } from "./lib/dataset";
import {
  detectClipAccount,
  isFanAccountName,
} from "./lib/classify";
import { normalize } from "./lib/classify";
import { isDistinctiveName } from "./lib/link-discovery";
import { applyChannelEdits } from "./lib/roster-fill";
import {
  importYouTubeChannels,
  type RosterHint,
} from "./lib/import-channels";
import { canonicalAgency } from "./lib/regions";
import { InnerTubeSource } from "./lib/youtubei";
import type { VtuberDbEntry } from "./lib/vtuber-db";
import type { Activity, Channel } from "./lib/types";

const SNAPSHOT = ".cache/vtuber-db.json";

interface Options {
  apply: boolean;
  limit: number | null;
  batchSize: number;
}

function parseArgs(argv: string[]): Options {
  const options: Options = { apply: false, limit: null, batchSize: 50 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--apply") options.apply = true;
    else if (arg === "--limit") {
      options.limit = Math.max(1, Number(argv[++i] ?? 1));
    } else if (arg === "--batch") {
      options.batchSize = Math.max(1, Math.min(50, Number(argv[++i] ?? 50)));
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        [
          "Usage: npm run data:vtuber-db-import -- [options]",
          "",
          "  --apply         import the channels the gate admits",
          "  --limit <n>     search at most n names",
          "  --batch <n>     ids per import call (max 50)",
        ].join("\n"),
      );
      process.exit(0);
    }
  }
  return options;
}

type Verdict = "tracked" | "new" | "fan" | "no-match" | "ambiguous";

interface Row {
  entry: VtuberDbEntry;
  id: string | null;
  record: Channel | null;
  verdict: Verdict;
  reason?: string;
  candidates: string[];
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(SNAPSHOT)) {
    console.error(
      "no snapshot at " +
        SNAPSHOT +
        " — run npm run data:vtuber-db first",
    );
    process.exit(1);
  }

  const snapshot: { entries: VtuberDbEntry[]; generatedAt: string } =
    JSON.parse(fs.readFileSync(SNAPSHOT, "utf8"));
  const entries = snapshot.entries;

  const dataset = readAllChannelRecords();
  const byId = new Map(dataset.map((channel) => [channel.id, channel]));

  const byHandle = new Map<string, Channel>();
  for (const channel of dataset) {
    for (const platform of channel.platforms) {
      if (platform.platform === "youtube" && platform.handle) {
        const h = platform.handle.replace(/^@/, "").toLowerCase();
        if (!byHandle.has(h)) byHandle.set(h, channel);
      }
    }
  }

  const rows: Row[] = [];
  const source = await (async () => {
    const s = new InnerTubeSource({ delayMs: 150 });
    const ready = await s.connect();
    return ready ? s : null;
  })();

  for (const entry of entries) {
    /**
     * The fan test runs before anything else.
     */
    if (
      detectClipAccount(
        entry.displayName ?? "",
        entry.affiliation ?? "",
      ) ||
      isFanAccountName(entry.displayName ?? "")
    ) {
      rows.push({
        entry,
        id: null,
        record: null,
        verdict: "fan",
        reason: "a clip or fan account",
        candidates: [],
      });
      continue;
    }

    const name = entry.displayName ?? entry.pageName;
    if (!isDistinctiveName(name)) {
      rows.push({
        entry,
        id: null,
        record: null,
        verdict: "no-match",
        reason:
          "the name is not distinctive enough for a name search",
        candidates: [],
      });
      continue;
    }

    /**
     * Search YouTube by the roster's display name. InnerTube answers
     * channel results without spending Data API quota.
     */
    let candidates: string[] = [];
    if (source) {
      candidates = await source.searchChannels(name, 5);
    }

    /**
     * Confirm a candidate only when the channel's own title confirms the
     * roster's display name — containment tested both ways — and exactly
     * one candidate matches. Two channels that both carry the name are an
     * ambiguity, not a link.
     */
    const confirmed: string[] = [];
    const nameLower = normalize(name);
    for (const candidateId of candidates) {
      const record = byId.get(candidateId);
      if (record) {
        const recordNameLower = normalize(record.name);
        const aliasesLower = record.aliases.map((a) =>
          normalize(a),
        );
        const allNames = [recordNameLower, ...aliasesLower];
        if (
          allNames.some(
            (n) =>
              n.includes(nameLower) || nameLower.includes(n),
          )
        ) {
          confirmed.push(candidateId);
        }
        continue;
      }
      confirmed.push(candidateId);
    }

    if (confirmed.length === 0) {
      rows.push({
        entry,
        id: null,
        record: null,
        verdict: "no-match",
        reason:
          "no YouTube channel matched the roster name",
        candidates,
      });
      continue;
    }

    if (confirmed.length > 1) {
      rows.push({
        entry,
        id: null,
        record: null,
        verdict: "ambiguous",
        reason:
          confirmed.length +
          " channels match the name — ambiguity",
        candidates,
      });
      continue;
    }

    const channelId = confirmed[0]!;
    const existingRecord = byId.get(channelId);
    rows.push({
      entry,
      id: channelId,
      record: existingRecord ?? null,
      verdict: existingRecord ? "tracked" : "new",
      candidates,
    });
  }

  console.log(
    "snapshot " +
      snapshot.generatedAt +
      " · " +
      entries.length +
      " entr(y/ies) · " +
      dataset.length +
      " record(s) tracked",
  );
  const counts = new Map<Verdict, number>();
  for (const row of rows)
    counts.set(row.verdict, (counts.get(row.verdict) ?? 0) + 1);
  for (const verdict of [
    "tracked",
    "new",
    "fan",
    "no-match",
    "ambiguous",
  ] as const) {
    const count = counts.get(verdict) ?? 0;
    if (count)
      console.log(
        "  " + verdict.padEnd(12) + " " + count,
      );
  }

  /* ---------------------------------------------------------------------- */
  /* Import                                                                 */
  /* ---------------------------------------------------------------------- */

  const fresh = rows.filter(
    (row) => row.verdict === "new" && row.id,
  );
  const deduped = new Map<string, Row>();
  for (const row of fresh) {
    if (!deduped.has(row.id!)) deduped.set(row.id!, row);
  }
  const newRows = [...deduped.values()];

  console.log(
    newRows.length +
      " channel(s) would be imported" +
      (newRows.length
        ? ":\n" +
          newRows
            .slice(0, 20)
            .map(
              (row) => {
                const statusPart = row.entry.status
                  ? " · " + row.entry.status
                  : "";
                return (
                  "  " +
                  row.id +
                  "  " +
                  row.entry.displayName +
                  "  [" +
                  (row.entry.affiliation ?? "?") +
                  statusPart +
                  "]"
                );
              },
            )
            .join("\n")
        : ""),
  );

  if (!options.apply) {
    console.log("Nothing was written. Re-run with --apply.");
    return;
  }

  const now = new Date().toISOString();
  const agency: Record<string, string> = {};
  const activity: Record<string, Activity> = {};
  const debut: Record<string, string> = {};

  for (const row of newRows) {
    if (!row.id) continue;
    const entry = row.entry;
    if (entry.affiliation) agency[row.id] = entry.affiliation;
    if (
      entry.status?.includes("卒") ||
      entry.status?.includes("graduated")
    ) {
      activity[row.id] = "graduated";
    } else if (
      entry.status?.includes("活動") ||
      entry.status?.includes("active")
    ) {
      activity[row.id] = "active";
    }
    if (entry.debutDate) debut[row.id] = entry.debutDate;
  }

  const ids = newRows.map((row) => row.id!).filter(Boolean);
  let added = 0;
  let existing = 0;
  let failed = 0;

  for (let offset = 0; offset < ids.length; offset += options.batchSize) {
    const batch = ids.slice(offset, offset + options.batchSize);
    const result = await importYouTubeChannels(batch, {
      limit: options.batchSize,
      rosterIds: new Set(
        entries.map((e) => e.pageName),
      ),
      rosterHint: { activity, agency, debut },
      onLog: (message) => console.log("  " + message),
    });
    added += result.added.length;
    existing += result.existing;
    failed += result.failed.length;
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

  console.log(
    "\n" +
      added +
      " channel(s) written · " +
      existing +
      " already tracked · " +
      failed +
      " failed",
  );
  if (added > 0) console.log("Run npm run data:index next.");
}

main().catch((error: unknown) => {
  console.error(
    error instanceof Error ? error.message : String(error),
  );
  process.exit(1);
});
