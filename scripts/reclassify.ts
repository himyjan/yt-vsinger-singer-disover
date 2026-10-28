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
 * `addedAt`, its `source` and its name. Only the fields the classifier derives
 * move, and only when it now reads the same evidence differently: `kind` and
 * `role` always, and — with `--languages` — the `region` and `languages` of a
 * record whose region is only a **guess** (`script` or `unknown`), which is
 * how a Spanish description that used to be read as English stops being `en`.
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
import {
  readAllChannelRecords,
  rebuildChannelsManifest,
  refreshManifestChannelCounts,
  writeChannelShards,
} from "./lib/dataset";
import { classifyChannel } from "./lib/classify";
import { toLanguageList } from "./lib/regions";
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
  /**
   * What the roster says about the channel.
   *
   * The platform's description is what the import stored, and it is often a
   * fragment — `Schoko`'s YouTube page says 「Singer who hates their own
   * voice」, while bacharu says 「I'm A Chocolate Loving Arctic demon」. The
   * roster's text is the same kind of evidence as the platform's, so it is
   * offered to the classifier beside it, never instead of it.
   */
  notes: Map<string, { description: string | null; tags: string[]; name: string | null }>;
  log: string[];
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
  const index: RosterIndex = {
    ids: new Set(),
    handles: new Set(),
    notes: new Map(),
    log: [],
  };

  const remember = (keys: string[], entry: BacharuVtuber) => {
    const note = {
      description: entry.description,
      tags: entry.tags,
      name: entry.name,
    };
    for (const key of keys) if (key) index.notes.set(key, note);
  };

  for (const file of files) {
    if (!fs.existsSync(file)) {
      index.log.push(`${file} — not on disk, skipped`);
      continue;
    }
    const snapshot = readJson<{ vtubers?: BacharuVtuber[] }>(file);
    if (!snapshot?.vtubers) {
      index.log.push(`${file} — not a roster snapshot, skipped`);
      continue;
    }
    let added = 0;
    for (const entry of snapshot.vtubers) {
      const keys: string[] = [];
      if (entry.youtubeId) {
        index.ids.add(entry.youtubeId);
        keys.push(entry.youtubeId);
        added++;
      }
      if (entry.youtubeHandle) {
        const handle = entry.youtubeHandle.replace(/^@/, "").toLowerCase();
        index.handles.add(handle);
        keys.push(`handle:${handle}`);
      }
      remember(keys, entry);
    }
    index.log.push(`${file} — ${added} channel id(s)`);
  }

  const vt = readJson<{
    members?: { profile?: { youtubeId?: string | null; handle?: string | null } | null }[];
  }>(".cache/vtubie-groups.json");
  if (vt?.members) {
    let added = 0;
    for (const member of vt.members) {
      const profile = member.profile;
      const keys: string[] = [];
      if (profile?.youtubeId) {
        index.ids.add(profile.youtubeId);
        keys.push(profile.youtubeId);
        added++;
      }
      if (profile?.handle) {
        const handle = String(profile.handle).replace(/^@/, "").toLowerCase();
        index.handles.add(handle);
        keys.push(`handle:${handle}`);
      }
      const note = {
        description: (profile as { description?: string | null })?.description ?? null,
        tags: [] as string[],
        name: (profile as { name?: string | null })?.name ?? null,
      };
      for (const key of keys) index.notes.set(key, note);
    }
    index.log.push(`.cache/vtubie-groups.json — ${added} channel id(s)`);
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
  /**
   * Re-derive `region` and `languages` too, for the records whose region is a
   * guess.
   *
   * The language detector reads the script of the text, and it used to call
   * every latin-script description English — which made a Spanish VTuber an
   * `en` region as well. The pipeline classifies a record when it writes it,
   * so the records written before the fix keep the wrong answer until a pass
   * re-derives them; that pass needs no network, and it must not touch a
   * region a person, a roster or an agency decided.
   */
  languages: boolean;
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    apply: false,
    rosters: true,
    snapshot: ".cache/bacharu-vtubers.json",
    limit: null,
    explain: null,
    languages: false,
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
      case "--languages":
        options.languages = true;
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
            "  --languages      re-derive the region and languages of a guessed region",
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

/**
 * The description and tags the classifier reads for one record.
 *
 * The platform's own text first, and the roster's beside it: a YouTube
 * description that says 「Singer who hates their own voice」 and a bacharu
 * description that says 「I'm A Chocolate Loving Arctic demon」 are two halves
 * of the same evidence, and the classifier only sees what it is given.
 */
function evidenceFor(
  channel: { id: string; handle?: string | null; description: string | null; tags: string[] },
  rosters: RosterIndex,
): { description: string | null; tags: string[] } {
  const note = rosters.notes.get(channel.id) ??
    (channel.handle ? rosters.notes.get(`handle:${channel.handle.toLowerCase()}`) : undefined);
  if (!note) return { description: channel.description, tags: channel.tags };

  const parts = [channel.description, note.description].filter(
    (part): part is string => !!part && part.trim().length > 0,
  );
  /** The classifier reads the first 320 characters as the identity line. */
  const description = parts.length ? [...new Set(parts)].join("\n").slice(0, 1000) : null;
  const tags = [...new Set([...channel.tags, ...note.tags])];
  return { description, tags };
}

/* -------------------------------------------------------------------------- */

function main(): void {
  const options = parseArgs(process.argv.slice(2));

  const rosters = options.rosters
    ? loadRosters([options.snapshot])
    : {
        ids: new Set<string>(),
        handles: new Set<string>(),
        notes: new Map<string, { description: string | null; tags: string[]; name: string | null }>(),
        log: [] as string[],
      };
  for (const line of rosters.log) console.log(`roster: ${line}`);
  console.log(`roster: ${rosters.ids.size} id(s), ${rosters.handles.size} handle(s), ${rosters.notes.size} description(s)`);

  const all = readAllChannelRecords();
  /**
   * `data/overrides.json` is the last word — a hand-written `kind` outranks
   * every classifier, here as in the sync and the import.
   */
  const overrides = readJson<Record<string, { kind?: "virtual" | "real" }>>(
    "data/overrides.json",
  ) ?? {};

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
    const evidence = evidenceFor(record, rosters);
    const fresh = classifyChannel({
      name: record.name,
      aliases: record.aliases,
      description: evidence.description,
      tags: evidence.tags,
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
    const overrideKind = overrides[channel.id]?.kind;

    const claim =
      rosters.ids.has(channel.id) ||
      (channel.handle ? rosters.handles.has(channel.handle.toLowerCase()) : false);
    if (claim) rostered++;

    const evidence = evidenceFor(channel, rosters);
    /**
     * A **hand-written** classification — an override or a curated seed — is
     * the last word, here as everywhere else (`AGENTS.md` rule 5). The
     * reclassify must not undo a person's decision just because the text
     * does not repeat it: `Taylor Swift` is in the dataset because somebody
     * filed her as a real singer, not because a classifier found her.
     */
    const curated = channel.source === "seed" || !!overrideKind;
    const fresh = classifyChannel({
      name: channel.name,
      aliases: channel.aliases,
      description: evidence.description,
      tags: evidence.tags,
      country: channel.country,
      platform,
      virtualClaim: claim ? "roster" : null,
      hasAvatar: !!channel.avatar,
      recordedKind: channel.kind,
      override: overrideKind ? { kind: overrideKind, curated: true } : undefined,
    });
    /**
     * A curated record keeps the kind **and** the role it was given. A
     * person's classification is not a text the classifier can re-read:
     * `Taylor Swift — singer` is a statement about a real musician, and
     * re-deriving her role from the word 「singer」 produced `vtuber` when
     * the kind was forced back to `real`.
     */
    if (curated) {
      fresh.kind = overrideKind ?? channel.kind;
      if (channel.source === "seed") fresh.role = channel.role;
    }

    /**
     * The region follows the language, and the language follows the text.
     *
     * Only a **guessed** region is rewritten. A region a person, a roster or
     * an agency decided is not the classifier's to take back — a Spanish
     * performer's text says `es`, but if a curated override filed them in the
     * `en` scene that is the decision, and it stays.
     */
    const regionIsGuess =
      channel.regionSource === "script" || channel.regionSource === "unknown";
    /**
     * The language is read from the **record's own** text.
     *
     * `evidenceFor()` merges a roster's description into the classifier's
     * input, which is right for `kind` and `role` — the roster's note is the
     * only sentence some channels have — but wrong for the language: a
     * German description beside a roster's English note is a mixed blob, and
     * the detector answers `en`. The channel's own words are what it speaks.
     */
    const ownLanguage = options.languages
      ? classifyChannel({
          name: channel.name,
          aliases: channel.aliases,
          description: channel.description,
          tags: channel.tags,
          country: channel.country,
          platform,
          virtualClaim: claim ? "roster" : null,
          hasAvatar: !!channel.avatar,
          recordedKind: channel.kind,
          override: overrideKind ? { kind: overrideKind, curated: true } : undefined,
        })
      : fresh;
    const regionAfter = regionIsGuess ? ownLanguage.region : channel.region;
    const sourceAfter = regionIsGuess
      ? ownLanguage.regionSource
      : channel.regionSource;
    /**
     * An ambiguous text is not evidence that the old answer was wrong, so a
     * language the record already carries survives a `null` from the
     * detector — a roster's note may be the reason it was known.
     */
    const languagesAfter =
      regionIsGuess && ownLanguage.languages.length
        ? ownLanguage.languages
        : channel.languages;
    /**
     * A region that is `unknown` and has no language is not improved by the
     * alphabet alone: 「Milz Malakite Ch.」 is latin-script and tells us
     * nothing about where the performer belongs, so the old behaviour — a
     * latin name counts as `en` — stays where it already was and is not
     * written into a record that had no answer at all.
     */
    const blankAndAlphabet =
      channel.region === "unknown" &&
      toLanguageList(channel.languages).length === 0 &&
      regionAfter === "en" &&
      toLanguageList(ownLanguage.languages)[0] === "en";
    if (options.languages && regionIsGuess && !blankAndAlphabet) {
      const beforeLang = `${channel.region}/${toLanguageList(channel.languages).join(",")}`;
      const afterLang = `${regionAfter}/${toLanguageList(languagesAfter).join(",")}`;
      if (beforeLang !== afterLang) {
        const key = `${beforeLang} → ${afterLang}`;
        moves.set(key, (moves.get(key) ?? 0) + 1);
        const list = examples.get(key) ?? [];
        if (list.length < 4) list.push(channel.name);
        examples.set(key, list);
        channel.region = regionAfter;
        channel.regionSource = sourceAfter;
        channel.languages = languagesAfter;
        changed++;
      }
    }

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
  const now = new Date().toISOString();
  const result = changed
    ? writeChannelShards(rows, now)
    : { records: rows.length, files: 0 };
  /**
   * A record that changed `kind` or `region` moved to another shard, and one
   * that changed `region` may have emptied the last shard of the old one.
   * `writeChannelShards()` writes records only — the shard **map** is what
   * tells the browser which files exist — so rebuilding it is part of writing
   * the dataset, not a later step.
   *
   * It runs even when nothing changed: a previous run, or a producer that
   * wrote records without the map, can leave the manifest stale on its own.
   */
  rebuildChannelsManifest(rows, now);
  refreshManifestChannelCounts(rows, now);
  if (!changed) {
    console.log("\nNo record changed; the shard map and counts were rebuilt.");
    return;
  }
  console.log(`\nwrote ${result.records} record(s) across ${result.files} shard(s).`);
  console.log("Run `npm run data:index` and `npm run data:validate` next.");
}

main();
