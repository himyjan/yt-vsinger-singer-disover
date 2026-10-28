#!/usr/bin/env tsx
/**
 * Compares a bacharu harvest with the dataset, and can import the channels
 * it has a **channel id** for.
 *
 * `scripts/harvest-bacharu.ts` produces a roster in `.cache/`; this is the
 * gate between that roster and `data/`. It writes nothing without `--apply`.
 *
 * bacharu is a **roster**, so the question it answers is the same one the
 * vTubie groups answer: is this account a performer? It is not a singing
 * test — the dataset tracks VTubers who stream variety, and only 1,206 of the
 * virtual records set `isSinging`.
 *
 *   - bacharu classifies every entry `vtuber`, which is the roster's own
 *     claim of a virtual identity;
 *   - `detectClipAccount()` and `isFanAccountName()` must both be false, since
 *     a clip channel happily calls itself a VTuber while duplicating the
 *     performer it clips;
 *   - a row with no `UC…` id and no `@handle` has no key and is reported;
 *   - a row with only an `@handle` is a **candidate**: it needs one InnerTube
 *     resolution before it can be imported, so it is kept out of the default
 *     run and reported separately;
 *   - two rows pointing at the same channel are one channel: the first wins
 *     and the rest are reported as duplicates.
 *
 * The write path is the one every import uses, `importYouTubeChannels()`: the
 * roster supplies the **candidate id**, and the resulting record is built from
 * the platform's own profile — name, description, avatar, country — because
 * `AGENTS.md` rule 2 makes the platform the source of truth for a name. A
 * roster whose idea of the name disagrees with the channel is **counted** —
 * a stylised roster name is normal, a genuinely unrelated one is a wrong id —
 * and reported at the end for review.
 *
 *   npm run data:bacharu-import                # report only
 *   npm run data:bacharu-import -- --limit 100 # report 100 rows
 *   npm run data:bacharu-import -- --apply     # import, 50 at a time
 *   npm run data:bacharu-import -- --apply --resolve-handles --limit 200
 */

import fs from "node:fs";
import { readAllChannelRecords } from "./lib/dataset";
import { detectClipAccount, isFanAccountName, normalize } from "./lib/classify";
import { importYouTubeChannels } from "./lib/import-channels";
import { InnerTubeSource } from "./lib/youtubei";
import { namesAgree } from "./lib/bacharu";
import type { BacharuVtuber } from "./lib/bacharu";

/* -------------------------------------------------------------------------- */
/* Snapshot                                                                   */
/* -------------------------------------------------------------------------- */

interface Snapshot {
  generatedAt: string;
  source: string;
  roster: { total: number | null; totalPages: number | null; pagesRead: number };
  counts: Record<string, number>;
  vtubers: BacharuVtuber[];
}

/* -------------------------------------------------------------------------- */
/* Verdicts                                                                   */
/* -------------------------------------------------------------------------- */

type Verdict =
  /** Not in the dataset, has a channel id, passes the gate — `--apply` writes it. */
  | "new"
  /** The channel id is already in the dataset. */
  | "tracked"
  /** The `@handle` belongs to a record that is already tracked. */
  | "tracked-handle"
  /** Only an `@handle`: one InnerTube resolution away (`--resolve-handles`). */
  | "handle-only"
  /** No YouTube link at all, so there is no key to import under. */
  | "no-youtube"
  /** A clip, re-upload or translation account — a duplicate of a performer. */
  | "fan"
  /** Two roster rows point at the same channel. */
  | "duplicate"
  /** The roster has merged this row into another record. */
  | "redirect"
  /** A record with this name exists without a YouTube link — attach, don't add. */
  | "name-collision"
  /** The roster hides the row. */
  | "hidden";

interface Row {
  id: string;
  name: string;
  youtubeId: string | null;
  handle: string | null;
  groups: string[];
  status: string | null;
  countries: string[];
  verdict: Verdict;
  reason: string | null;
}

interface Lookup {
  /** Every id the dataset is keyed by, on every platform. */
  ids: Set<string>;
  /** YouTube handles the dataset already knows, lower-cased without `@`. */
  handles: Set<string>;
  /** Names of records with **no** YouTube link, for the collision test. */
  namesWithoutYouTube: Map<string, string>;
}

function buildLookup(): Lookup {
  const records = readAllChannelRecords();
  const ids = new Set<string>();
  const handles = new Set<string>();
  const namesWithoutYouTube = new Map<string, string>();

  for (const record of records) {
    ids.add(record.id);
    for (const platform of record.platforms) {
      ids.add(platform.id);
      if (platform.platform === "youtube" && platform.handle) {
        handles.add(platform.handle.replace(/^@/, "").toLowerCase());
      }
    }
    if (record.platforms.some((platform) => platform.platform === "youtube")) continue;
    for (const name of [record.name, ...record.aliases]) {
      const key = normalize(name);
      if (key && !namesWithoutYouTube.has(key)) namesWithoutYouTube.set(key, record.id);
    }
  }

  return { ids, handles, namesWithoutYouTube };
}

function judge(entry: BacharuVtuber, lookup: Lookup, seenIds: Set<string>): Row {
  const base = {
    id: entry.id,
    name: entry.name ?? entry.canonicalName ?? entry.id,
    youtubeId: entry.youtubeId,
    handle: entry.youtubeHandle,
    groups: entry.groups.map((group) => group.name),
    status: entry.status,
    countries: entry.countries,
  };

  if (entry.redirectTo) {
    return { ...base, verdict: "redirect", reason: `merged into ${entry.redirectTo}` };
  }
  if (entry.visibility && entry.visibility !== "public") {
    return { ...base, verdict: "hidden", reason: `visibility: ${entry.visibility}` };
  }

  /**
   * The fan test comes first: a clip channel that points at the performer's
   * channel is still a clip channel, and importing it would double a record.
   */
  if (isFanAccountName(base.name)) {
    return { ...base, verdict: "fan", reason: "the name is a fan or clip account" };
  }
  if (detectClipAccount(base.name, entry.description)) {
    return { ...base, verdict: "fan", reason: "the description says it is a clip account" };
  }

  if (entry.youtubeId) {
    if (lookup.ids.has(entry.youtubeId)) {
      return { ...base, verdict: "tracked", reason: null };
    }
    if (seenIds.has(entry.youtubeId)) {
      return { ...base, verdict: "duplicate", reason: "another row points at the same channel" };
    }
    const collision = lookup.namesWithoutYouTube.get(normalize(base.name));
    if (collision) {
      return {
        ...base,
        verdict: "name-collision",
        reason: `${base.name} is already tracked as ${collision} — attach the channel there`,
      };
    }
    seenIds.add(entry.youtubeId);
    return { ...base, verdict: "new", reason: null };
  }

  if (entry.youtubeHandle) {
    const handle = entry.youtubeHandle.toLowerCase();
    if (lookup.handles.has(handle)) {
      return { ...base, verdict: "tracked-handle", reason: null };
    }
    return { ...base, verdict: "handle-only", reason: "only an @handle — resolve it first" };
  }

  return { ...base, verdict: "no-youtube", reason: "no YouTube channel on the roster" };
}

/* -------------------------------------------------------------------------- */
/* Options                                                                    */
/* -------------------------------------------------------------------------- */

interface Options {
  apply: boolean;
  limit: number | null;
  snapshotPath: string;
  batchSize: number;
  resolveHandles: number;
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    apply: false,
    limit: null,
    snapshotPath: ".cache/bacharu-vtubers.json",
    batchSize: 50,
    resolveHandles: 0,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    switch (arg) {
      case "--apply":
        options.apply = true;
        break;
      case "--limit":
        options.limit = Math.max(1, Number(argv[i + 1] ?? 1));
        i++;
        break;
      case "--snapshot":
        options.snapshotPath = argv[i + 1] ?? options.snapshotPath;
        i++;
        break;
      case "--batch":
        options.batchSize = Math.max(1, Math.min(50, Number(argv[i + 1] ?? 50)));
        i++;
        break;
      case "--resolve-handles":
        options.resolveHandles = Math.max(1, Number(argv[i + 1] ?? 1));
        i++;
        break;
      case "--help":
      case "-h":
        console.log(
          [
            "Usage: npm run data:bacharu-import -- [options]",
            "",
            "  --apply              write the channels the gate admits",
            "  --limit <n>          look at the first n rows only",
            "  --batch <n>          ids per import call, max 50 (default 50)",
            "  --snapshot <path>    the harvest to read (default .cache/bacharu-vtubers.json)",
            "  --resolve-handles <n>  resolve up to n @handles to channel ids, then import them",
          ].join("\n"),
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

/* -------------------------------------------------------------------------- */

/**
 * Resolves `@handle`s to channel ids in order, a few at a time.
 *
 * The limiter inside `InnerTubeSource` already paces the requests; the
 * concurrency here only lets a slow answer overlap the next one.
 */
async function resolveHandles(
  source: InnerTubeSource,
  handles: { id: string; name: string; handle: string }[],
  log: (message: string) => void,
): Promise<Map<string, string>> {
  const resolved = new Map<string, string>();
  for (const [index, entry] of handles.entries()) {
    const id = await source.resolveHandle(entry.handle);
    if (id) resolved.set(entry.id, id);
    if ((index + 1) % 25 === 0) {
      log(`resolve: ${index + 1}/${handles.length} · ${resolved.size} resolved`);
    }
  }
  log(`resolve: ${resolved.size} of ${handles.length} handles resolved to a channel id`);
  return resolved;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  if (!fs.existsSync(options.snapshotPath)) {
    console.error(
      `no snapshot at ${options.snapshotPath} — run \`npm run data:bacharu\` first`,
    );
    process.exit(1);
  }
  const snapshot = JSON.parse(fs.readFileSync(options.snapshotPath, "utf8")) as Snapshot;

  const lookup = buildLookup();
  const seenIds = new Set<string>();
  const rows = snapshot.vtubers.map((entry) => judge(entry, lookup, seenIds));

  const counts = new Map<Verdict, number>();
  for (const row of rows) counts.set(row.verdict, (counts.get(row.verdict) ?? 0) + 1);

  console.log(
    `snapshot ${snapshot.generatedAt} · ${snapshot.vtubers.length} vtuber(s) · ` +
      `${snapshot.roster.total ?? "?"} on the roster`,
  );
  for (const verdict of [
    "new",
    "tracked",
    "tracked-handle",
    "handle-only",
    "no-youtube",
    "duplicate",
    "fan",
    "redirect",
    "name-collision",
    "hidden",
  ] as const) {
    const count = counts.get(verdict) ?? 0;
    if (count) console.log(`  ${verdict.padEnd(15)} ${count}`);
  }

  /* --- what the gate rejected, so a person can look --------------------- */
  for (const verdict of ["fan", "duplicate", "name-collision"] as const) {
    const rejected = rows.filter((row) => row.verdict === verdict);
    if (!rejected.length) continue;
    console.log(`\n${verdict} (${rejected.length}):`);
    for (const row of rejected.slice(0, 20)) {
      console.log(
        `  ${row.name} — ${row.reason}` +
          (row.groups.length ? ` · ${row.groups.slice(0, 2).join(", ")}` : ""),
      );
    }
    if (rejected.length > 20) console.log(`  … ${rejected.length - 20} more`);
  }

  /**
   * The ids this run imports are collected **after** the report, because
   * `--resolve-handles` adds the ones only the handle named. `--limit` caps
   * that collection — it used to cap the fresh list here, which meant
   * `--limit 150 --resolve-handles 150` resolved a hundred and fifty handles
   * and then imported nothing at all.
   */
  const fresh = rows.filter((row) => row.verdict === "new");
  const ids: string[] = [];

  /**
   * What the roster calls each channel, kept for the **report**. The import
   * itself does not reject on it: a roster writes `0sito_08` where the channel
   * writes `Osito_08`, and refusing those would lose a fifth of the roster.
   * A name that shares almost nothing with the platform's title is worth a
   * look all the same — `Victoria` is a Chinese name in one catalogue and a
   * Canadian city in another, and the roster's link is not a statement.
   */
  const rosterNames = new Map<string, string[]>();
  for (const entry of snapshot.vtubers) {
    if (!entry.youtubeId) continue;
    rosterNames.set(entry.youtubeId, [entry.name ?? "", ...entry.aliases].filter(Boolean));
  }

  if (!options.apply) {
    console.log(
      `\n${fresh.length} channel(s) with an id would be imported` +
        (options.limit !== null ? `, the first ${options.limit} of them per run` : "") +
        (fresh.length ? `:\n${fresh.slice(0, 20).map((row) =>
            `  ${row.youtubeId}  ${row.name}  [${row.groups[0] ?? "no group"}]`,
          ).join("\n")}` : "") +
        (counts.get("handle-only")
          ? `\n\n${counts.get("handle-only")} row(s) carry only an @handle; ` +
            "`--resolve-handles <n>` resolves them into imports."
          : "") +
        "\n\nNothing was written. Re-run with --apply.",
    );
    return;
  }

  /* --- resolve handles, when asked -------------------------------------- */
  const handleRows = rows
    .filter((row) => row.verdict === "handle-only")
    .slice(0, options.resolveHandles);
  if (handleRows.length > 0) {
    const source = new InnerTubeSource({ delayMs: 150 });
    const ready = await source.connect();
    if (!ready) {
      console.error("InnerTube is unavailable — the handles were not resolved.");
    } else {
      const resolved = await resolveHandles(
        source,
        handleRows.map((row) => ({
          id: row.id,
          name: row.name,
          handle: row.handle!,
        })),
        (message) => console.log(message),
      );
      const byId = new Map(handleRows.map((row) => [row.id, row]));
      for (const [rowId, youtubeId] of resolved) {
        const row = byId.get(rowId);
        /**
         * The handle may resolve to a channel the dataset already tracks —
         * the roster simply had no id for it — and a channel both a row and
         * the roster itself name twice is one import.
         */
        if (!row || lookup.ids.has(youtubeId) || rosterNames.has(youtubeId)) continue;
        rosterNames.set(youtubeId, [row.name]);
        row.youtubeId = youtubeId;
        row.verdict = "new";
      }
    }
  }

  /**
   * A channel import fetches each profile, so the list is walked in batches —
   * `importYouTubeChannels()` caps a call at 50 and writes the shards at the
   * end of each one.
   */
  for (const row of rows) {
    if (row.verdict === "new" && row.youtubeId) ids.push(row.youtubeId);
  }

  const batchSize = options.batchSize;
  const pending = options.limit === null ? ids : ids.slice(0, options.limit);
  let added = 0;
  let existing = 0;
  const kinds = new Map<string, number>();
  const regions = new Map<string, number>();
  const notVirtual: { id: string; name: string; kind: string }[] = [];
  const mismatched: { id: string; platform: string; roster: string }[] = [];
  const failed: { id: string; reason: string }[] = [];

  for (let offset = 0; offset < pending.length; offset += batchSize) {
    const slice = pending.slice(offset, offset + batchSize);
    const result = await importYouTubeChannels(slice, {
      limit: batchSize,
      rosterIds: new Set(rosterNames.keys()),
    });
    added += result.added.length;
    existing += result.existing;
    failed.push(...result.failed);
    for (const entry of result.added) {
      kinds.set(entry.kind, (kinds.get(entry.kind) ?? 0) + 1);
      regions.set(entry.region, (regions.get(entry.region) ?? 0) + 1);
      if (entry.kind !== "virtual") {
        notVirtual.push({ id: entry.id, name: entry.name, kind: entry.kind });
      }
      const roster = rosterNames.get(entry.id) ?? [];
      if (roster.length > 0 && !namesAgree(entry.name, roster)) {
        mismatched.push({ id: entry.id, platform: entry.name, roster: roster[0]! });
      }
    }
    console.log(
      `import: ${Math.min(offset + batchSize, pending.length)}/${pending.length} · ` +
        `${added} added · ${existing} already tracked · ${failed.length} failed`,
    );
  }

  for (const failure of failed.slice(0, 20)) {
    console.log(`  failed ${failure.id}: ${failure.reason}`);
  }
  if (failed.length > 20) console.log(`  … ${failed.length - 20} more failures`);

  console.log(
    `\n${added} channel(s) added · ` +
      [...kinds].map(([kind, count]) => `${kind} ${count}`).join(" · "),
  );
  console.log(
    `regions: ${[...regions].map(([region, count]) => `${region} ${count}`).join(" · ")}`,
  );
  if (notVirtual.length) {
    console.log(`\n${notVirtual.length} classified as non-virtual — review:`);
    for (const entry of notVirtual.slice(0, 30)) {
      console.log(`  ${entry.id}  ${entry.name}  → ${entry.kind}`);
    }
  }
  if (mismatched.length) {
    console.log(
      `\n${mismatched.length} name disagreement(s) — the platform's name is the ` +
        "one recorded; a roster name this far off may be a wrong id:",
    );
    for (const entry of mismatched.slice(0, 30)) {
      console.log(`  ${entry.id}  platform "${entry.platform}" · roster "${entry.roster}"`);
    }
    if (mismatched.length > 30) console.log(`  … ${mismatched.length - 30} more`);
  }
  console.log("\nRun `npm run data:index` next.");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
