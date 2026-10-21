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
import { DATA_DIR, PUBLIC_DATA_DIR, ensureDir } from "./lib/io";

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
}

main();
