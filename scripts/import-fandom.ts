#!/usr/bin/env tsx
/**
 * Compares a fandom wiki harvest with the dataset, and can import the new
 * channels and attach the links the roster publishes.
 *
 * `scripts/harvest-fandom.ts` produces a snapshot in `.cache/`; this is the
 * gate between that snapshot and `data/`. It prints what would change and
 * writes nothing without `--apply`.
 *
 * ## The identity
 *
 * The wiki publishes a YouTube `channel/UC…` URL or a `@handle` for most
 * entries. A `UC…` id is matched directly against the dataset; a `@handle`
 * costs one InnerTube `resolve_url` call. Answers are cached in
 * `.cache/fandom-resolved.json` so a second run does not repeat the work.
 *
 * ## The gate
 *
 * The wiki is a performer directory — every entry with a `{{Character}}`
 * infobox is a virtual performer — so a row is a **virtual claim**
 * (`rosterIds`), and the region, the name and the role stay the profile's and
 * the classifier's. What a roster still must not buy is a fan:
 * `detectClipAccount()` and `isFanAccountName()` must both be false.
 *
 * ## The links
 *
 * The wiki files the performer's X/Twitter handle beside the YouTube channel,
 * and a record this catalogue already tracks is usually missing exactly
 * that. `--links` reports the handles that can be added to the `externals`,
 * and `--links --apply` writes them. Nothing is overwritten.
 *
 *   npm run data:fandom-import                     # report only
 *   npm run data:fandom-import -- --apply          # import the new channels
 *   npm run data:fandom-import -- --links          # report the attachable links
 *   npm run data:fandom-import -- --links --apply  # attach them
 */

import fs from "node:fs";
import { readAllChannelRecords } from "./lib/dataset";
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
import { canonicalAgency } from "./lib/regions";
import { extractExternalLinks } from "./lib/twitch";
import { InnerTubeSource } from "./lib/youtubei";
import type { FandomVtuber } from "./lib/fandom";
import type { Activity, Channel, Gender } from "./lib/types";

const SNAPSHOT = ".cache/fandom/fandom.json";
const RESOLVED = ".cache/fandom-resolved.json";
const PAGES_DIR = ".cache/fandom/pages";

/**
 * The entries on disk while a harvest is still running.
 */
function readPages(): FandomVtuber[] {
  let files: string[] = [];
  try {
    files = fs.readdirSync(PAGES_DIR).filter((file) => file.endsWith(".json"));
  } catch {
    return [];
  }
  const entries: FandomVtuber[] = [];
  for (const file of files) {
    try {
      const entry = JSON.parse(
        fs.readFileSync(`${PAGES_DIR}/${file}`, "utf8"),
      ) as FandomVtuber;
      if (entry?.name) entries.push(entry);
    } catch {
      /* A half-written page is rewritten by the next pass. */
    }
  }
  return entries.sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));
}

interface ResolvedCache {
  [handle: string]: { id: string | null; at: string };
}

function readResolved(): ResolvedCache {
  try {
    return JSON.parse(fs.readFileSync(RESOLVED, "utf8")) as ResolvedCache;
  } catch {
    return {};
  }
}

function writeResolved(cache: ResolvedCache): void {
  fs.writeFileSync(RESOLVED, JSON.stringify(cache, null, 0));
}

interface LinkPlan {
  channel: Channel;
  name: string;
  fields: Record<string, string>;
}

interface Options {
  apply: boolean;
  links: boolean;
  limit: number | null;
  batchSize: number;
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    apply: false,
    links: false,
    limit: null,
    batchSize: 50,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--apply") options.apply = true;
    else if (arg === "--links") options.links = true;
    else if (arg === "--limit") {
      options.limit = Math.max(1, Number(argv[++i] ?? 1));
    } else if (arg === "--batch") {
      options.batchSize = Math.max(1, Math.min(50, Number(argv[++i] ?? 50)));
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        [
          "Usage: npm run data:fandom-import -- [options]",
          "",
          "  --apply         import the channels the gate admits",
          "  --links         attach X (Twitter) handles to tracked records",
          "  --limit <n>     import at most n channels",
          "  --batch <n>     ids per import call (max 50)",
        ].join("\n"),
      );
      process.exit(0);
    }
  }
  return options;
}

type Verdict = "tracked" | "new" | "fan" | "no-youtube" | "unresolved";

interface Row {
  entry: FandomVtuber;
  id: string | null;
  record: Channel | null;
  verdict: Verdict;
  reason?: string;
}

function foldHandle(handle: string): string {
  return handle
    .trim()
    .replace(/^@+/, "")
    .replace(/^https?:\/\/(?:www\.)?(?:youtube\.com\/)?/i, "")
    .replace(/^(?:channel|user|c)\//i, "")
    .replace(/[/?#].*$/, "")
    .toLowerCase();
}

function handlesOf(record: Channel): string[] {
  const handles: string[] = [];
  const push = (value: string | null | undefined) => {
    if (!value) return;
    const folded = foldHandle(value);
    if (folded && !handles.includes(folded)) handles.push(folded);
  };
  push(record.handle);
  for (const platform of record.platforms) {
    if (platform.platform === "youtube" && platform.handle)
      push(platform.handle);
  }
  return handles;
}

/** One InnerTube client for the whole pass, connected once. */
let sourcePromise: Promise<InnerTubeSource | null> | null = null;
async function innertube(): Promise<InnerTubeSource | null> {
  if (!sourcePromise) {
    sourcePromise = (async () => {
      const source = new InnerTubeSource({ delayMs: 150 });
      const ready = await source.connect();
      return ready ? source : null;
    })();
  }
  return sourcePromise;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(SNAPSHOT)) {
    console.error(
      "no snapshot at " +
        SNAPSHOT +
        " — run npm run data:fandom first",
    );
    process.exit(1);
  }

  const snapshot: { vtubers: FandomVtuber[]; generatedAt: string } =
    JSON.parse(fs.readFileSync(SNAPSHOT, "utf8"));
  const entries = snapshot.vtubers;

  const dataset = readAllChannelRecords();
  const byId = new Map(dataset.map((channel) => [channel.id, channel]));

  const byHandle = new Map<string, Channel>();
  for (const channel of dataset) {
    for (const handle of handlesOf(channel)) {
      if (!byHandle.has(handle)) byHandle.set(handle, channel);
    }
  }

  const rows: Row[] = [];
  for (const entry of entries) {
    /**
     * The fan test runs before anything else.
     */
    if (
      detectClipAccount(entry.name ?? "", entry.socialMedia ?? "") ||
      isFanAccountName(entry.name ?? "")
    ) {
      rows.push({
        entry,
        id: null,
        record: null,
        verdict: "fan",
        reason: "a clip or fan account",
      });
      continue;
    }

    let record: Channel | null = null;
    if (entry.youtubeId) {
      record = byId.get(entry.youtubeId) ?? null;
    }
    if (!record && entry.youtubeHandle) {
      record = byHandle.get(foldHandle(entry.youtubeHandle)) ?? null;
    }
    if (!record && entry.xHandle) {
      record = byHandle.get(foldHandle(entry.xHandle)) ?? null;
    }

    rows.push({
      entry,
      id: record?.id ?? entry.youtubeId ?? null,
      record,
      verdict: record ? "tracked" : "new",
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
    "no-youtube",
    "unresolved",
  ] as const) {
    const count = counts.get(verdict) ?? 0;
    if (count)
      console.log(
        "  " + verdict.padEnd(12) + " " + count,
      );
  }

  /* ---------------------------------------------------------------------- */
  /* Links                                                                  */
  /* ---------------------------------------------------------------------- */

  if (options.links) {
    const plans: LinkPlan[] = [];
    for (const row of rows) {
      if (row.verdict !== "tracked" || !row.record) continue;
      const channel = row.record;
      const fields: Record<string, string> = {};
      const xh = entryXHandle(row.entry);
      if (xh && !channel.externals?.["twitter"]) {
        fields["twitter"] = xh;
      }
      if (Object.keys(fields).length)
        plans.push({ channel, name: row.entry.name!, fields });
    }

    let totalHandles = 0;
    for (const plan of plans)
      totalHandles += Object.keys(plan.fields).length;
    console.log(
      "links: " +
        plans.length +
        " tracked record(s) can take " +
        totalHandles +
        " handle(s)",
    );
    for (const plan of plans.slice(0, 10)) {
      console.log(
        "  " +
          plan.name +
          " → " +
          Object.entries(plan.fields)
            .map(([key, handle]) => key + ":" + handle)
            .join(", "),
      );
    }
    if (plans.length > 10) console.log("  … " + (plans.length - 10) + " more");

    if (!options.apply) {
      console.log(
        "Nothing was written. Re-run with --links --apply.",
      );
      return;
    }

    const written = applyChannelEdits(
      plans.map((plan) => ({
        id: plan.channel.id,
        update: (channel: Channel) => {
          channel.externals = { ...(channel.externals ?? {}) };
          let touched = false;
          for (const [key, handle] of Object.entries(plan.fields)) {
            if (channel.externals[key]) continue;
            channel.externals[key] = handle;
            touched = true;
          }
          return touched;
        },
      })),
      "fandom-links",
      new Date().toISOString(),
    );
    console.log(
      written + " record(s) had their externals filled from fandom",
    );
    return;
  }

  /* ---------------------------------------------------------------------- */
  /* Import                                                                 */
  /* ---------------------------------------------------------------------- */

  const unresolved = rows.filter(
    (row) => row.verdict === "new" && row.id,
  );
  /**
   * Rows with only a YouTube @handle need InnerTube resolution to find the
   * UC… id before they can be imported.
   */
  const handleOnly = rows.filter(
    (row) =>
      row.verdict === "new" &&
      !row.id &&
      row.entry.youtubeHandle &&
      !byId.get(foldHandle(row.entry.youtubeHandle)),
  );

  if (handleOnly.length > 0) {
    const cache = readResolved();
    const source = await innertube();
    if (!source) {
      console.error(
        "InnerTube is unavailable — handles cannot be resolved",
      );
    } else {
      let resolved = 0;
      let dead = 0;
      for (const row of handleOnly) {
        const handle = row.entry.youtubeHandle!;
        const key = foldHandle(handle);
        const cached = cache[key];
        let id: string | null = null;
        if (
          cached &&
          (cached.id ||
            Date.now() - Date.parse(cached.at) <
              7 * 24 * 60 * 60 * 1000)
        ) {
          id = cached.id;
        } else {
          id = await source.resolveHandle(key);
          cache[key] = { id, at: new Date().toISOString() };
        }
        if (!id) {
          dead++;
          row.verdict = "unresolved";
          row.reason = "the handle did not resolve to a channel";
        } else {
          row.id = id;
          row.record = byId.get(id) ?? null;
          row.verdict = row.record ? "tracked" : "new";
          resolved++;
        }
      }
      writeResolved(cache);
      console.log(
        "  resolve: " +
          resolved +
          " resolved · " +
          dead +
          " dead",
      );
    }
  }

  const resolveLimit = options.limit ?? unresolved.length;
  const queue = unresolved.slice(0, resolveLimit);

  if (queue.length > 0) {
    const cache = readResolved();
    const source = await innertube();
    if (!source) {
      console.error(
        "InnerTube is unavailable — handles cannot be resolved",
      );
    } else {
      let resolved = 0;
      let dead = 0;
      for (const [index, row] of queue.entries()) {
        const entry = row.entry;
        const handle = entry.youtubeHandle;
        if (!handle) continue;
        const key = foldHandle(handle);
        const cached = cache[key];
        let id: string | null = null;
        if (
          cached &&
          (cached.id ||
            Date.now() - Date.parse(cached.at) <
              7 * 24 * 60 * 60 * 1000)
        ) {
          id = cached.id;
        } else {
          id = await source.resolveHandle(key);
          cache[key] = { id, at: new Date().toISOString() };
        }
        if ((index + 1) % 25 === 0) {
          writeResolved(cache);
          console.log(
            "  resolve: " +
              (index + 1) +
              "/" +
              queue.length +
              " · " +
              resolved +
              " resolved · " +
              dead +
              " dead",
          );
        }
        if (!id) {
          dead++;
          row.verdict = "unresolved";
          row.reason = "the handle did not resolve to a channel";
        } else {
          row.id = id;
          row.record = byId.get(id) ?? null;
          row.verdict = row.record ? "tracked" : "new";
          resolved++;
        }
      }
      writeResolved(cache);
      console.log(
        "  resolve: " +
          resolved +
          " of " +
          queue.length +
          " resolved to a channel id, " +
          dead +
          " dead",
      );
    }
  }

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
                const statusPart = row.entry.graduateDate
                  ? " · graduated"
                  : "";
                return (
                  "  " +
                  row.id +
                  "  " +
                  row.entry.name +
                  "  [" +
                  row.entry.affiliation +
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
    if (entry.graduateDate) activity[row.id] = "graduated";
    else if (entry.debutDate) activity[row.id] = "active";
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
        entries
          .map((e) => e.youtubeId)
          .filter((id): id is string => id !== null),
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

function entryXHandle(entry: FandomVtuber): string | null {
  return entry.xHandle ?? null;
}

main().catch((error: unknown) => {
  console.error(
    error instanceof Error ? error.message : String(error),
  );
  process.exit(1);
});
