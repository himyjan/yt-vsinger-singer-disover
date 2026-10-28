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
 *   npm run data:bacharu-import -- --apply --search-names 200
 */

import fs from "node:fs";
import {
  readAllChannelRecords,
  rebuildChannelsManifest,
  refreshManifestChannelCounts,
  writeChannelShards,
} from "./lib/dataset";
import { deriveVariant, detectClipAccount, isFanAccountName, normalize } from "./lib/classify";
import { importYouTubeChannels, rosterGender } from "./lib/import-channels";
import { acquireRunLock } from "./lib/io";
import { isDistinctiveName } from "./lib/link-discovery";
import { applyChannelEdits } from "./lib/roster-fill";
import { canonicalAgency, COUNTRY_REGION, normalizeCountry } from "./lib/regions";
import { normalizeName } from "./lib/identity";
import { extractExternalLinks } from "./lib/twitch";
import { InnerTubeSource } from "./lib/youtubei";
import { namesAgree, parseBacharuDebut, rosterLanguageCodes } from "./lib/bacharu";
import type { BacharuVtuber } from "./lib/bacharu";
import type { Channel, Gender } from "./lib/types";

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
  /** The groups the roster lists as **current**; the former ones stay in `groups`. */
  currentGroups: string[];
  /** The languages the performer streams in, as dataset codes. */
  languages: string[];
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
    currentGroups: entry.groups
      .filter((group) => group.status !== "former")
      .map((group) => group.name),
    languages: rosterLanguageCodes(entry.languages),
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
  /**
   * Rows with **no YouTube link at all** to look for on YouTube by name.
   *
   * 47,630 of the roster's 109,828 rows carry neither a channel id nor a
   * handle: the roster knows the performer and not where they stream. A name
   * search can find the channel, but only under the same rule a name search
   * follows everywhere else — the channel's own title confirms the roster's
   * display name, the name is distinctive, and a clip or fan account that
   * carries the name is rejected. Ambiguity is a no: two candidates that both
   * match is not a link.
   */
  searchNames: number;
  /**
   * Fill the empty `agency` of the records the roster already tracks.
   *
   * 1,044 of the 1,332 tracked bacharu rows that belong to a group have no
   * agency, because the channel's own text never names it. The roster does,
   * and `canonicalAgency()` keeps one agency one string: every `Hololive`
   * variant is `hololive`, exactly as `AGENTS.md` requires.
   */
  agencies: boolean;
  /** Attempt the ids a previous run could not resolve, whatever their age. */
  retryDead: boolean;
  /**
   * Attach the links the roster publishes to the records it already tracks.
   *
   * `extractVtuber()` keeps `social.all` as `links` — Twitch, X, Instagram,
   * TikTok, Bilibili, Niconico, KICK, CHZZK, SOOP, VK and the performer's own
   * site — and the dataset's `externals` is where those belong. The harvester
   * collected them and no import ever wrote them; this is that pass. Nothing
   * already on a record is overwritten, and `externals.youtube` is never
   * written because the record **is** the channel.
   */
  links: boolean;
  /**
   * Fill the empty `region`, `debutDate` and `gender` of the records it
   * already tracks.
   *
   * The roster files every performer under a country, a debut and a gender,
   * and the profile publishes none of them reliably: YouTube states a country
   * it was told and a description rarely says when the channel started. The
   * region is written **only** where `classifyChannel()` decided nothing, and
   * the gender **only** where the text did not answer — a roster fills an
   * empty field, it never takes one back.
   */
  hints: boolean;
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    apply: false,
    limit: null,
    snapshotPath: ".cache/bacharu-vtubers.json",
    batchSize: 50,
    resolveHandles: 0,
    searchNames: 0,
    agencies: false,
    retryDead: false,
    links: false,
    hints: false,
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
      case "--search-names":
        options.searchNames = Math.max(1, Number(argv[i + 1] ?? 1));
        i++;
        break;
      case "--agencies":
        options.agencies = true;
        break;
      case "--retry-dead":
        options.retryDead = true;
        break;
      case "--links":
        options.links = true;
        break;
      case "--hints":
        options.hints = true;
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
            "  --search-names <n>     search YouTube for up to n rows that have no link at all",
            "  --agencies             fill the empty agency of tracked rows from their group",
            "  --retry-dead           try the ids a recent run could not resolve",
            "  --links                attach the social links of tracked rows (--links --apply)",
            "  --hints                fill the empty region, debut and gender of tracked rows",
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

/**
 * Whether a candidate channel is the performer a roster row names.
 *
 * The rule is `confirmsIdentity()`'s, read from the other side: there is no
 * record yet, so the roster's **display name** is what the channel's own
 * title has to match — in either direction, because the two sides decorate
 * differently (`雫るる_Official` and `雫るる`) — and the name has to be
 * distinctive enough to mean one performer.
 */
function nameConfirms(rosterName: string, candidateName: string): boolean {
  const roster = normalizeName(rosterName);
  const candidate = normalizeName(candidateName);
  if (!roster || !candidate || !isDistinctiveName(roster)) return false;
  if (roster === candidate) return true;
  return candidate.includes(roster) || roster.includes(candidate);
}

/**
 * Searches YouTube for the rows that carry no link at all.
 *
 * Each row costs one channel search and one profile read per candidate that
 * is not already tracked — a candidate's title is the evidence, and the search
 * result only gives an id. A row is accepted only when **exactly one**
 * candidate matches; two channels that both carry the name are an ambiguity,
 * not a link, and a clip or fan account that carries the name is a duplicate
 * of the performer rather than the performer.
 */
async function searchNames(
  source: InnerTubeSource,
  rows: Row[],
  lookup: Lookup,
  rosterNames: Map<string, string[]>,
  log: (message: string) => void,
): Promise<number> {
  let found = 0;
  let scanned = 0;
  for (const row of rows) {
    scanned++;
    const query = row.name.replace(/\s+/g, " ").trim();
    if (!nameConfirms(query, query)) {
      if (scanned % 25 === 0) log(`search: ${scanned}/${rows.length} · ${found} found`);
      continue;
    }
    const ids = await source.searchChannels(query, 6);
    const matches: string[] = [];
    for (const id of ids) {
      if (lookup.ids.has(id) || rosterNames.has(id)) continue;
      const profile = await source.profile(id, { about: false });
      if (!profile) continue;
      const title = profile.title ?? "";
      if (isFanAccountName(title)) continue;
      if (detectClipAccount(title, profile.description ?? null)) continue;
      if (!nameConfirms(row.name, title)) continue;
      matches.push(id);
    }
    if (matches.length === 1) {
      row.youtubeId = matches[0]!;
      row.verdict = "new";
      rosterNames.set(matches[0]!, [row.name]);
      found++;
      log(`  search: ${row.name} → ${matches[0]} (${scanned}/${rows.length})`);
    } else if (matches.length > 1) {
      log(`  search: ${row.name} → ${matches.length} candidates, skipped`);
    }
    if (scanned % 25 === 0) log(`search: ${scanned}/${rows.length} · ${found} found`);
  }
  log(`search: ${found} of ${rows.length} rows found a channel`);
  return found;
}

/**
 * The agency a roster group names, or `null`.
 *
 * A group is written the way its owner writes it — `NIJISANJI`,
 * `Nijisanji` and `NIJISANJI (main branch)` are one agency — so the name is
 * canonicalised before it is stored: `canonicalAgency()` folds the spellings
 * and the hololive branches, and a parenthetical branch is folded onto the
 * agency it belongs to. `hololive production` stays the parent company and
 * `holostars` a separate brand, exactly as `canonicalAgency()` defines them.
 * A group that matches nothing known is kept as written, because that is all
 * the roster states.
 */
function canonicalGroupAgency(name: string): string | null {
  const canonical = canonicalAgency(name);
  if (!canonical) return null;
  const branch = name.replace(/\s*\(.*?\)\s*$/, "").trim();
  return branch && branch !== name ? canonicalAgency(branch) : canonical;
}

/** One agency for a row, when its current groups agree on one. */
function agencyOfGroups(groups: string[]): string | null {
  const values = new Set<string>();
  for (const group of groups) {
    const agency = canonicalGroupAgency(group);
    if (agency) values.add(agency);
  }
  return values.size === 1 ? [...values][0]! : null;
}

/**
 * Fills the empty agency of the records the roster already tracks.
 *
 * Only empty ones, and only where the roster's own groups agree: an agency
 * the channel's title or description stated is a fact about the performer,
 * and a former group is not a current affiliation. `affiliation` follows the
 * agency to `group` where it said nothing either — a record with an agency
 * is not `independent`.
 */
function backfillAgencies(
  rows: Row[],
  records: Channel[],
  apply: boolean,
): { records: number; written: Channel[] } {
  const byId = new Map(records.map((record) => [record.id, record]));
  let touched = 0;
  const written: Channel[] = [];
  for (const row of rows) {
    if (!row.youtubeId) continue;
    const record = byId.get(row.youtubeId);
    if (!record || record.agency) continue;
    const agency = agencyOfGroups(row.currentGroups);
    if (!agency) continue;
    touched++;
    if (!apply) continue;
    record.agency = agency;
    if (record.affiliation === "unknown") record.affiliation = "group";
    written.push(record);
  }
  return { records: touched, written };
}

/* -------------------------------------------------------------------------- */
/* Links                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Addresses that identify a performer somewhere else.
 *
 * `extractExternalLinks()` also keeps every other address as `web:<n>`, which
 * is right for a description: a shop or a personal site is a link the
 * performer published. But it reads a *platform* address the same way, so
 * `https://twitter.com/name` yields both `twitter: name` and a `web:` entry
 * for the very same URL — and the "all links" block would render it twice.
 * The hosts below belong to the platform patterns, so their second reading is
 * dropped.
 */
const PLATFORM_HOSTS = [
  "twitter.com",
  "x.com",
  "twitch.tv",
  "instagram.com",
  "tiktok.com",
  "bilibili.com",
  "nicovideo.jp",
  "nico.ms",
  "kick.com",
  "chzzk.naver.com",
  "sooplive",
  "vk.com",
  "youtube.com",
  "youtu.be",
  "discord.gg",
  "discord.com",
  "open.spotify.com",
  "ci.me",
];

function isPlatformAddress(url: string): boolean {
  const folded = url.toLowerCase();
  return PLATFORM_HOSTS.some((host) => folded.includes(host));
}

/**
 * The links an entry publishes, as `externals` handles.
 *
 * One URL at a time, so that two links to the same host (`twitch.tv/a` and
 * `twitch.tv/b`) do not collapse into one the way a single joined string
 * would. The first link of a platform wins, which is the roster's own order:
 * `main` is listed before `alt`, and a clips channel is not the performer.
 */
function externalHandles(entry: BacharuVtuber): Record<string, string> {
  const urls: string[] = [];
  for (const link of entry.links) {
    /** A clips channel publishes the performer; it is not the performer. */
    if (link.role === "clips") continue;
    urls.push(link.url);
  }
  if (entry.social.twitter) urls.push(entry.social.twitter);
  if (entry.social.twitch) urls.push(entry.social.twitch);

  const out: Record<string, string> = {};
  const web: string[] = [];
  for (const url of urls) {
    const found = extractExternalLinks(url);
    /** The record **is** the YouTube channel; that link is not an external. */
    delete found.youtube;
    for (const [key, handle] of Object.entries(found)) {
      if (!handle) continue;
      if (key.startsWith("web:")) {
        if (!isPlatformAddress(handle) && !web.includes(handle)) web.push(handle);
        continue;
      }
      if (!out[key]) out[key] = handle;
    }
  }
  for (const [index, url] of web.entries()) out[`web:${index + 1}`] = url;
  return out;
}

/* -------------------------------------------------------------------------- */
/* Matching a roster row to a tracked record                                  */
/* -------------------------------------------------------------------------- */

interface MatchedRow {
  entry: BacharuVtuber;
  channel: Channel;
  name: string;
}

/**
 * The roster rows that name a channel the dataset already has.
 *
 * A row is matched by the `UC…` id it publishes, or — when it publishes only
 * an `@handle` — by the handle on the record, which is the same channel: a
 * handle is unique, and the record's handle came from the platform itself.
 *
 * A fan or clip row is never matched, even when its link points at a
 * performer: the roster files clip channels beside their subject, and the
 * links on such a row belong to the clip account.
 */
function matchRecords(
  entries: BacharuVtuber[],
  records: Channel[],
): MatchedRow[] {
  const byId = new Map<string, Channel>();
  for (const record of records) byId.set(record.id, record);
  const byHandle = new Map<string, Channel>();
  for (const record of records) {
    for (const platform of record.platforms) {
      if (platform.platform !== "youtube" || !platform.handle) continue;
      const handle = platform.handle.replace(/^@/, "").toLowerCase();
      if (!byHandle.has(handle)) byHandle.set(handle, record);
    }
  }

  const matched: MatchedRow[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (entry.redirectTo) continue;
    if (entry.visibility && entry.visibility !== "public") continue;
    const name = entry.name ?? entry.canonicalName ?? entry.id;
    if (isFanAccountName(name) || detectClipAccount(name, entry.description)) continue;

    const channel =
      (entry.youtubeId ? byId.get(entry.youtubeId) : undefined) ??
      (entry.youtubeHandle
        ? byHandle.get(entry.youtubeHandle.toLowerCase())
        : undefined);
    if (!channel || seen.has(channel.id)) continue;
    seen.add(channel.id);
    matched.push({ entry, channel, name });
  }
  return matched;
}

/* -------------------------------------------------------------------------- */
/* Links                                                                      */
/* -------------------------------------------------------------------------- */

interface LinkPlan {
  channel: Channel;
  name: string;
  fields: Record<string, string>;
}

/**
 * The tracked records that can take a link the roster publishes.
 *
 * Only fields the record does not have are planned: a link on the record was
 * read from the performer's own text, and a roster is not allowed to overrule
 * it.
 */
function planLinks(matched: MatchedRow[]): LinkPlan[] {
  const plans: LinkPlan[] = [];
  for (const { entry, channel, name } of matched) {
    const found = externalHandles(entry);
    const fields: Record<string, string> = {};
    for (const [key, handle] of Object.entries(found)) {
      if (!handle) continue;
      if (!channel.externals?.[key]) fields[key] = handle;
    }
    if (Object.keys(fields).length) plans.push({ channel, name, fields });
  }
  return plans;
}

/** Writes the planned links: an `externals` field per handle, never replaced. */
function writeLinks(plans: LinkPlan[], at: string): number {
  return applyChannelEdits(
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
    "bacharu-links",
    at,
  );
}

/* -------------------------------------------------------------------------- */
/* Hints                                                                      */
/* -------------------------------------------------------------------------- */

interface HintPlan {
  channel: Channel;
  name: string;
  /** `region` / `debutDate` / `gender`, and the value the roster states. */
  fields: Record<string, string>;
}

/**
 * The facts the roster states and the profile does not publish.
 *
 * `region` is the **scene** the roster files the performer in, and it only
 * fills a record the classifier could not place at all — a country YouTube
 * publishes, an agency, or kana already outrank it. `debutDate` and `gender`
 * are empty until a roster supplies them; the gender is then re-derived into
 * `variant`, because `female_vtuber` and `vtuber` are the same channel filed
 * under what the record knows.
 */
function planHints(matched: MatchedRow[]): HintPlan[] {
  const plans: HintPlan[] = [];
  for (const { entry, channel, name } of matched) {
    const fields: Record<string, string> = {};
    if (channel.region === "unknown") {
      for (const country of entry.countries) {
        const code = normalizeCountry(country);
        const region = code ? COUNTRY_REGION[code] : undefined;
        if (region) {
          fields.region = region;
          break;
        }
      }
    }
    if (!channel.debutDate) {
      const debut = parseBacharuDebut(entry.debut);
      if (debut) fields.debutDate = debut;
    }
    if (channel.gender === "unknown") {
      const gender = rosterGender(entry.gender);
      if (gender) fields.gender = gender;
    }
    if (Object.keys(fields).length) plans.push({ channel, name, fields });
  }
  return plans;
}

function writeHints(plans: HintPlan[], at: string): number {
  return applyChannelEdits(
    plans.map((plan) => ({
      id: plan.channel.id,
      update: (channel) => {
        let touched = false;
        const { region, debutDate, gender } = plan.fields;
        if (region && channel.region === "unknown") {
          channel.region = region as Channel["region"];
          touched = true;
        }
        if (debutDate && !channel.debutDate) {
          channel.debutDate = debutDate;
          touched = true;
        }
        if (gender && channel.gender === "unknown") {
          channel.gender = gender as Channel["gender"];
          channel.variant = deriveVariant(channel.role, channel.gender, channel.isAi);
          touched = true;
        }
        return touched;
      },
    })),
    "bacharu-hints",
    at,
  );
}

/**
 * The ids a recent run could not resolve.
 *
 * The roster is a historical census: of the first batch of rows it called
 * new, almost none still exist — YouTube answers `This channel does not
 * exist` for them. Asking again costs a request each and writes nothing, so a
 * failure is remembered for a week: long enough that a run does not repeat
 * the same dead ids, short enough that a channel that was briefly unavailable
 * comes back on its own. `--retry-dead` ignores the list.
 *
 * The list is **not** a dataset fact — it lives in `.cache/` beside the
 * snapshot, because it changes every run and would make every data commit a
 * diff.
 */
const DEAD_CACHE = ".cache/bacharu-dead.json";
const DEAD_DAYS = 7;

interface DeadEntry {
  /** When the id last failed to resolve. */
  at: string;
  reason: string;
}

function readDead(): Record<string, DeadEntry> {
  try {
    const raw = fs.readFileSync(DEAD_CACHE, "utf8");
    const parsed = JSON.parse(raw) as Record<string, DeadEntry>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function isRecentlyDead(
  dead: Record<string, DeadEntry>,
  id: string,
  now: number,
): boolean {
  const entry = dead[id];
  if (!entry?.at) return false;
  const at = Date.parse(entry.at);
  return Number.isFinite(at) && now - at < DEAD_DAYS * 86_400_000;
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

  /* --- the links and hints of tracked rows, when asked ------------------- */
  if (options.links || options.hints) {
    const matched = matchRecords(snapshot.vtubers, readAllChannelRecords());
    const at = new Date().toISOString();

    if (options.links) {
      const plans = planLinks(matched);
      const fields = new Map<string, number>();
      let handles = 0;
      for (const plan of plans) {
        for (const key of Object.keys(plan.fields)) {
          fields.set(key, (fields.get(key) ?? 0) + 1);
          handles++;
        }
      }
      console.log(
        `\nlinks: ${plans.length} tracked record(s) can take ${handles} handle(s) ` +
          `bacharu publishes and the dataset does not have:` +
          (fields.size
            ? `\n  ${[...fields.entries()]
                .sort((a, b) => b[1] - a[1])
                .map(([key, count]) => `${count} ${key}`)
                .join(" · ")}`
            : ""),
      );
      for (const plan of plans.slice(0, 10)) {
        console.log(
          `  ${plan.name} → ${Object.entries(plan.fields)
            .map(([key, handle]) => `${key}:${handle}`)
            .join(", ")}`,
        );
      }
      if (plans.length > 10) console.log(`  … ${plans.length - 10} more`);
      if (options.apply) {
        const written = writeLinks(plans, at);
        console.log(`${written} record(s) had their externals filled from bacharu`);
      }
    }

    if (options.hints) {
      const plans = planHints(matched);
      const fields = new Map<string, number>();
      for (const plan of plans) {
        for (const key of Object.keys(plan.fields)) {
          fields.set(key, (fields.get(key) ?? 0) + 1);
        }
      }
      console.log(
        `\nhints: ${plans.length} tracked record(s) can take ` +
          `${[...fields.entries()].map(([key, count]) => `${count} ${key}`).join(" · ")} ` +
          `that bacharu states and the record does not:`,
      );
      for (const plan of plans.slice(0, 10)) {
        console.log(
          `  ${plan.name} → ${Object.entries(plan.fields)
            .map(([key, value]) => `${key}:${value}`)
            .join(", ")}`,
        );
      }
      if (plans.length > 10) console.log(`  … ${plans.length - 10} more`);
      if (options.apply) {
        const written = writeHints(plans, at);
        console.log(`${written} record(s) had their region, debut or gender filled from bacharu`);
      }
    }

    if (!options.apply) {
      console.log("\nNothing was written. Re-run with --apply.");
    }
    return;
  }

  if (options.agencies && !options.apply) {
    const preview = backfillAgencies(rows, readAllChannelRecords(), false);
    console.log(
      `\n${preview.records} tracked record(s) have no agency and a roster group names one.`,
    );
  }

  if (!options.apply) {
    const deadNow = readDead();
    const deadFresh = fresh.filter(
      (row) => row.youtubeId && isRecentlyDead(deadNow, row.youtubeId, Date.now()),
    ).length;
    console.log(
      `\n${fresh.length} channel(s) with an id would be imported` +
        (deadFresh
          ? `, but ${deadFresh} of them failed to resolve in the last ${DEAD_DAYS} days and are skipped`
          : "") +
        (options.limit !== null ? `, the first ${options.limit} of them per run` : "") +
        (fresh.length ? `:\n${fresh.slice(0, 20).map((row) =>
            `  ${row.youtubeId}  ${row.name}  [${row.groups[0] ?? "no group"}]`,
          ).join("\n")}` : "") +
        (counts.get("handle-only")
          ? `\n\n${counts.get("handle-only")} row(s) carry only an @handle; ` +
            "`--resolve-handles <n>` resolves them into imports."
          : "") +
        (counts.get("no-youtube")
          ? `\n${counts.get("no-youtube")} row(s) carry no YouTube link at all; ` +
            "`--search-names <n>` searches YouTube for them and accepts only " +
            "a single, distinctive, non-fan match."
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

  /* --- search for the rows with no link at all, when asked --------------- */
  const searchRows = rows
    .filter((row) => row.verdict === "no-youtube")
    .slice(0, options.searchNames);
  if (searchRows.length > 0) {
    const source = new InnerTubeSource({ delayMs: 150 });
    const ready = await source.connect();
    if (!ready) {
      console.error("InnerTube is unavailable — no name search was made.");
    } else {
      await searchNames(source, searchRows, lookup, rosterNames, (message) =>
        console.log(message),
      );
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

  /**
   * What the roster states and the profile cannot: the agency its groups
   * name, and the state it files the performer in.
   */
  const agency: Record<string, string> = {};
  const activity: Record<string, "active" | "preparing" | "graduated"> = {};
  /**
   * The languages the roster states, per channel — the **request** language.
   *
   * A channel that published an English localization answers InnerTube's
   * default with an English title and description even though the performer
   * streams in Japanese or Thai. The roster knows the language, so the
   * profile is asked for in it and the stored description is the performer's
   * own.
   */
  const languages: Record<string, string[]> = {};
  /**
   * The debut date and the gender the roster states, per channel.
   *
   * The profile publishes neither: a channel's description may mention the
   * debut, but the roster files the performer by it, and `RosterHint` takes
   * both as a fallback — `classifyChannel()` still decides the gender from
   * the text where the text answers, and a date that is not a date
   * (`parseBacharuDebut()`) is not written.
   */
  const debut: Record<string, string> = {};
  const gender: Record<string, Gender> = {};
  const byRosterId = new Map(snapshot.vtubers.map((entry) => [entry.id, entry]));
  for (const row of rows) {
    if (!row.youtubeId || row.verdict === "fan" || row.verdict === "hidden") continue;
    const name = agencyOfGroups(row.currentGroups);
    if (name) agency[row.youtubeId] = name;
    if (row.languages.length) languages[row.youtubeId] = row.languages;
    if (row.status === "active" || row.status === "preparing" || row.status === "graduated") {
      activity[row.youtubeId] = row.status;
    }
    const entry = byRosterId.get(row.id);
    const date = parseBacharuDebut(entry?.debut);
    if (date) debut[row.youtubeId] = date;
    const stated = rosterGender(entry?.gender);
    if (stated) gender[row.youtubeId] = stated;
  }

  const batchSize = options.batchSize;
  /**
   * An id YouTube no longer has is not worth a request a week later, let
   * alone a week later in every run.
   */
  const dead = readDead();
  const known = Date.now();
  const live = options.retryDead
    ? ids
    : ids.filter((id) => !isRecentlyDead(dead, id, known));
  const skipped = ids.length - live.length;
  if (skipped) {
    console.log(`${skipped} id(s) recently failed to resolve — skipped (--retry-dead retries).`);
  }
  const pending = options.limit === null ? live : live.slice(0, options.limit);
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
      rosterHint: { agency, activity, languages, debut, gender },
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

  const at = new Date().toISOString();
  for (const failure of failed) {
    if (failure.reason !== "the channel did not resolve") continue;
    dead[failure.id] = { at, reason: failure.reason };
  }
  fs.writeFileSync(DEAD_CACHE, JSON.stringify(dead, null, 0));

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
  if (options.agencies) {
    const now = new Date().toISOString();
    const release = acquireRunLock("bacharu-agencies");
    try {
      const all = readAllChannelRecords();
      const filled = backfillAgencies(rows, all, true);
      if (filled.records) {
        writeChannelShards(all, now);
        rebuildChannelsManifest(all, now);
        refreshManifestChannelCounts(all, now);
      }
      console.log(`${filled.records} record(s) had their agency filled from the roster.`);
    } finally {
      release();
    }
  }

  console.log("\nRun `npm run data:index` next.");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
