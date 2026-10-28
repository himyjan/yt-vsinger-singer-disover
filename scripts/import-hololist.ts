#!/usr/bin/env tsx
/**
 * Compares a hololist harvest with the dataset, and can import the new
 * channels and attach the links the roster publishes.
 *
 * `scripts/harvest-hololist.ts` produces a snapshot in `.cache/`; this is the
 * gate between that snapshot and `data/`. It prints what would change and
 * writes nothing without `--apply`.
 *
 * ## The identity
 *
 * hololist publishes a YouTube `@handle`, never a `UC…` id, so the first
 * question is which record a row is about. A handle is looked up in the
 * dataset's own handle index first — `handle`, the YouTube `platforms[]`
 * entry, `externals.youtube` — and only a handle the dataset has never heard
 * of costs an InnerTube `resolve_url` call. The answers are cached in
 * `.cache/hololist-resolved.json` (including the ones that resolved to
 * nothing), because the roster is 9,359 rows and a second run must not repeat
 * that work.
 *
 * ## The gate
 *
 * hololist is a performer directory — every entry is a `V-Tuber`,
 * `V-Streamer`, `V-Singer` or `V-UP` — so a row is a **virtual claim**
 * (`rosterIds`), and the region, the name and the role stay the profile's and
 * the classifier's. What a roster still must not buy is a fan:
 * `detectClipAccount()` and `isFanAccountName()` must both be false, since a
 * clip channel happily files itself as a VTuber while duplicating the
 * performer it clips (`AGENTS.md` rule 15).
 *
 * ## The links
 *
 * This is why the roster is worth reading. An entry files the performer's
 * Twitch, X, Instagram, TikTok, Bilibili and Niconico accounts beside the
 * YouTube channel it belongs to, and a record this catalogue already tracks
 * is usually missing exactly those. `--links` reports the handles that can be
 * added to the `externals` a description harvest would have found, and
 * `--links --apply` writes them. Nothing is overwritten: a handle already on
 * the record, from any source, is left alone.
 *
 *   npm run data:hololist-import                     # report only
 *   npm run data:hololist-import -- --resolve 50     # + resolve 50 handles
 *   npm run data:hololist-import -- --apply          # import the new channels
 *   npm run data:hololist-import -- --links          # report the attachable links
 *   npm run data:hololist-import -- --links --apply  # attach them
 */

import fs from "node:fs";
import { readAllChannelRecords } from "./lib/dataset";
import { detectClipAccount, isFanAccountName } from "./lib/classify";
import { applyChannelEdits } from "./lib/roster-fill";
import {
  importYouTubeChannels,
  rosterGender,
  type RosterHint,
} from "./lib/import-channels";
import { canonicalAgency } from "./lib/regions";
import { extractExternalLinks } from "./lib/twitch";
import { InnerTubeSource } from "./lib/youtubei";
import {
  activityOfStatus,
  youTubeIdentityOf,
  type HoloListEntry,
  type HoloListSnapshot,
} from "./lib/hololist";
import type { Activity, Channel, Gender } from "./lib/types";

const PAGES_DIR = ".cache/hololist/pages";

/**
 * The entries on disk while a harvest is still running.
 *
 * The merged snapshot is written when a pass ends; the page files are the
 * pass's own progress, and reading them lets an import start before the
 * first full harvest has finished.
 */
function readPages(): HoloListEntry[] {
  let files: string[] = [];
  try {
    files = fs.readdirSync(PAGES_DIR).filter((file) => file.endsWith(".json"));
  } catch {
    return [];
  }
  const entries: HoloListEntry[] = [];
  for (const file of files) {
    try {
      const entry = JSON.parse(fs.readFileSync(`${PAGES_DIR}/${file}`, "utf8")) as HoloListEntry;
      if (entry?.url && entry?.name) entries.push(entry);
    } catch {
      /* A half-written page is rewritten by the next pass. */
    }
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name));
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

const SNAPSHOT = ".cache/hololist.json";
const RESOLVED = ".cache/hololist-resolved.json";
const DEAD_MS = 7 * 24 * 60 * 60 * 1000;

interface Options {
  apply: boolean;
  links: boolean;
  resolve: number | null;
  limit: number | null;
  batchSize: number;
  refresh: boolean;
  pages: boolean;
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    apply: false,
    links: false,
    resolve: null,
    limit: null,
    batchSize: 50,
    refresh: false,
    pages: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--apply") options.apply = true;
    else if (arg === "--links") options.links = true;
    else if (arg === "--refresh") options.refresh = true;
    else if (arg === "--pages") options.pages = true;
    else if (arg === "--resolve") options.resolve = Math.max(1, Number(argv[++i] ?? 50));
    else if (arg === "--limit") options.limit = Math.max(1, Number(argv[++i] ?? 100));
    else if (arg === "--batch") options.batchSize = Math.min(50, Number(argv[++i] ?? 50));
    else if (arg === "--help" || arg === "-h") {
      console.log(
        [
          "Usage: npm run data:hololist-import -- [options]",
          "",
          "  --apply         import the channels the gate admits / write the links",
          "  --links         attach Twitch, X, Instagram, TikTok, Bilibili, Niconico",
          "  --resolve <n>   resolve at most n handles to channel ids in this pass",
          "  --limit <n>     import at most n channels",
          "  --batch <n>     ids per import call (max 50)",
          "  --refresh       ignore the resolved-handle cache",
          "  --pages         read .cache/hololist/pages/ (a harvest still running)",
        ].join("\n"),
      );
      process.exit(0);
    }
  }
  return options;
}

type Verdict = "tracked" | "new" | "fan" | "no-youtube" | "unresolved";

interface Row {
  entry: HoloListEntry;
  id: string | null;
  record: Channel | null;
  verdict: Verdict;
  reason?: string;
}

/** A handle with its `@`, its case and its noise removed. */
function foldHandle(handle: string): string {
  const folded = handle
    .trim()
    .replace(/^@+/, "")
    .replace(/^https?:\/\/(?:www\.)?youtube\.com\//i, "")
    .replace(/^(?:channel|user|c)\//i, "")
    .replace(/[/?#].*$/, "")
    .toLowerCase();
  /**
   * `channel/UC…` is an id, not a handle, and an id must never be indexed as
   * one — a channel would then never match its own `UC…`.
   */
  return /^uc[\w-]{20,}$/.test(folded) ? "" : folded;
}

/**
 * The handle a record answers to, wherever the dataset put it.
 *
 * A record keyed by `UC…` carries `handle`; one that has a YouTube account
 * beside its own platform carries it in `platforms[]`; one built from a
 * description carries `externals.youtube`. All three name the same thing.
 */
function handlesOf(record: Channel): { handles: string[]; channelIds: string[] } {
  const handles: string[] = [];
  const channelIds: string[] = [];
  const push = (value: string | null | undefined) => {
    if (!value) return;
    const id = /^(UC[\w-]{20,})$/.exec(value.trim());
    if (id) {
      channelIds.push(id[1]!);
      return;
    }
    const handle = foldHandle(value);
    if (handle) handles.push(handle);
  };
  push(record.handle);
  for (const platform of record.platforms) {
    if (platform.platform !== "youtube") continue;
    push(platform.handle);
    push(platform.id);
  }
  push(record.externals?.youtube);
  return { handles, channelIds };
}

/**
 * The agency the roster files a performer under.
 *
 * hololist writes `hololive production` for every Hololive talent, which is
 * the parent company's name rather than a brand of its own — the dataset
 * already files those talents under `hololive`. Everything else goes through
 * `canonicalAgency()`, so `NIJISANJI EN` and `Nijisanji EN` stay one agency.
 */
function rosterAgency(affiliation: string | null): string | null {
  if (!affiliation) return null;
  const folded = affiliation.trim();
  if (/^hololive production$/i.test(folded)) return "hololive";
  return canonicalAgency(folded);
}

/** The platform links an entry publishes, as `externals` handles. */
function externalHandles(entry: HoloListEntry): Record<string, string> {
  const text = entry.links.map((link) => link.url).join("\n");
  const found = extractExternalLinks(text);
  /** The record *is* the YouTube channel; its own link is not an external. */
  delete found.youtube;
  return found;
}

interface LinkPlan {
  channel: Channel;
  entry: HoloListEntry;
  fields: Record<string, string>;
}

function planLinks(rows: Row[], existing: Map<string, Channel>): LinkPlan[] {
  const plans: LinkPlan[] = [];
  for (const row of rows) {
    if (row.verdict !== "tracked" || !row.record) continue;
    const channel = existing.get(row.record.id);
    if (!channel) continue;
    const found = externalHandles(row.entry);
    const fields: Record<string, string> = {};
    for (const [key, handle] of Object.entries(found)) {
      if (!handle) continue;
      if (!channel.externals?.[key]) fields[key] = handle;
    }
    if (Object.keys(fields).length) plans.push({ channel, entry: row.entry, fields });
  }
  return plans;
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

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(SNAPSHOT)) {
    console.error(`no snapshot at ${SNAPSHOT} — run \`npm run data:hololist\` first`);
    process.exit(1);
  }
  const snapshot: HoloListSnapshot = options.pages
    ? {
        generatedAt: new Date().toISOString(),
        source: PAGES_DIR,
        entries: readPages(),
      }
    : (JSON.parse(fs.readFileSync(SNAPSHOT, "utf8")) as HoloListSnapshot);
  const dataset = readAllChannelRecords();
  const byId = new Map(dataset.map((channel) => [channel.id, channel]));

  /** Every handle the dataset already answers to, and the record behind it. */
  const byHandle = new Map<string, Channel>();
  for (const channel of dataset) {
    const { handles } = handlesOf(channel);
    for (const handle of handles) {
      if (!byHandle.has(handle)) byHandle.set(handle, channel);
    }
  }

  const rows: Row[] = [];
  for (const entry of snapshot.entries) {
    const identity = youTubeIdentityOf(entry.links);
    const hasYouTube = identity.channelId !== null || identity.handles.length > 0;
    if (!hasYouTube) {
      rows.push({ entry, id: null, record: null, verdict: "no-youtube", reason: "no YouTube channel" });
      continue;
    }
    /**
     * The fan test runs before anything else: a clip channel names itself
     * after the performer it clips, and the roster files it all the same.
     */
    if (detectClipAccount(entry.name, entry.description ?? "") || isFanAccountName(entry.name)) {
      rows.push({ entry, id: null, record: null, verdict: "fan", reason: "a clip or fan account" });
      continue;
    }

    let record: Channel | null = null;
    if (identity.channelId) record = byId.get(identity.channelId) ?? null;
    for (const handle of identity.handles) {
      record ??= byHandle.get(foldHandle(handle)) ?? null;
    }
    rows.push({
      entry,
      id: record?.id ?? identity.channelId,
      record,
      verdict: record ? "tracked" : "unresolved",
    });
  }

  console.log(
    `snapshot ${snapshot.generatedAt} · ${snapshot.entries.length} entr(y/ies) · ` +
      `${dataset.length} record(s) tracked`,
  );
  const printCounts = () => {
    const counts = new Map<Verdict, number>();
    for (const row of rows) counts.set(row.verdict, (counts.get(row.verdict) ?? 0) + 1);
    for (const verdict of ["tracked", "new", "unresolved", "fan", "no-youtube"] as const) {
      const count = counts.get(verdict) ?? 0;
      if (count) console.log(`  ${verdict.padEnd(12)} ${count}`);
    }
  };
  printCounts();
  const rejected = rows.filter((row) => row.verdict === "fan" || row.verdict === "no-youtube");
  for (const row of rejected.slice(0, 8)) {
    console.log(`  ${row.verdict}: ${row.entry.name} — ${row.reason}`);
  }
  if (rejected.length > 8) console.log(`  … ${rejected.length - 8} more`);

  /* ---------------------------------------------------------------------- */
  /* Links                                                                  */
  /* ---------------------------------------------------------------------- */

  if (options.links) {
    const plans = planLinks(rows, byId);
    const fields = new Map<string, number>();
    let missing = 0;
    for (const plan of plans) {
      for (const key of Object.keys(plan.fields)) {
        fields.set(key, (fields.get(key) ?? 0) + 1);
        missing++;
      }
    }
    console.log(
      `\nlinks: ${plans.length} tracked record(s) can take ${missing} handle(s) ` +
        `hololist publishes and the dataset does not have:` +
        (fields.size
          ? `\n  ${[...fields.entries()]
              .sort((a, b) => b[1] - a[1])
              .map(([key, count]) => `${count} ${key}`)
              .join(" · ")}`
          : ""),
    );
    for (const plan of plans.slice(0, 10)) {
      console.log(
        `  ${plan.entry.name} → ${Object.entries(plan.fields)
          .map(([key, handle]) => `${key}:${handle}`)
          .join(", ")}`,
      );
    }
    if (plans.length > 10) console.log(`  … ${plans.length - 10} more`);

    if (!options.apply) {
      console.log("\nNothing was written. Re-run with --links --apply.");
      return;
    }

    const written = applyChannelEdits(
      plans.map((plan) => ({
        id: plan.channel.id,
        update: (channel) => {
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
      "hololist-links",
      new Date().toISOString(),
    );
    console.log(`${written} record(s) had their externals filled from hololist`);
    return;
  }

  /* ---------------------------------------------------------------------- */
  /* Import                                                                 */
  /* ---------------------------------------------------------------------- */

  /**
   * Resolution is the only network step that runs without `--apply`, because
   * a report that cannot say "this is new" is not a report. It is bounded:
   * one call per handle, `--resolve` rows per pass, and a cache that survives
   * the pass.
   */
  const unresolved = rows.filter((row) => row.verdict === "unresolved");
  const resolveLimit = options.resolve ?? (options.apply ? unresolved.length : 0);
  if (resolveLimit > 0 && unresolved.length) {
    const cache = options.refresh ? ({} as ResolvedCache) : readResolved();
    const source = await innertube();
    if (!source) {
      console.error("InnerTube is unavailable — handles cannot be resolved");
    } else {
      const queue = unresolved.slice(0, resolveLimit);
      let resolved = 0;
      let dead = 0;
      for (const [index, row] of queue.entries()) {
        const identity = youTubeIdentityOf(row.entry.links);
        if (identity.channelId) {
          row.id = identity.channelId;
          row.record = byId.get(identity.channelId) ?? null;
          row.verdict = row.record ? "tracked" : "new";
          resolved++;
          continue;
        }
        let id: string | null = null;
        for (const handle of identity.handles) {
          const key = foldHandle(handle);
          const cached = cache[key];
          if (cached && (cached.id || Date.now() - Date.parse(cached.at) < DEAD_MS)) {
            id = cached.id;
          } else {
            id = await source.resolveHandle(key);
            cache[key] = { id, at: new Date().toISOString() };
          }
          if (id) break;
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
        if ((index + 1) % 25 === 0) {
          writeResolved(cache);
          console.log(`  resolve: ${index + 1}/${queue.length} · ${resolved} resolved · ${dead} dead`);
        }
      }
      writeResolved(cache);
      console.log(`  resolve: ${resolved} of ${queue.length} resolved to a channel id, ${dead} dead`);
      printCounts();
    }
  }

  const fresh = rows.filter((row) => row.verdict === "new" && row.id);
  const deduped = new Map<string, Row>();
  for (const row of fresh) {
    if (!deduped.has(row.id!)) deduped.set(row.id!, row);
  }
  const newRows = [...deduped.values()];

  console.log(
    `\n${newRows.length} channel(s) would be imported` +
      (newRows.length
        ? `:\n${newRows
            .slice(0, 20)
            .map(
              (row) =>
                `  ${row.id}  ${row.entry.name}  ` +
                `[${row.entry.types.join("/") || "?"}${row.entry.status ? ` · ${row.entry.status}` : ""}]`,
            )
            .join("\n")}`
        : "") +
      (newRows.length > 20 ? `\n  … ${newRows.length - 20} more` : ""),
  );

  if (!options.apply) {
    console.log("\nNothing was written. Re-run with --apply to import them.");
    return;
  }

  const ids = (options.limit === null ? newRows : newRows.slice(0, options.limit)).map(
    (row) => row.id!,
  );
  if (!ids.length) {
    console.log("Nothing to import.");
    return;
  }

  /**
   * What the roster knows and the profile does not: the languages to ask the
   * profile in, the agency it files the performer under, whether they have
   * graduated, and a subscriber count that is exact although the page shows
   * `63.6K`.
   */
  const activity: Record<string, Activity> = {};
  const agency: Record<string, string> = {};
  const languages: Record<string, string[]> = {};
  const debut: Record<string, string> = {};
  const gender: Record<string, Gender> = {};
  const stats: RosterHint["stats"] = {};
  const byEntryId = new Map(newRows.map((row) => [row.id!, row]));
  for (const id of ids) {
    const row = byEntryId.get(id);
    if (!row) continue;
    const entry = row.entry;
    const state = activityOfStatus(entry.status);
    if (state !== "unknown") activity[id] = state;
    const affiliation = rosterAgency(entry.affiliation);
    if (affiliation) agency[id] = affiliation;
    if (entry.languages.length) languages[id] = entry.languages;
    if (entry.debut) debut[id] = entry.debut;
    const stated = rosterGender(entry.gender);
    if (stated) gender[id] = stated;
    if (entry.subscribers != null) stats[id] = { subscribers: entry.subscribers };
  }

  const rosterIds = new Set(ids);
  let added = 0;
  let existing = 0;
  let failed = 0;
  for (let offset = 0; offset < ids.length; offset += options.batchSize) {
    const batch = ids.slice(offset, offset + options.batchSize);
    const result = await importYouTubeChannels(batch, {
      limit: options.batchSize,
      rosterIds,
      rosterHint: { activity, agency, languages, debut, gender, stats },
      onLog: (message) => console.log(`  ${message}`),
    });
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

  console.log(`\n${added} channel(s) written · ${existing} already tracked · ${failed} failed`);
  console.log("Run `npm run data:index` and `npm run data:validate` next.");
}

main();
