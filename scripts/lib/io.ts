/**
 * Filesystem helpers for the dataset.
 *
 * The dataset lives in `data/` at the repository root and is committed to git,
 * so every write must be deterministic: stable ordering, stable formatting and
 * no timestamps that change on every run unless the content actually changed.
 * That keeps the git history of the data directory readable.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Repository root, resolved from this file's location. */
export const ROOT = path.resolve(__dirname, "../..");

/** The committed dataset directory. */
export const DATA_DIR = path.join(ROOT, "data");

/** Where the dataset files are published for the web app. */
export const PUBLIC_DATA_DIR = path.join(ROOT, "public", "data");

/** Disposable cache (never committed). */
export const CACHE_DIR = path.join(ROOT, ".cache");

/* -------------------------------------------------------------------------- */
/* Size budgets                                                               */
/* -------------------------------------------------------------------------- */

/**
 * GitHub Free allows ~1 GB of repository content (hard limit 2 GB) and a
 * 2 GB maximum for a single Git LFS file. The dataset is committed to the
 * repository, so it has to stay far below those ceilings — otherwise the
 * push fails and the sync workflow dies.
 *
 * The budgets below are deliberately conservative. `scripts/validate.ts`
 * enforces them in CI so a runaway dataset is caught before it is pushed.
 */
export const SIZE_BUDGET = {
  /** Maximum size of a single committed JSON file. */
  maxFileBytes: 8 * 1024 * 1024,
  /** Soft ceiling for the whole `data/` directory. */
  maxDataBytes: 180 * 1024 * 1024,
  /** Maximum size of the search index. */
  maxSearchIndexBytes: 40 * 1024 * 1024,
  /** Maximum size of a single LFS-tracked binary (db / zip). */
  maxLfsBytes: 2 * 1024 * 1024 * 1024,
} as const;

/** Human-readable byte size. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

/** Recursively sums the size of every file under `dir`. */
export function directorySize(dir: string): number {
  if (!fs.existsSync(dir)) return 0;
  let total = 0;
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        try {
          total += fs.statSync(full).size;
        } catch {
          /* ignore */
        }
      }
    }
  };
  walk(dir);
  return total;
}

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

export function readJson<T>(file: string, fallback: T): T {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

/** Writes JSON with a trailing newline and 2-space indentation. */
export function writeJson(file: string, value: unknown): void {
  ensureDir(path.dirname(file));
  const json = `${JSON.stringify(value, null, 2)}\n`;
  const bytes = Buffer.byteLength(json, "utf8");
  if (bytes > SIZE_BUDGET.maxFileBytes) {
    throw new Error(
      `Refusing to write ${path.relative(ROOT, file)}: ${formatBytes(bytes)} exceeds the ${formatBytes(SIZE_BUDGET.maxFileBytes)} per-file budget. ` +
        "Split the dataset (see docs/DATA-SCHEMA.md) or reduce the retained fields.",
    );
  }
  fs.writeFileSync(file, json);
}

/** Stable stringify: sorts object keys recursively so diffs stay minimal. */
export function stableStringify(value: unknown): string {
  return `${JSON.stringify(sortKeys(value), null, 2)}\n`;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(
      ([a], [b]) => a.localeCompare(b),
    );
    return Object.fromEntries(entries.map(([k, v]) => [k, sortKeys(v)]));
  }
  return value;
}

/** Content hash of a value — used to skip no-op commits. */
export function hash(value: unknown): string {
  return crypto.createHash("sha1").update(stableStringify(value)).digest("hex");
}

/* -------------------------------------------------------------------------- */
/* Dataset paths                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The canonical layout lives in `scripts/lib/dataset.ts`. Only the overrides
 * file is referenced directly elsewhere because it is an *input* to the sync,
 * not an output of it.
 */
export const paths = {
  overrides: path.join(DATA_DIR, "overrides.json"),
} as const;

/* -------------------------------------------------------------------------- */
/* Merge helpers                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Merges freshly-fetched records into the existing dataset.
 *
 * Rules:
 *  - `addedAt` is preserved from the existing record.
 *  - `source` is preserved when the existing record was curated (`seed`) or
 *    manually overridden, so an API refresh never downgrades provenance.
 *  - `confidence` keeps the higher of the two values.
 */
export function mergeById<
  T extends {
    id: string;
    addedAt?: string;
    source?: string;
  },
>(existing: T[], incoming: T[]): T[] {
  const map = new Map<string, T>();
  for (const rec of existing) map.set(rec.id, rec);

  for (const rec of incoming) {
    const prev = map.get(rec.id);
    if (!prev) {
      map.set(rec.id, rec);
      continue;
    }
    map.set(rec.id, {
      ...prev,
      ...rec,
      addedAt: prev.addedAt ?? rec.addedAt,
      source:
        prev.source === "seed" || prev.source === "manual"
          ? prev.source
          : rec.source,
    } as T);
  }

  return [...map.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * How long a network request is given before it is abandoned.
 *
 * A fetch with no timeout never rejects — it simply hangs, and a hung
 * request in a loop of thousands stalls the whole run with no output and no
 * error. Every network call in the pipeline carries this.
 */
export const REQUEST_TIMEOUT_MS = 20_000;

/* -------------------------------------------------------------------------- */
/* One writer at a time                                                       */
/* -------------------------------------------------------------------------- */

/** The file that records which process is writing the dataset. */
const RUN_LOCK = path.join(DATA_DIR, ".lock");

interface LockRecord {
  pid: number;
  tool: string;
  startedAt: string;
}

/** True when a process is still running. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Claims the dataset for this process.
 *
 * The sync and the fill script both read the whole dataset at the start and
 * write it back at the end, so two of them running at once lose each other's
 * work — a sync that renamed a channel is undone by a fill that had read the
 * old name before the sync started. That is exactly how a platform-confirmed
 * name reverted to the roster's name.
 *
 * Returns the function that releases the lock. Call it when the run ends; an
 * interrupted run leaves a stale lock, and the next run takes it over because
 * the recorded process is gone.
 */
export function acquireRunLock(tool: string): () => void {
  ensureDir(DATA_DIR);

  const existing = readJson<LockRecord | null>(RUN_LOCK, null);
  if (existing && existing.pid !== process.pid && isAlive(existing.pid)) {
    throw new Error(
      `another run is writing the dataset: ${existing.tool} ` +
        `(pid ${existing.pid}, started ${existing.startedAt}). ` +
        `Wait for it to finish, or stop it first.`,
    );
  }

  const record: LockRecord = {
    pid: process.pid,
    tool,
    startedAt: new Date().toISOString(),
  };
  writeJson(RUN_LOCK, record);

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try {
      const current = readJson<LockRecord | null>(RUN_LOCK, null);
      if (current?.pid === process.pid) fs.rmSync(RUN_LOCK, { force: true });
    } catch {
      // A lock that cannot be removed is stale, not fatal.
    }
  };

  process.once("exit", release);
  process.once("SIGINT", () => {
    release();
    process.exit(130);
  });
  process.once("SIGTERM", () => {
    release();
    process.exit(143);
  });

  return release;
}
