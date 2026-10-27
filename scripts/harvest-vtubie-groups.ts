#!/usr/bin/env tsx
/**
 * Harvests vTubie's **groups** directory into a JSON file.
 *
 * The directory is a WordPress site behind a Cloudflare managed challenge, so
 * a plain `fetch` gets `403 Just a moment...`; only a client that runs the
 * challenge JavaScript sees the page. This script therefore drives a real
 * Chrome through `puppeteer-core`, then does every subsequent page read as a
 * same-origin `fetch` **inside** that page, so the clearance cookie the
 * challenge granted is sent with each request.
 *
 * Three passes, each resumable:
 *
 *   1. `listing`  `/groups/?pg=N` → the groups and their member counts
 *   2. `members`  `/g/<slug>/` → the member slugs of each group
 *   3. `profiles` `/<slug>/` → name, group, debut, status, Twitter and —
 *                 the point of the exercise — the YouTube `channel_id` from
 *                 the profile's RSS link
 *
 * Only the third pass costs anything close to the size of the directory, so
 * the state file lets a run stop and pick up where it left off.
 *
 *   npm run data:vtubie-groups
 *   npm run data:vtubie-groups -- --phase listing
 *   npm run data:vtubie-groups -- --phase members --limit 100
 *   npm run data:vtubie-groups -- --phase profiles --limit 500
 *   npm run data:vtubie-groups -- --pages 100-103
 *
 * Nothing here writes `data/`: it produces a reviewable snapshot in `.cache/`.
 * Adding the channels is a separate, gated step.
 */

import fs from "node:fs";
import path from "node:path";
import { findChrome } from "./lib/debut-sources/vtubie";
import {
  groupListingHasNext,
  parseGroupListing,
  parseGroupMembers,
  parseProfile,
} from "./lib/vtubie-directory";
import type { VtubieProfile } from "./lib/vtubie-directory";

const ORIGIN = "https://vtubie.com";
const LISTING_URL = `${ORIGIN}/groups/`;

/* -------------------------------------------------------------------------- */
/* The slice of puppeteer this script uses                                    */
/* -------------------------------------------------------------------------- */

interface PageLike {
  goto(
    url: string,
    options: { waitUntil: string; timeout: number },
  ): Promise<unknown>;
  title(): Promise<string>;
  evaluate<T>(fn: (url: string) => Promise<T>, url: string): Promise<T>;
  setViewport(viewport: { width: number; height: number }): Promise<void>;
  close(): Promise<void>;
}
interface BrowserLike {
  newPage(): Promise<PageLike>;
  close(): Promise<void>;
}

async function loadPuppeteer(): Promise<{
  launch(options: Record<string, unknown>): Promise<BrowserLike>;
} | null> {
  const specifier = "puppeteer-core";
  try {
    const mod = (await import(specifier)) as unknown as {
      default?: { launch?: unknown };
      launch?: unknown;
    };
    const api = mod.default ?? mod;
    return typeof api.launch === "function"
      ? (api as { launch: (o: Record<string, unknown>) => Promise<BrowserLike> })
      : null;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Options                                                                    */
/* -------------------------------------------------------------------------- */

interface Options {
  phase: "listing" | "members" | "profiles" | "all";
  /** First and last listing page, inclusive. */
  from: number;
  to: number;
  limit: number | null;
  delayMs: number;
  concurrency: number;
  headed: boolean;
  reset: boolean;
  /** Re-read groups whose stored member list disagrees with the card. */
  recheck: boolean;
  statePath: string;
  outPath: string;
  profileDir: string;
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    phase: "all",
    from: 1,
    to: 0,
    limit: null,
    delayMs: 900,
    concurrency: 1,
    headed: true,
    reset: false,
    recheck: false,
    statePath: ".cache/vtubie-groups-state.json",
    outPath: ".cache/vtubie-groups.json",
    profileDir: ".cache/vtubie-profile",
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const value = argv[i + 1];
    switch (arg) {
      case "--phase": {
        const next = (value ?? "").toLowerCase();
        if (!["listing", "members", "profiles", "all"].includes(next)) {
          console.error("unknown phase: " + next);
          process.exit(1);
        }
        options.phase = next as Options["phase"];
        i++;
        break;
      }
      case "--pages": {
        const [a, b] = (value ?? "").split("-");
        options.from = Math.max(1, Number(a ?? 1));
        options.to = Number(b ?? a ?? 0);
        i++;
        break;
      }
      case "--limit":
        options.limit = Math.max(1, Number(value ?? 1));
        i++;
        break;
      case "--delay":
        options.delayMs = Math.max(0, Number(value ?? options.delayMs));
        i++;
        break;
      case "--concurrency":
        options.concurrency = Math.max(1, Math.min(6, Number(value ?? 2)));
        i++;
        break;
      case "--state":
        options.statePath = value ?? options.statePath;
        i++;
        break;
      case "--out":
        options.outPath = value ?? options.outPath;
        i++;
        break;
      case "--headless":
        options.headed = false;
        break;
      case "--reset":
        options.reset = true;
        break;
      case "--recheck":
        options.recheck = true;
        break;
      case "--help":
      case "-h":
        console.log(
          [
            "Usage: npm run data:vtubie-groups -- [options]",
            "",
            "  --phase <listing|members|profiles|all>  which pass to run (default all)",
            "  --pages <a-b>        listing pages to read (default all, until the last)",
            "  --limit <n>          stop after n items in this pass",
            "  --delay <ms>         pause between requests (default 900 for profiles)",
            "  --concurrency <n>    parallel page reads, 1-6 (default 1: profile pages rate-limit)",
            "  --state <path>       resume file (default .cache/vtubie-groups-state.json)",
            "  --out <path>         snapshot written at the end",
            "  --headless           run without a window (Cloudflare usually refuses)",
            "  --reset              discard the state file and start over",
            "  --recheck            re-read groups whose member list disagrees with their card",
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
/* State                                                                      */
/* -------------------------------------------------------------------------- */

interface GroupState {
  slug: string;
  name: string;
  memberCount: number | null;
  videoCount: number | null;
  members: { slug: string; name: string }[] | null;
  readAt: string | null;
  /** Why the member list is empty, when the page itself was the problem. */
  unreadable?: "gone" | "empty" | "error";
}

interface State {
  startedAt: string;
  updatedAt: string;
  /** Listing pages already read. */
  pages: number[];
  /** Whether the listing walk reached its last page. */
  listingDone: boolean;
  /** Groups in listing order. */
  groups: GroupState[];
  /** Member profiles, keyed by slug. */
  profiles: Record<string, VtubieProfile & { fetchedAt: string }>;
}

function loadState(file: string, reset: boolean): State {
  if (!reset && fs.existsSync(file)) {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8")) as State;
    } catch {
      // A truncated state file is a half-written one; start again.
    }
  }
  const now = new Date().toISOString();
  return {
    startedAt: now,
    updatedAt: now,
    pages: [],
    listingDone: false,
    groups: [],
    profiles: {},
  };
}

function saveState(file: string, state: State): void {
  state.updatedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state));
}

/* -------------------------------------------------------------------------- */
/* The browser                                                                */
/* -------------------------------------------------------------------------- */

const CHALLENGE = /just a moment|請稍候|security verification|attention required/i;

/**
 * How long to leave the directory alone after it answers 429.
 *
 * Thirty profile pages at two a second was enough to earn one, so the profile
 * pass runs a slower gap; this is the second chance, not a retry loop.
 */
const COOLDOWN_MS = 120_000;

/** The ceiling the adaptive gap may grow to — one page every 10 s. */
const MAX_DELAY_MS = 10_000;

/**
 * Opens the origin and waits for the managed challenge to clear.
 *
 * The clearance is bound to the browser profile and the network, so a run
 * that reuses `--profile` usually finds it already solved and this returns in
 * a second. A hard block is reported rather than retried forever.
 */
async function warmUp(page: PageLike, log: (message: string) => void): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    await page
      .goto(`${ORIGIN}/groups/`, { waitUntil: "domcontentloaded", timeout: 60_000 })
      .catch(() => {});
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      const title = await page.title().catch(() => "");
      if (title && !CHALLENGE.test(title)) return true;
      await sleep(1_500);
    }
    log(
      `still on the Cloudflare challenge after 45s (attempt ${attempt + 1}/3)` +
        " — a datacenter IP or a fresh profile is usually why",
    );
  }
  return false;
}

/**
 * What one page read produced.
 *
 * The distinction matters: a **404** is an answer (the group or the profile is
 * gone), an **empty** body is a broken page (vTubie's `/g/independent/` — the
 * pseudo-group of all 13,940 independents — answers 200 with nothing in it),
 * and only a **blocked** read means the Cloudflare challenge has come back,
 * which is the one case worth stopping the whole pass for.
 */
type PageRead =
  | { kind: "ok"; html: string }
  | { kind: "gone" }
  | { kind: "empty" }
  | { kind: "blocked"; status: number }
  | { kind: "error"; status: number };

/**
 * Reads one URL as HTML from inside the page, so the clearance cookie rides
 * along.
 *
 * **The status alone cannot be trusted on this host.** `/dev/` answers `403`
 * with the complete profile (110 KB, `<title>DEV – vTubie</title>`) because a
 * WAF rule forbids the path, while a genuine rate limit answers `429` and a
 * challenge answers with the interstitial. So the decision is made on the
 * **body**: a page with document markup is a page, whatever the status says,
 * and the challenge is recognised by its own title rather than by the words
 * `challenge-platform` — every ordinary vTubie page carries a beacon for
 * `/cdn-cgi/challenge-platform/scripts/jsd/main.js` near its end.
 */
async function readPage(page: PageLike, url: string): Promise<PageRead> {
  const result = await page.evaluate(
    async (target: string) => {
      try {
        const response = await fetch(target, { credentials: "include" });
        return { status: response.status, text: await response.text() };
      } catch (error) {
        return { status: 0, text: String(error) };
      }
    },
    url,
  );

  const status = result?.status ?? 0;
  const text = result?.text ?? "";

  if (status === 0) return { kind: "error", status };

  const title = /<title>([\s\S]*?)<\/title>/i.exec(text)?.[1] ?? "";
  if (/just a moment|請稍候|attention required|security verification/i.test(title)) {
    return { kind: "blocked", status: 403 };
  }
  /** 429 and 503 are the site asking for less traffic, and carry no page. */
  if (status === 429 || status === 503) return { kind: "blocked", status };

  /**
   * A 404 still renders the site's "not found" template, so the status is
   * checked before the body: the page exists and says there is nothing here.
   */
  if (status === 404 || status === 410) return { kind: "gone" };

  if (!/<html|<body/i.test(text)) return { kind: "empty" };
  return { kind: "ok", html: text };
}

/** `blocked 403` — how a read failed, for the log. */
function describe(read: PageRead): string {
  return "status" in read ? `${read.kind} ${read.status}` : read.kind;
}

/* -------------------------------------------------------------------------- */
/* Passes                                                                     */
/* -------------------------------------------------------------------------- */

async function discoverGroups(
  page: PageLike,
  state: State,
  options: Options,
  log: (message: string) => void,
): Promise<void> {
  let pageNumber = options.from;
  let pagesRead = 0;

  while (!state.listingDone || pageNumber <= options.to) {
    if (options.to && pageNumber > options.to) break;
    if (state.pages.includes(pageNumber)) {
      pageNumber++;
      continue;
    }

    const url = `${LISTING_URL}?pg=${pageNumber}`;
    const read = await readPage(page, url);
    if (read.kind === "gone") {
      // Walked past the last page: the pager said there was another one.
      state.listingDone = true;
      log(`listing: ${url} is 404 — treating page ${pageNumber - 1} as the last`);
      break;
    }
    if (read.kind !== "ok") {
      log(`listing: ${url} — ${describe(read)}, stopping this pass`);
      break;
    }
    const html = read.html;

    const cards = parseGroupListing(html);
    let fresh = 0;
    for (const card of cards) {
      const known = state.groups.find((group) => group.slug === card.slug);
      if (known) {
        known.memberCount = card.memberCount ?? known.memberCount;
        known.videoCount = card.videoCount ?? known.videoCount;
        continue;
      }
      state.groups.push({ ...card, members: null, readAt: null });
      fresh++;
    }
    state.pages.push(pageNumber);
    pagesRead++;
    log(
      `listing: page ${pageNumber} → ${cards.length} groups` +
        (fresh === cards.length ? "" : `, ${fresh} new`) +
        ` (${state.groups.length} known)`,
    );

    if (!groupListingHasNext(html)) {
      state.listingDone = true;
      log(`listing: page ${pageNumber} is the last one`);
      break;
    }
    pageNumber++;
    if (options.limit !== null && pagesRead >= options.limit) break;
    await sleep(options.delayMs);
  }
}

async function readMembers(
  page: PageLike,
  state: State,
  options: Options,
  log: (message: string) => void,
): Promise<void> {
  /**
   * With `--recheck`, a group is read again when the list on disk cannot be
   * the one the card counted: the page was unreadable, or fewer members were
   * parsed than the card claims. A group that now lists *more* than its card
   * says is left alone — that is a former member the card no longer counts.
   */
  const pending = state.groups.filter((group) =>
    options.recheck
      ? group.members === null ||
        group.unreadable !== undefined ||
        (group.memberCount !== null && (group.members?.length ?? 0) < group.memberCount)
      : group.members === null,
  );
  const limit = options.limit === null ? pending.length : Math.min(options.limit, pending.length);
  log(`members: ${pending.length} group(s) without a member list, reading ${limit}`);

  let done = 0;
  let unreadable = 0;
  for (const group of pending.slice(0, limit)) {
    const url = `${ORIGIN}/g/${encodeURIComponent(group.slug)}/`;
    const read = await readPage(page, url);
    if (read.kind === "blocked") {
      log(`members: ${url} — ${describe(read)}, stopping this pass`);
      break;
    }
    if (read.kind !== "ok") {
      /**
       * A deleted group has no members, and a page vTubie itself cannot render
       * (the 13,940-member `Independent` pseudo-group is served empty) has none
       * this pass can read. Both are **recorded**, so the next run asks about
       * the rest of the directory instead of retrying the same page forever.
       */
      group.members = [];
      group.readAt = new Date().toISOString();
      group.unreadable = read.kind;
      unreadable++;
      done++;
      if (done % 25 === 0) saveState(options.statePath, state);
      await sleep(options.delayMs);
      continue;
    }
    group.members = parseGroupMembers(read.html);
    group.readAt = new Date().toISOString();
    done++;
    if (done % 25 === 0) {
      saveState(options.statePath, state);
      log(`members: ${done}/${limit} · ${uniqueMemberCount(state)} member(s) seen`);
    }
    await sleep(options.delayMs);
  }

  saveState(options.statePath, state);
  log(
    `members: read ${done}` +
      (unreadable ? `, ${unreadable} unreadable` : "") +
      `, ${uniqueMemberCount(state)} member(s) in total`,
  );
}

async function readProfiles(
  page: PageLike,
  state: State,
  options: Options,
  log: (message: string) => void,
): Promise<void> {
  const wanted = new Map<string, string>();
  for (const group of state.groups) {
    for (const member of group.members ?? []) {
      if (!wanted.has(member.slug)) wanted.set(member.slug, member.name);
    }
  }
  const pending = [...wanted.keys()].filter((slug) => !state.profiles[slug]);
  const limit = options.limit === null ? pending.length : Math.min(options.limit, pending.length);
  log(`profiles: ${pending.length} member(s) without a profile, reading ${limit}`);

  let done = 0;
  let failed = 0;
  let gone = 0;
  const startedAt = Date.now();
  /** Set when the directory stops answering, so every worker stops asking. */
  let blocked: number | null = null;
  const queue = pending.slice(0, limit);

  /** A few at a time: the directory is not ours to hammer. */
  const workers = Array.from({ length: Math.min(options.concurrency, queue.length) }, async () => {
    for (;;) {
      if (blocked !== null) return;
      const slug = queue.shift();
      if (!slug) return;
      const url = `${ORIGIN}/${encodeURIComponent(slug)}/`;
      let read = await readPage(page, url);

      /**
       * The directory pushes back under sustained reading, and says so twice:
       * a **429** means slow down, a **403** means the challenge is back.
       *
       * The rule in `AGENTS.md` is to back off and leave it alone, so this
       * does exactly that — the gap between pages doubles for the rest of the
       * pass, the challenge is allowed to re-solve itself, and the slug is
       * asked for once more. Only a refusal that survives all of that ends the
       * pass; the state file then carries the rest to the next run.
       */
      if (read.kind === "blocked" && read.status === 429) {
        options.delayMs = Math.min(MAX_DELAY_MS, Math.max(1_500, options.delayMs * 2));
        log(
          `profiles: ${url} — 429, slowing to one page every ` +
            `${(options.delayMs / 1_000).toFixed(1)}s for the rest of this pass`,
        );
        await sleep(COOLDOWN_MS);
        read = await readPage(page, url);
      }
      if (read.kind === "blocked" && read.status === 403) {
        log(`profiles: ${url} — 403, letting the challenge re-solve`);
        options.delayMs = Math.min(MAX_DELAY_MS, Math.max(2_000, options.delayMs * 2));
        const cleared = await warmUp(page, log);
        if (!cleared) {
          blocked = 403;
          log("profiles: the challenge did not clear, stopping this pass");
          return;
        }
        read = await readPage(page, url);
      }
      if (read.kind === "blocked") {
        blocked = read.status;
        log(`profiles: ${url} — ${describe(read)}, stopping this pass`);
        return;
      }
      if (read.kind === "gone" || read.kind === "empty") {
        /**
         * A profile vTubie no longer serves. It is remembered with its slug as
         * the name so a resume skips it, and marked so the report can count it
         * rather than quietly treating it as a performer.
         */
        gone++;
        state.profiles[slug] = {
          slug,
          name: slug,
          types: [],
          region: null,
          groups: [],
          debutDate: null,
          status: "deleted",
          twitter: null,
          youtubeId: null,
          gender: null,
          languages: [],
          description: null,
          subscribers: null,
          fetchedAt: new Date().toISOString(),
        };
        done++;
        await sleep(options.delayMs);
        continue;
      }
      if (read.kind === "error") {
        failed++;
        await sleep(options.delayMs * 2);
        continue;
      }
      const profile = parseProfile(read.html, slug);
      if (profile) {
        state.profiles[slug] = { ...profile, fetchedAt: new Date().toISOString() };
      } else {
        failed++;
      }
      done++;
      if (done % 25 === 0) {
        saveState(options.statePath, state);
        log(`profiles: ${done}/${limit} ·${eta(done, limit, startedAt)} · ${Object.keys(state.profiles).length} known`);
      }
      await sleep(options.delayMs);
    }
  });

  await Promise.all(workers);
  saveState(options.statePath, state);
  log(
    `profiles: read ${done}` +
      (gone ? `, ${gone} deleted` : "") +
      (failed ? `, ${failed} unparsed` : "") +
      (blocked !== null ? `, stopped on ${blocked}` : "") +
      `, ${Object.keys(state.profiles).length} in total`,
  );
}

/** ` at 1.4/s, 32 min left` — enough to tell a stuck run from a slow one. */
function eta(done: number, total: number, startedAt: number): string {
  const seconds = Math.max(1, (Date.now() - startedAt) / 1_000);
  const rate = done / seconds;
  if (!Number.isFinite(rate) || rate <= 0) return " rate unknown";
  const left = Math.max(0, total - done) / rate;
  const minutes = Math.round(left / 60);
  return ` ${rate.toFixed(1)}/s, ${minutes > 90 ? `${Math.round(minutes / 60)}h` : `${minutes} min`} left`;
}

/** Members a group page named, counted once across every group. */
function uniqueMemberCount(state: State): number {
  const slugs = new Set<string>();
  for (const group of state.groups) {
    for (const member of group.members ?? []) slugs.add(member.slug);
  }
  return slugs.size;
}

/** The reviewable snapshot. */
function writeSnapshot(state: State, outPath: string): void {
  const members = new Map<string, { slug: string; name: string; groups: string[] }>();
  for (const group of state.groups) {
    for (const member of group.members ?? []) {
      const existing = members.get(member.slug);
      if (existing) {
        if (!existing.groups.includes(group.name)) existing.groups.push(group.name);
        continue;
      }
      members.set(member.slug, {
        slug: member.slug,
        name: member.name,
        groups: [group.name],
      });
    }
  }

  const against = [...members.values()].map((member) => {
    const profile = state.profiles[member.slug];
    return {
      ...member,
      profile: profile
        ? {
            name: profile.name,
            types: profile.types,
            region: profile.region,
            groups: profile.groups,
            debutDate: profile.debutDate,
            status: profile.status,
            twitter: profile.twitter,
            youtubeId: profile.youtubeId,
            gender: profile.gender,
            languages: profile.languages,
            subscribers: profile.subscribers,
            description: profile.description,
          }
        : null,
    };
  });

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        source: "vtubie",
        origin: ORIGIN,
        listingPages: state.pages.length,
        listingDone: state.listingDone,
        groups: state.groups.map((group) => ({
          slug: group.slug,
          name: group.name,
          memberCount: group.memberCount,
          members: group.members?.length ?? null,
          ...(group.unreadable ? { unreadable: group.unreadable } : {}),
        })),
        profilesRead: Object.keys(state.profiles).length,
        members: against,
      },
      null,
      2,
    ),
  );
  console.log(
    `snapshot: ${outPath} · ${state.groups.length} groups · ` +
      `${against.length} members · ${Object.keys(state.profiles).length} profiles`,
  );
}

/* -------------------------------------------------------------------------- */

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const log = (message: string): void => console.log(message);

  const executablePath = findChrome();
  if (!executablePath) {
    console.error("No Chrome/Chromium found — set VTUBIE_CHROME_PATH.");
    process.exit(1);
  }
  const puppeteer = await loadPuppeteer();
  if (!puppeteer) {
    console.error("puppeteer-core is not installed — `npm i puppeteer-core`.");
    process.exit(1);
  }

  const state = loadState(options.statePath, options.reset);

  const browser = await puppeteer.launch({
    executablePath,
    headless: options.headed ? false : true,
    userDataDir: options.profileDir,
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-blink-features=AutomationControlled",
      "--window-size=1280,900",
    ],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    const ready = await warmUp(page, log);
    if (!ready) {
      console.error("vtubie: the challenge did not clear, nothing harvested");
      return;
    }

    if (options.phase === "listing" || options.phase === "all") {
      await discoverGroups(page, state, options, log);
      saveState(options.statePath, state);
    }
    if (options.phase === "members" || options.phase === "all") {
      await readMembers(page, state, options, log);
    }
    if (options.phase === "profiles" || options.phase === "all") {
      await readProfiles(page, state, options, log);
    }

    await page.close().catch(() => {});
    saveState(options.statePath, state);
    writeSnapshot(state, options.outPath);
  } finally {
    await browser.close().catch(() => {});
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
