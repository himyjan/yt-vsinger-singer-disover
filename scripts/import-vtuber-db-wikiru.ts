#!/usr/bin/env tsx
/**
 * Compares a vtuber-database.wikiru.jp harvest with the dataset and imports
 * new channels.
 *
 * `scripts/harvest-vtuber-db-wikiru.ts` produces a snapshot in `.cache/`;
 * this script reads that snapshot, resolves each performer's name to a
 * YouTube channel via an InnerTube search (no Data API quota), confirms the
 * match, and imports the ones that pass the gate into `data/channels/`.
 *
 *   npm run data:vtuber-db-wikiru-import                     # report only
 *   npm run data:vtuber-db-wikiru-import -- --apply          # import the new channels
 *   npm run data:vtuber-db-wikiru-import -- --limit 50       # resolve at most 50 names
 *
 * vtuber-database.wikiru.jp publishes a performer name but NOT a YouTube
 * channel id, so each admitted entry is resolved by searching YouTube for the
 * roster's display name. A candidate is confirmed only when the channel's own
 * title confirms the name — containment tested both ways — and exactly one
 * channel matches. The record is then keyed by the `UC…` channel id (a record
 * that has its own YouTube channel is keyed by it).
 *
 * Entries that resolve to a channel are added as `youtube:<channelId>`
 * records; entries that resolve to none or to several channels are reported
 * as `no-match`/`ambiguous` and are not imported. Every entry is a virtual
 * claim (`reincarnationOf`-eligible). What a roster still must not buy is a
 * fan: `detectClipAccount()` and `isFanAccountName()` must both be false.
 */

import fs from "node:fs";
import path from "node:path";
import {
  detectClipAccount,
  isFanAccountName,
  classifyChannel,
  normalize,
} from "../scripts/lib/classify";
import { isDistinctiveName } from "../scripts/lib/link-discovery";
import {
  importYouTubeChannels,
  type RosterHint,
} from "../scripts/lib/import-channels";
import { readAllChannelRecords } from "../scripts/lib/dataset";
import { InnerTubeSource } from "../scripts/lib/youtubei";
import { acquireRunLock } from "../scripts/lib/io";
import type { Activity, Channel, RegionCode } from "../scripts/lib/types";

function log(message: string): void {
  process.stdout.write(message + "\n");
}

function logErr(message: string): void {
  process.stderr.write(message + "\n");
}

const SNAPSHOT = ".cache/vtuber-db-wikiru/vtuber-db-wikiru.json";

interface VtuberDbWikiruEntry {
  name: string;
  pageName: string | null;
  gender: string | null;
  affiliation: string | null;
  group: string | null;
  unit: string | null;
  activity: string | null;
  subscribers: string | null;
  debutDate: string | null;
}

type Verdict = "tracked" | "new" | "rejected" | "no-match" | "ambiguous";

interface Row {
  entry: VtuberDbWikiruEntry;
  id: string | null;
  record: Channel | null | undefined;
  verdict: Verdict;
  reason?: string;
  candidates: string[];
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
        log(
          [
            "Usage: npm run data:vtuber-db-wikiru-import -- [options]",
            "",
            "  --apply         import the channels the gate admits",
            "  --limit <n>     resolve at most n names",
            "  --batch <n>     ids per import call (max 50)",
          ].join("\n")
        );
        process.exit(0);
      default:
        if (arg.startsWith("-")) {
          logErr(`unknown option: ${arg}`);
          process.exit(1);
        }
    }
  }
  return options;
}

function foldRegion(value: string | null): RegionCode | null {
  if (!value) return null;
  const v = value.trim().toLowerCase();
  const map: Record<string, RegionCode> = {
    jp: "jp", japan: "jp",
    cn: "cn", china: "cn",
    kr: "kr", korea: "kr",
    en: "en", us: "en", uk: "en",
    tw: "tw", hk: "hk",
    id: "id", sea: "sea",
  };
  return map[v] ?? null;
}

/** The wiki's free-text affiliation is not a controlled vocabulary. */
function foldAffiliation(
  value: string | null,
): "independent" | "group" | "unknown" {
  if (!value) return "unknown";
  return value.trim().includes("個人勢") ? "independent" : "group";
}

/** The wiki's free-text activity is not a controlled vocabulary. */
function foldActivity(value: string | null): Activity {
  if (!value) return "unknown";
  return value.trim() === "卒業" ? "graduated" : "unknown";
}

/** Search YouTube for the roster name and confirm exactly one channel matches. */
async function resolveChannel(
  source: InnerTubeSource | null,
  entry: VtuberDbWikiruEntry,
  byId: Map<string, Channel>,
): Promise<{
  id: string | null;
  verdict: Verdict;
  record: Channel | null | undefined;
  reason?: string;
  candidates: string[];
}> {
  const name = entry.name;
  if (!isDistinctiveName(name)) {
    return {
      id: null,
      verdict: "no-match",
      record: null,
      reason: "the name is not distinctive enough for a name search",
      candidates: [],
    };
  }

  if (!source) {
    return {
      id: null,
      verdict: "no-match",
      record: null,
      reason: "InnerTube unavailable — cannot resolve the name",
      candidates: [],
    };
  }

  const candidates = await source.searchChannels(name, 5);

  /**
   * Confirm a candidate only when the channel's own title confirms the
   * roster's display name — containment tested both ways. Fetch the profile
   * so we compare against the channel's real title, not a guess.
   */
  const nameLower = normalize(name);
  const confirmed: string[] = [];
  for (const candidateId of candidates) {
    const record = byId.get(candidateId);
    if (record) {
      const recordNameLower = normalize(record.name);
      const aliasesLower = record.aliases.map((a) => normalize(a));
      const allNames = [recordNameLower, ...aliasesLower];
      if (
        allNames.some(
          (n) => n.includes(nameLower) || nameLower.includes(n),
        )
      ) {
        confirmed.push(candidateId);
      }
      continue;
    }
    let profileResolved = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const profile = await source.profile(candidateId, { lang: "en" });
        const title = normalize(profile?.title ?? "");
        if (
          title &&
          (title.includes(nameLower) || nameLower.includes(title))
        ) {
          confirmed.push(candidateId);
          profileResolved = true;
          break;
        }
      } catch {
        // Retry on transient failures
        if (attempt < 2) {
          await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
        }
      }
    }
    if (!profileResolved) {
      logErr(
        `resolveChannel: profile fetch failed for ${candidateId} after 3 attempts — skipping`,
      );
    }
  }

  if (confirmed.length === 0) {
    return {
      id: null,
      verdict: "no-match",
      record: null,
      reason: "no YouTube channel matched the roster name",
      candidates,
    };
  }
  if (confirmed.length > 1) {
    return {
      id: null,
      verdict: "ambiguous",
      record: null,
      reason: confirmed.length + " channels match the name — ambiguity",
      candidates,
    };
  }

  const channelId = confirmed[0]!;
  const existingRecord = byId.get(channelId);
  return {
    id: channelId,
    verdict: existingRecord ? "tracked" : "new",
    record: existingRecord ?? null,
    candidates,
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(SNAPSHOT)) {
    logErr(
      `no snapshot at ${SNAPSHOT} — run npm run data:vtuber-db-wikiru first`,
    );
    process.exit(1);
  }

  const snapshot: {
    entries?: VtuberDbWikiruEntry[];
    generatedAt: string;
  } = JSON.parse(fs.readFileSync(SNAPSHOT, "utf8"));
  const entries = snapshot.entries || [];

  const dataset = readAllChannelRecords();
  const byId = new Map(dataset.map((c) => [c.id, c]));

  const rows: Row[] = [];
  const source = await (async () => {
    const s = new InnerTubeSource({ delayMs: 150 });
    const ready = await s.connect();
    return ready ? s : null;
  })();

  const limit = options.limit ?? entries.length;
  const toResolve = entries.slice(0, limit);

  for (let i = 0; i < toResolve.length; i++) {
    const entry = toResolve[i]!;

    // Skip fan / clip accounts before anything else.
    if (
      detectClipAccount(entry.name ?? "", entry.affiliation ?? "") ||
      isFanAccountName(entry.name ?? "")
    ) {
      rows.push({
        entry,
        id: null,
        record: null,
        verdict: "rejected",
        reason: "a clip or fan account",
        candidates: [],
      });
      continue;
    }

    const resolved = await resolveChannel(source, entry, byId);
    rows.push({
      entry,
      id: resolved.id,
      record: resolved.record,
      verdict: resolved.verdict,
      reason: resolved.reason,
      candidates: resolved.candidates,
    });

    // Per-channel progress with flush so it shows live during the run
    process.stdout.write(
      `\r[${i + 1}/${toResolve.length}] ${entry.name} → ${resolved.verdict}${resolved.reason ? ` (${resolved.reason})` : ""}        `,
    );
  }
  log(''); // newline after progress line
  log(
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
    "no-match",
    "ambiguous",
  ] as const) {
    const count = counts.get(verdict) ?? 0;
    if (count) log(`  ${verdict.padEnd(12)} ${count}`);
  }

  const fresh = rows.filter((row) => row.verdict === "new" && row.id);
  const deduped = new Map<string, Row>();
  for (const row of fresh) {
    if (!deduped.has(row.id!)) deduped.set(row.id!, row);
  }
  const newRows = [...deduped.values()];

  log(
    newRows.length +
      " channel(s) would be imported" +
      (newRows.length
        ? ":\n" +
          newRows
            .slice(0, 20)
            .map(
              (row) =>
                `  ${row.id}  ${row.entry.name}` +
                (row.reason ? `  (${row.reason})` : ""),
            )
            .join("\n")
        : ""),
  );

  if (!options.apply) {
    log("Nothing was written. Re-run with --apply.");
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
    activity[row.id] = foldActivity(entry.activity);
    if (entry.debutDate) debut[row.id] = entry.debutDate;
  }

  const ids = newRows.map((row) => row.id!).filter(Boolean);
  let added = 0;
  let existing = 0;
  let failed = 0;
  let skippedNoMatch = 0;
  let skippedAmbiguous = 0;

  for (let offset = 0; offset < ids.length; offset += options.batchSize) {
    const batch = ids.slice(offset, offset + options.batchSize);
    const result = await importYouTubeChannels(batch, {
      limit: options.batchSize,
      rosterHint: { activity, agency, debut },
      onLog: (message) => log("  " + message),
    });
    added += result.added.length;
    existing += result.existing;
    for (const f of result.failed) {
      logErr(
        `vtuber-db-wikiru: ${f.id} failed — ${f.reason}`,
      );
      failed++;
    }
    log(
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

  for (const row of rows) {
    if (row.verdict === "no-match") skippedNoMatch++;
    if (row.verdict === "ambiguous") skippedAmbiguous++;
  }

  log(
    `\n${added} channel(s) written · ${existing} already tracked · ${failed} failed · ${skippedNoMatch} no-match · ${skippedAmbiguous} ambiguous`,
  );
  if (added > 0) {
    log("Run npm run data:index next.");
    }
}

main().catch((error: unknown) => {
  logErr(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
