#!/usr/bin/env tsx
/**
 * Compares a vTubie groups harvest with the dataset, and can import the new
 * channels.
 *
 * `scripts/harvest-vtubie-groups.ts` produces a snapshot in `.cache/`; this
 * script is the gate between that snapshot and `data/`. It prints what would
 * change and writes nothing unless `--apply` is given, because the snapshot is
 * a directory's claim and the dataset is a public artefact.
 *
 * The admission test is the **harvest** gate in `AGENTS.md` rule 15, not the
 * discovery gate: the question is whether an account is a *performer*, not
 * whether they sing. So:
 *
 *   - a virtual-creator claim must exist — vTubie's own `types` say `VTuber`
 *     or `VStreamer`, and the entry only exists because a group lists it;
 *   - `detectClipAccount()` and `isFanAccountName()` must both be false, since
 *     a clip channel happily puts 「VTuber」 in its name while duplicating the
 *     performer it clips;
 *   - a profile with no `youtubeId` is reported, not imported: the id is the
 *     dataset's key and a name is not one.
 *
 *   npm run data:vtubie-import                # report only
 *   npm run data:vtubie-import -- --limit 50  # report 50 rows
 *   npm run data:vtubie-import -- --apply     # import, 50 at a time
 *   npm run data:vtubie-import -- --apply --limit 200
 */

import fs from "node:fs";
import { readAllChannelRecords } from "./lib/dataset";
import { detectClipAccount, isFanAccountName, normalize } from "./lib/classify";
import { importYouTubeChannels } from "./lib/import-channels";

/* -------------------------------------------------------------------------- */
/* The snapshot                                                               */
/* -------------------------------------------------------------------------- */

interface SnapshotProfile {
  name: string;
  types: string[];
  region: string | null;
  groups: string[];
  debutDate: string | null;
  status: string | null;
  twitter: string | null;
  youtubeId: string | null;
  gender: string | null;
  languages: string[];
  subscribers: number | null;
  description: string | null;
}

interface SnapshotMember {
  slug: string;
  name: string;
  groups: string[];
  profile: SnapshotProfile | null;
}

interface Snapshot {
  generatedAt: string;
  source: string;
  listingDone: boolean;
  groups: { slug: string; name: string; members: number | null }[];
  profilesRead: number;
  members: SnapshotMember[];
}

/* -------------------------------------------------------------------------- */
/* Verdicts                                                                   */
/* -------------------------------------------------------------------------- */

const VIRTUAL_TYPE = /vtuber|vstreamer|virtual|vsinger/i;

/**
 * A profile that describes a **group** rather than a person.
 *
 * `.LIVE` appears in the directory's member links because it belongs to a
 * larger umbrella, and its own page reads "is a group of Virtual YouTubers".
 * Importing it would file an agency as a performer, so it is caught before the
 * virtual-creator test — the type block says `VTuber` either way.
 */
const GROUP_DESCRIPTION =
  /is a group of|is an? (?:agency|company|production)|group of virtual|that manages|talent agency|プロダクション|is a virtual youtuber group/i;

type Verdict =
  /** Not in the dataset and passes the gate — imported by `--apply`. */
  | "new"
  /** Already tracked, so there is nothing to do. */
  | "tracked"
  /** The profile publishes no YouTube id, so the record has no key. */
  | "no-id"
  /** A clip, re-upload or translation account — a duplicate of a performer. */
  | "fan"
  /** Nothing on the profile claims a virtual identity. */
  | "no-claim"
  /** The profile is a group's own page, not a performer in it. */
  | "group"
  /**
   * A record with this name already exists without a YouTube link — almost
   * certainly the same person, tracked on Bilibili. Attaching the channel to
   * that record is `data:links`' job, not a second record's.
   */
  | "name-collision"
  /** vTubie lists it, but no profile was ever read. */
  | "no-profile";

interface Row {
  slug: string;
  name: string;
  id: string | null;
  groups: string[];
  verdict: Verdict;
  /** Why the row was rejected, when it was. */
  reason: string | null;
}

/**
 * What the dataset already knows, for the two tests that need it: the id set,
 * and the names of records that have **no** YouTube link.
 *
 * The second is what turns a same-name match into a review row rather than a
 * second record: `Hanon` on Bilibili and a `Hanon` channel on YouTube are
 * almost certainly one performer, and the way to say so is to attach the
 * channel to the existing record (`data:links`), not to add another.
 */
interface Lookup {
  ids: Set<string>;
  namesWithoutYouTube: Map<string, string>;
}

function judge(member: SnapshotMember, lookup: Lookup): Row {
  const profile = member.profile;
  const groups = profile?.groups.length ? profile.groups : member.groups;
  const base = {
    slug: member.slug,
    name: profile?.name ?? member.name,
    id: profile?.youtubeId ?? null,
    groups,
  };

  if (!profile) {
    return { ...base, verdict: "no-profile", reason: "the profile was never read" };
  }
  if (!profile.youtubeId && profile.status === "deleted") {
    return { ...base, verdict: "no-profile", reason: "vTubie no longer serves the profile" };
  }
  if (!profile.youtubeId) {
    return { ...base, verdict: "no-id", reason: "no YouTube channel on the profile" };
  }
  if (lookup.ids.has(profile.youtubeId)) {
    return { ...base, verdict: "tracked", reason: null };
  }

  /**
   * A group's own page: it names a group as its own parent, or it describes
   * itself as one. That is the directory's entry for the agency, not for a
   * performer inside it.
   */
  const ownGroups = (profile.groups ?? []).map((group) => group.trim().toLowerCase());
  const isGroupPage =
    ownGroups.includes(profile.name.trim().toLowerCase()) ||
    GROUP_DESCRIPTION.test(profile.description ?? "");
  if (isGroupPage) {
    return { ...base, verdict: "group", reason: "the profile describes a group, not a performer" };
  }

  /**
   * A fan account is a duplicate, and the name test is the one that catches
   * it — 「…搬运组」, 「…剪辑」, 「…切片」, an account named after its subject.
   */
  if (isFanAccountName(profile.name) || isFanAccountName(member.name)) {
    return { ...base, verdict: "fan", reason: "the name is a fan or clip account" };
  }
  const text = normalize(`${profile.name} ${profile.description ?? ""}`);
  if (detectClipAccount(profile.name, profile.description) || detectClipAccount(member.name, "")) {
    return { ...base, verdict: "fan", reason: "the profile describes a clip account" };
  }

  /**
   * The virtual-creator claim. vTubie's `types` are the directory's own
   * classification and the reason the entry is in a VTuber group; the
   * description is the second chance, since a profile can list its type
   * without a type block.
   */
  const claimsVirtual =
    profile.types.some((type) => VIRTUAL_TYPE.test(type)) || VIRTUAL_TYPE.test(text);
  if (!claimsVirtual) {
    return {
      ...base,
      verdict: "no-claim",
      reason: `nothing claims a virtual identity (types: ${profile.types.join(", ") || "none"})`,
    };
  }

  /**
   * The last test: is this performer already here without a YouTube link?
   * Checked after the fan and group tests so a clip account sharing a
   * performer's name is still reported as a clip account.
   */
  const collision = lookup.namesWithoutYouTube.get(normalize(profile.name));
  if (collision) {
    return {
      ...base,
      verdict: "name-collision",
      reason: `${profile.name} is already tracked as ${collision} — attach the channel there`,
    };
  }

  return { ...base, verdict: "new", reason: null };
}

/* -------------------------------------------------------------------------- */
/* Options                                                                    */
/* -------------------------------------------------------------------------- */

interface Options {
  apply: boolean;
  limit: number | null;
  snapshotPath: string;
  batchSize: number;
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    apply: false,
    limit: null,
    snapshotPath: ".cache/vtubie-groups.json",
    batchSize: 50,
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
      case "--help":
      case "-h":
        console.log(
          [
            "Usage: npm run data:vtubie-import -- [options]",
            "",
            "  --apply              write the channels the gate admits",
            "  --limit <n>          look at the first n ids only",
            "  --batch <n>          ids per import call, max 50 (default 50)",
            "  --snapshot <path>    the harvest to read (default .cache/vtubie-groups.json)",
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
 * Reads the dataset once, for the two questions the gate asks of it.
 *
 * The id set carries every platform id, not only YouTube: a channel already
 * tracked on Twitch is not new information about the world, and the record is
 * keyed by its platform ids.
 */
function buildLookup(): Lookup {
  const records = readAllChannelRecords();
  const ids = new Set<string>();
  const namesWithoutYouTube = new Map<string, string>();

  for (const record of records) {
    const hasYouTube = record.platforms.some((platform) => platform.platform === "youtube");
    for (const platform of record.platforms) ids.add(platform.id);
    ids.add(record.id);
    if (hasYouTube) continue;
    for (const name of [record.name, ...record.aliases]) {
      const key = normalize(name);
      if (key && !namesWithoutYouTube.has(key)) namesWithoutYouTube.set(key, record.id);
    }
  }

  return { ids, namesWithoutYouTube };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  if (!fs.existsSync(options.snapshotPath)) {
    console.error(
      `no snapshot at ${options.snapshotPath} — run \`npm run data:vtubie-groups\` first`,
    );
    process.exit(1);
  }
  const snapshot = JSON.parse(fs.readFileSync(options.snapshotPath, "utf8")) as Snapshot;

  const lookup = buildLookup();
  const rows = snapshot.members.map((member) => judge(member, lookup));

  const counts = new Map<Verdict, number>();
  for (const row of rows) counts.set(row.verdict, (counts.get(row.verdict) ?? 0) + 1);

  console.log(
    `snapshot ${snapshot.generatedAt} · ${snapshot.groups.length} groups · ` +
      `${snapshot.profilesRead} profiles · ${snapshot.members.length} members`,
  );
  for (const verdict of [
    "new",
    "tracked",
    "no-id",
    "no-profile",
    "fan",
    "group",
    "no-claim",
    "name-collision",
  ] as const) {
    const count = counts.get(verdict) ?? 0;
    if (count) console.log(`  ${verdict.padEnd(10)} ${count}`);
  }

  /* --- what the gate rejected, so a person can look --------------------- */
  for (const verdict of ["fan", "group", "no-claim", "name-collision"] as const) {
    const rejected = rows.filter((row) => row.verdict === verdict);
    if (!rejected.length) continue;
    console.log(`\n${verdict} (${rejected.length}):`);
    for (const row of rejected.slice(0, 40)) {
      console.log(`  ${row.name} — ${row.reason} · ${row.groups.join(", ") || "no group"}`);
    }
    if (rejected.length > 40) console.log(`  … ${rejected.length - 40} more`);
  }

  const fresh = rows.filter((row) => row.verdict === "new");
  const ids = fresh.map((row) => row.id!).filter(Boolean);
  const batch = options.limit === null ? ids : ids.slice(0, options.limit);

  if (!options.apply) {
    console.log(
      `\n${ids.length} channel(s) would be imported.` +
        (ids.length ? ` First:\n${fresh.slice(0, 20).map((row) =>
            `  ${row.id}  ${row.name}  [${row.groups.join(", ") || "no group"}]`,
          ).join("\n")}` : "") +
        "\n\nNothing was written. Re-run with --apply.",
    );
    return;
  }

  /**
   * A channel import fetches each profile, so the list is walked in batches —
   * `importYouTubeChannels()` caps a call at 50 and writes the shards at the
   * end of each one.
   */
  let added = 0;
  let existing = 0;
  const kinds = new Map<string, number>();
  const regions = new Map<string, number>();
  const notVirtual: { id: string; name: string; kind: string }[] = [];
  const failed: { id: string; reason: string }[] = [];

  for (let offset = 0; offset < batch.length; offset += options.batchSize) {
    const slice = batch.slice(offset, offset + options.batchSize);
    const result = await importYouTubeChannels(slice, {
      limit: options.batchSize,
      // vTubie's groups are a roster: every entry is filed as a performer.
      rosterIds: new Set(batch),
    });
    added += result.added.length;
    existing += result.existing;
    failed.push(...result.failed);
    for (const entry of result.added) {
      kinds.set(entry.kind, (kinds.get(entry.kind) ?? 0) + 1);
      regions.set(entry.region, (regions.get(entry.region) ?? 0) + 1);
      /**
       * vTubie lists a performer under a VTuber group, so a record that
       * classifies as **real** is worth a look: the channel's own description
       * may have outweighed the directory, which is exactly the disagreement
       * a person should settle.
       */
      if (entry.kind !== "virtual") {
        notVirtual.push({ id: entry.id, name: entry.name, kind: entry.kind });
      }
    }
    console.log(
      `import: ${Math.min(offset + options.batchSize, batch.length)}/${batch.length} · ` +
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
  console.log("\nRun `npm run data:index` next.");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
