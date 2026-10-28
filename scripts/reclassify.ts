#!/usr/bin/env tsx
/**
 * Re-derives `kind` and `role` for every channel from what is already on disk.
 *
 * `classifyChannel()` is deterministic and needs no network — the name, the
 * description, the tags and the country are on the record — so a corrected
 * classifier can be applied to the whole dataset in seconds instead of
 * re-fetching sixty thousand profiles. That is the point of keeping the
 * classifier free of clocks and requests (`AGENTS.md` rule 8).
 *
 * **It is a rewrite of stored evidence, not of history.** A record keeps its
 * `addedAt`, its `source`, its name and region. Only two fields move, and only
 * when the classifier now reads the same evidence differently.
 *
 * ## The roster claim
 *
 * The rosters — vdb, vTubie's groups, bacharu — file every entry they carry as
 * a virtual performer. Their own imports say so (`rosterIds`), but a record
 * that was written before that option existed lost the claim, and a later
 * details pass cannot put it back: the claim is not on the title page.
 *
 * So the snapshot's ids and handles are read back from `.cache/` and used as
 * the claim, exactly as an import would. A record the roster names is virtual;
 * a record it does not name is offered only for the parts that do not depend
 * on the roster — the vocabulary, the explicit real-identity words, the
 * singer-versus-songwriter split.
 *
 *   npm run data:reclassify                 # report what would change
 *   npm run data:reclassify -- --apply      # write it
 *   npm run data:reclassify -- --snapshot .cache/bacharu-vtubers.json
 *   npm run data:reclassify -- --no-rosters # judge every record on its text
 */

import fs from "node:fs";
import { readAllChannelRecords, writeChannelShards } from "./lib/dataset";
import { classifyChannel } from "./lib/classify";
import { primaryPlatformOf } from "./lib/platforms";
import type { BacharuVtuber } from "./lib/bacharu";

/* -------------------------------------------------------------------------- */
/* The rosters                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Every id and handle the rosters name, as the claim they are.
 *
 * A handle is kept under a `handle:` prefix so the two namespaces cannot
 * collide with an id — a Twitch record's id is `twitch:name`, and a YouTube
 * handle is a name, never a key.
 */
interface RosterIndex {
  ids: Set<string>;
  handles: Set<string>;
  notes: string[];
}

function readJson<T>(file: string): T | null {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

function loadRosters(files: string[]): RosterIndex {
  const index: RosterIndex = { ids: new Set(), handles: new Set(), notes: [] };

  for (const file of files) {
    if (!fs.existsSync(file)) {
      index.notes.push(`${file} — not on disk, skipped`);
      continue;
    }
    const snapshot = readJson<{ vtubers?: BacharuVtuber[] }>(file);
    if (!snapshot?.vtubers) {
      index.notes.push(`${file} — not a roster snapshot, skipped`);
      continue;
    }
    let added = 0;
    for (const entry of snapshot.vtubers) {
      if (entry.youtubeId) {
        index.ids.add(entry.youtubeId);
        added++;
      }
      if (entry.youtubeHandle) {
        index.handles.add(entry.youtubeHandle.replace(/^@/, "").toLowerCase());
      }
    }
    index.notes.push(`${file} — ${added} channel id(s)`);
  }

  const vt = readJson<{
    members?: { profile?: { youtubeId?: string | null; handle?: string | null } | null }[];
  }>(".cache/vtubie-groups.json");
  if (vt?.members) {
    let added = 0;
    for (const member of vt.members) {
      const profile = member.profile;
      if (profile?.youtubeId) {
        index.ids.add(profile.youtubeId);
        added++;
      }
      if (profile?.handle) {
        index.handles.add(String(profile.handle).replace(/^@/, "").toLowerCase());
      }
    }
    index.notes.push(`.cache/vtubie-groups.json — ${added} channel id(s)`);
  }

  return index;
}

/* -------------------------------------------------------------------------- */
/* Options                                                                    */
/* -------------------------------------------------------------------------- */

interface Options {
  apply: boolean;
  rosters: boolean;
  snapshot: string;
  limit: number | null;
  explain: string | null;
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    apply: false,
    rosters: true,
    snapshot: ".cache/bacharu-vtubers.json",
    limit: null,
    explain: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    switch (arg) {
      case "--apply":
        options.apply = true;
        break;
      case "--no-rosters":
        options.rosters = false;
        break;
      case "--snapshot":
        options.snapshot = argv[i + 1] ?? options.snapshot;
        i++;
        break;
      case "--explain":
        options.explain = argv[i + 1] ?? null;
        i++;
        break;
      case "--limit":
        options.limit = Math.max(1, Number(argv[i + 1] ?? 1));
        i++;
        break;
      case "--help":
      case "-h":
        console.log(
          [
            "Usage: npm run data:reclassify -- [options]",
            "",
            "  --apply          write the new kinds and roles",
            "  --snapshot <p>   the roster whose ids are the virtual claim",
            "  --no-rosters     judge every record on its own text only",
            "  --limit <n>      look at the first n records",
            "  --explain <id>   print one record's claim and classification",
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

function main(): void {
  const options = parseArgs(process.argv.slice(2));

  const rosters = options.rosters
    ? loadRosters([options.snapshot])
    : { ids: new Set<string>(), handles: new Set<string>(), notes: [] };
  for (const note of rosters.notes) console.log(`roster: ${note}`);

  const all = readAllChannelRecords();

  if (options.explain) {
    const record = all.find((row) => row.id === options.explain || row.name === options.explain);
    if (!record) {
      console.error(`no record with id or name "${options.explain}"`);
      process.exit(1);
    }
    const platform = primaryPlatformOf(record);
    const byId = rosters.ids.has(record.id);
    const byHandle = record.handle
      ? rosters.handles.has(record.handle.toLowerCase())
      : false;
    const fresh = classifyChannel({
      name: record.name,
      aliases: record.aliases,
      description: record.description,
      tags: record.tags,
      country: record.country,
      platform,
      virtualClaim: byId || byHandle ? "roster" : null,
      hasAvatar: !!record.avatar,
      recordedKind: record.kind,
    });
    console.log({
      id: record.id,
      name: record.name,
      handle: record.handle,
      platform,
      claimedById: byId,
      claimedByHandle: byHandle,
      rosterHandles: [...rosters.handles].filter((h) =>
        record.handle ? h.includes(record.handle.toLowerCase().slice(0, 4)) : false,
      ).slice(0, 5),
      stored: `${record.kind}/${record.role}`,
      fresh: `${fresh.kind}/${fresh.role}`,
    });
    return;
  }

  const rows = options.limit === null ? all : all.slice(0, options.limit);
  const moves = new Map<string, number>();
  const examples = new Map<string, string[]>();
  let changed = 0;
  let rostered = 0;

  for (const channel of rows) {
    const platform = primaryPlatformOf(channel);
    if (!platform) continue;

    const claim =
      rosters.ids.has(channel.id) ||
      (channel.handle ? rosters.handles.has(channel.handle.toLowerCase()) : false);
    if (claim) rostered++;

    const fresh = classifyChannel({
      name: channel.name,
      aliases: channel.aliases,
      description: channel.description,
      tags: channel.tags,
      country: channel.country,
      platform,
      virtualClaim: claim ? "roster" : null,
      hasAvatar: !!channel.avatar,
      recordedKind: channel.kind,
    });

    const before = `${channel.kind}/${channel.role}`;
    const after = `${fresh.kind}/${fresh.role}`;
    if (before === after) continue;

    const why = `${claim ? "roster" : "text"}${platform ? `,${platform}` : ""}`;
    const key = `${before} → ${after}  [${why}]`;
    moves.set(key, (moves.get(key) ?? 0) + 1);
    const list = examples.get(key) ?? [];
    if (list.length < 4) list.push(channel.name);
    examples.set(key, list);

    channel.kind = fresh.kind;
    channel.role = fresh.role;
    changed++;
  }

  console.log(
    `\n${rows.length} record(s) · ${rostered} named by a roster · ${changed} would change`,
  );
  const ordered = [...moves].sort((a, b) => b[1] - a[1]);
  for (const [key, count] of ordered.slice(0, 14)) {
    console.log(
      `  ${String(count).padStart(6)}  ${key.padEnd(38)} ${(examples.get(key) ?? []).join(", ")}`,
    );
  }
  if (ordered.length > 14) console.log(`  … ${ordered.length - 14} more kinds of move`);

  if (!options.apply) {
    console.log("\nNothing was written. Re-run with --apply.");
    return;
  }
  if (!changed) {
    console.log("\nNothing to write.");
    return;
  }
  const result = writeChannelShards(rows, new Date().toISOString());
  console.log(`\nwrote ${result.records} record(s) across ${result.files} shard(s).`);
  console.log("Run `npm run data:index` and `npm run data:validate` next.");
}

main();
