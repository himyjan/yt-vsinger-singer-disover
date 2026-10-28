#!/usr/bin/env tsx
/**
 * Measures what the repository actually costs GitHub — the **history**, not
 * the working tree — and fails when it grows past a budget.
 *
 *   npm run repo:size
 *   npm run repo:size -- --max-mb 1024 --warn-mb 600
 *   npm run repo:size -- --repack        # also compress the reachable history
 *
 * `trackedRepoSize()` in `validate.ts` sums the files git tracks right now,
 * which is what a clone *checks out*. It is not what GitHub stores: every
 * rewrite of a shard adds a new blob, and a reset or an aborted rebase leaves
 * whole packs behind that no branch reaches. Only `git count-objects` sees
 * those, and only a checkout with the full history can be measured at all —
 * which is why this runs in its own workflow with `fetch-depth: 0` instead of
 * inside `data:validate`.
 *
 * `git gc` shrinks a clone, never the repository on GitHub, so no workflow can
 * reclaim the space remotely. What a scheduled run can do is notice the growth
 * before it becomes a rewrite.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DATA_DIR, ROOT, directorySize, formatBytes } from "./lib/io";

interface Options {
  maxMb: number;
  warnMb: number;
  repack: boolean;
}

interface TopLevel {
  bytes: number;
  blobs: number;
}

function git(args: string[], input?: string): string {
  return execFileSync("git", args, {
    cwd: ROOT,
    encoding: "utf8",
    input,
    maxBuffer: 512 * 1024 * 1024,
  });
}

function parseOptions(argv: string[]): Options {
  const options: Options = { maxMb: 1024, warnMb: 600, repack: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined) {
        console.error(`${arg} needs a value`);
        process.exit(2);
      }
      return value;
    };
    if (arg === "--max-mb") options.maxMb = Number(next());
    else if (arg === "--warn-mb") options.warnMb = Number(next());
    else if (arg === "--repack") options.repack = true;
    else if (arg === "--help" || arg === "-h") {
      console.log("usage: npm run repo:size -- [--max-mb N] [--warn-mb N] [--repack]");
      process.exit(0);
    } else {
      console.error(`unknown option ${arg}`);
      process.exit(2);
    }
  }
  return options;
}

/** `count-objects -v` reports sizes in KiB. */
function countObjects(): {
  looseCount: number;
  looseBytes: number;
  packedCount: number;
  packs: number;
  packBytes: number;
} {
  const fields = new Map<string, number>();
  for (const line of git(["count-objects", "-v"]).split("\n")) {
    const match = /^([a-z-]+):\s*(\d+)/.exec(line);
    if (match) fields.set(match[1], Number(match[2]));
  }
  return {
    looseCount: fields.get("count") ?? 0,
    looseBytes: (fields.get("size") ?? 0) * 1024,
    packedCount: fields.get("in-pack") ?? 0,
    packs: fields.get("packs") ?? 0,
    packBytes: (fields.get("size-pack") ?? 0) * 1024,
  };
}

/** Every object a ref can reach, with the type and raw size of each. */
function reachable(): {
  blobs: number;
  blobBytes: number;
  objects: number;
  byTop: Map<string, TopLevel>;
  largest: Array<{ bytes: number; path: string }>;
} {
  const paths = new Map<string, string>();
  const shas: string[] = [];
  for (const line of git(["rev-list", "--objects", "--all"]).split("\n")) {
    if (!line) continue;
    const space = line.indexOf(" ");
    const sha = space === -1 ? line : line.slice(0, space);
    shas.push(sha);
    if (space !== -1) paths.set(sha, line.slice(space + 1));
  }

  const report = {
    blobs: 0,
    blobBytes: 0,
    objects: 0,
    byTop: new Map<string, TopLevel>(),
    largest: [] as Array<{ bytes: number; path: string }>,
  };

  const check = git(
    ["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"],
    `${shas.join("\n")}\n`,
  );
  for (const line of check.split("\n")) {
    const [sha, type, size] = line.split(" ");
    if (!sha || !type) continue;
    report.objects++;
    if (type !== "blob") continue;
    const bytes = Number(size);
    if (!Number.isFinite(bytes)) continue;
    const file = paths.get(sha) ?? "(unnamed blob)";

    report.blobs++;
    report.blobBytes += bytes;
    const top = file.includes("/") ? file.slice(0, file.indexOf("/")) : file;
    const entry = report.byTop.get(top) ?? { bytes: 0, blobs: 0 };
    entry.bytes += bytes;
    entry.blobs++;
    report.byTop.set(top, entry);

    if (bytes > 512 * 1024) report.largest.push({ bytes, path: file });
  }

  report.largest.sort((a, b) => b.bytes - a.bytes);
  report.largest = report.largest.slice(0, 5);
  return report;
}

/**
 * What the reachable history compresses to when re-packed.
 *
 * Optional because it costs minutes on a large catalogue: it builds a pack of
 * every reachable object exactly as `git gc` would. The difference against
 * `size-pack` is what a `git gc --prune=now` would reclaim.
 */
function repackedBytes(shas: string[]): number {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "repo-size-"));
  try {
    git(["pack-objects", path.join(dir, "pack"), "--delta-base-offset", "-q"], `${shas.join("\n")}\n`);
    const pack = fs
      .readdirSync(dir)
      .filter((name) => name.endsWith(".pack"))
      .map((name) => fs.statSync(path.join(dir, name)).size);
    return pack.reduce((sum, bytes) => sum + bytes, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function commitsTouching(prefix: string): number {
  const count = git(["rev-list", "--count", "HEAD", "--", prefix]).trim();
  return Number(count) || 0;
}

function pad(value: string, width: number, left = false): string {
  return left ? value.padStart(width) : value.padEnd(width);
}

function main(): void {
  const options = parseOptions(process.argv.slice(2));
  const objects = countObjects();
  const reach = reachable();
  const stored = objects.packBytes + objects.looseBytes;
  const storedMb = stored / (1024 * 1024);
  const dataOnDisk = directorySize(DATA_DIR);
  const dataCommits = commitsTouching("data");
  const dataHistory = reach.byTop.get("data")?.bytes ?? 0;

  const rows: string[] = [];
  const say = (line = "") => {
    rows.push(line);
    console.log(line);
  };

  say("The repository GitHub stores — history, not the working tree");
  say();
  say(`  ${pad("stored (packs + loose)", 26)}${pad(formatBytes(stored), 12, true)}  ${objects.packs} pack${objects.packs === 1 ? "" : "s"}, ${objects.looseCount} loose objects`);
  say(`  ${pad("reachable history (raw)", 26)}${pad(formatBytes(reach.blobBytes), 12, true)}  ${reach.blobs} blobs of ${reach.objects} objects`);
  say(`  ${pad("compression", 26)}${pad(`${((stored / Math.max(reach.blobBytes, 1)) * 100).toFixed(1)} %`, 12, true)}  of the raw bytes — JSON shares a lot between snapshots`);
  say(`  ${pad("data/ on disk", 26)}${pad(formatBytes(dataOnDisk), 12, true)}  ${dataCommits} commits touch it, ${formatBytes(dataHistory)} of history (~${formatBytes(dataHistory / Math.max(dataCommits, 1))} per commit, raw)`);
  say();

  const tops = [...reach.byTop.entries()].sort((a, b) => b[1].bytes - a[1].bytes).slice(0, 8);
  say("  where the history went");
  for (const [top, entry] of tops) {
    say(`    ${pad(top, 28)}${pad(formatBytes(entry.bytes), 10, true)}${pad(`${entry.blobs} blobs`, 12, true)}`);
  }
  say();

  if (reach.largest.length) {
    say("  largest blobs ever committed");
    for (const blob of reach.largest) {
      say(`    ${pad(formatBytes(blob.bytes), 10, true)}  ${blob.path}`);
    }
    say();
  }

  const notes: string[] = [];
  if (storedMb > options.maxMb) {
    notes.push(
      `stored repository is ${formatBytes(stored)} — above the ${options.maxMb} MB budget. GitHub recommends under 1 GB, documents 10 GB of .git as its maximum, and refuses a push above 2 GB.`,
    );
  } else if (storedMb > options.warnMb) {
    notes.push(
      `stored repository is ${formatBytes(stored)} — above the ${options.warnMb} MB warning line.`,
    );
  }
  if (stored > reach.blobBytes * 0.5) {
    notes.push(
      "stored is over half the raw history: whole packs are sitting there that no ref reaches — a reset, an aborted rebase or a force-push left them. `git gc --prune=now` reclaims that space in a clone (GitHub does its own housekeeping).",
    );
  }
  if (objects.looseCount > 1000 || objects.looseBytes > 100 * 1024 * 1024) {
    notes.push(
      `${objects.looseCount} loose objects (${formatBytes(objects.looseBytes)}): an interrupted operation or an editor staging files. \`git gc\` folds them into a pack.`,
    );
  }
  if (options.repack) {
    const shas = git(["rev-list", "--objects", "--all"])
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split(" ")[0]);
    const reachablePack = repackedBytes(shas);
    say(`  reachable history re-packed   ${pad(formatBytes(reachablePack), 12, true)}  what \`git gc --prune=now\` would leave`);
    const reclaimed = stored - reachablePack;
    if (reclaimed > 10 * 1024 * 1024) {
      say(`  reclaimable                   ${pad(formatBytes(reclaimed), 12, true)}`);
    }
    say();
  }

  if (notes.length) {
    for (const note of notes) {
      console.log(`\n! ${note}`);
      if (process.env.GITHUB_ACTIONS === "true") {
        console.log(`::${storedMb > options.maxMb ? "error" : "warning"}::${note.replace(/\n/g, " ")}`);
      }
    }
    console.log();
  } else {
    say("  within budget.");
  }

  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) {
    const lines = [
      "## Repository size",
      "",
      "| | |",
      "| --- | --- |",
      `| stored (packs + loose) | ${formatBytes(stored)} |`,
      `| reachable history (raw) | ${formatBytes(reach.blobBytes)} |`,
      `| objects | ${reach.objects} reachable, ${objects.packedCount} packed |`,
      `| \`data/\` on disk | ${formatBytes(dataOnDisk)} over ${dataCommits} commits |`,
      "",
      ...notes.map((note) => `- ${note}`),
      notes.length ? "" : "- within budget.",
      "",
    ];
    fs.appendFileSync(summary, `${lines.join("\n")}\n`);
  }

  if (storedMb > options.maxMb) process.exitCode = 1;
}

main();
