#!/usr/bin/env tsx
/**
 * Copies the dataset into `public/data/` so that:
 *
 *  - the Vite dev server can serve it from `/data/...`;
 *  - `vite build` copies it into `dist/data/...`, which is what GitHub Pages
 *    publishes.
 *
 * This keeps the dataset as a first-class, versioned artefact of the
 * repository instead of hiding it inside a backend.
 */

import fs from "node:fs";
import path from "node:path";
import {
  DATA_DIR,
  PUBLIC_DATA_DIR,
  SIZE_BUDGET,
  directorySize,
  ensureDir,
  formatBytes,
} from "./lib/io";

function copyDir(from: string, to: string): number {
  let count = 0;
  ensureDir(to);
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (entry.isDirectory()) {
      count += copyDir(src, dest);
    } else if (entry.isFile() && entry.name.endsWith(".json")) {
      fs.copyFileSync(src, dest);
      count++;
    }
  }
  return count;
}

/**
 * GitHub Pages refuses a site larger than 1 GB, and the site is this copy of
 * the dataset plus about a megabyte of assets.
 *
 * That is a *different* ceiling from the repository's. The repository stores
 * every snapshot the dataset ever had; the site stores one. A repository can
 * therefore be ten times its own site and still be inside its limit — which is
 * why the capacity plan measures both, and why a deploy that fails on the size
 * check at the end of a build is the worst place to discover this.
 */
function checkSiteSize(dir: string): void {
  const bytes = directorySize(dir);
  const limit = SIZE_BUDGET.maxSiteBytes;
  if (bytes > limit) {
    throw new Error(
      `[prepare:public] public/data is ${formatBytes(bytes)}, and GitHub Pages will not publish a site over ${formatBytes(limit)}. ` +
        "Split the catalogue into volumes (`docs/DEPLOY.md` → *The capacity ladder*) rather than raising this limit.",
    );
  }
  if (bytes > limit * 0.75) {
    console.warn(
      `[prepare:public] public/data is ${formatBytes(bytes)} — ${Math.round((bytes / limit) * 100)}% of the ${formatBytes(limit)} GitHub Pages ceiling. Plan the volumes split.`,
    );
  }
}

function main(): void {
  if (!fs.existsSync(DATA_DIR)) {
    console.warn(
      "[prepare:public] data/ does not exist — run `npm run data:sync` first.",
    );
    return;
  }

  // Remove stale shards so the build never ships data that was pruned.
  if (fs.existsSync(PUBLIC_DATA_DIR)) {
    fs.rmSync(PUBLIC_DATA_DIR, { recursive: true, force: true });
  }

  const count = copyDir(DATA_DIR, PUBLIC_DATA_DIR);
  console.log(`[prepare:public] copied ${count} dataset file(s) to public/data/`);
  checkSiteSize(PUBLIC_DATA_DIR);
}

main();
