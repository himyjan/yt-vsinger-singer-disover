// Merge all volume shards under .volumes/vol-*/data/ back into data/
// Volumes are disjoint subsets, so channel/item shard files don't overlap.
// Only live.json and upcoming.json need array merging.
// Shared files (overrides, seed catalog, etc.) are copied from vol-0.
import fs from "node:fs";
import path from "node:path";

const count = Number((process.argv.find((a) => a.startsWith("--count=")) ?? "").split("=")[1]) || 10;
const root = process.cwd();
const volRoot = path.join(root, ".volumes");
const dataRoot = path.join(root, "data");

function readJson<T>(file: string): T | null {
  try { return JSON.parse(fs.readFileSync(file, "utf8")) as T; } catch { return null; }
}
function writeJson<T>(file: string, data: T): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n", "utf8");
}
function copyFile(src: string, dst: string): void {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}

function main(): void {
  const volDirs: string[] = [];
  for (let i = 0; i < count; i++) {
    const d = path.join(volRoot, "vol-" + i, "data");
    if (fs.existsSync(d)) volDirs.push(d);
  }
  if (volDirs.length === 0) { console.error("No volumes found"); process.exit(1); }
  console.log("Merging", volDirs.length, "volumes");

  // Shared files from vol-0
  for (const f of ["overrides.json", "seed-catalog.json", "suggestions.json", "upstream.json"]) {
    const src = path.join(volDirs[0], f);
    if (fs.existsSync(src)) copyFile(src, path.join(dataRoot, f));
  }

  // Copy channel shards from each volume (disjoint subsets)
  let chCount = 0;
  for (const volDir of volDirs) {
    const chRoot = path.join(volDir, "channels");
    if (!fs.existsSync(chRoot)) continue;
    for (const kind of fs.readdirSync(chRoot)) {
      const kindDir = path.join(chRoot, kind);
      if (!fs.statSync(kindDir).isDirectory()) continue;
      for (const region of fs.readdirSync(kindDir)) {
        const regionDir = path.join(kindDir, region);
        if (!fs.statSync(regionDir).isDirectory()) continue;
        for (const file of fs.readdirSync(regionDir)) {
          if (!file.endsWith(".json")) continue;
          copyFile(path.join(regionDir, file), path.join(dataRoot, "channels", kind, region, file));
          chCount++;
        }
      }
    }
  }
  console.log("Copied", chCount, "channel shards");

  // Copy item shards (disjoint except live.json/upcoming.json)
  let itCount = 0;
  const liveItems: any[] = [];
  const upcomingItems: any[] = [];
  for (const volDir of volDirs) {
    const itRoot = path.join(volDir, "items");
    if (!fs.existsSync(itRoot)) continue;
    for (const file of fs.readdirSync(itRoot)) {
      if (!file.endsWith(".json")) continue;
      if (file === "live.json" || file === "upcoming.json") {
        const p = readJson<{ items?: any[] }>(path.join(itRoot, file));
        if (p?.items) {
          if (file === "live.json") liveItems.push(...p.items);
          else upcomingItems.push(...p.items);
        }
      } else {
        copyFile(path.join(itRoot, file), path.join(dataRoot, "items", file));
        itCount++;
      }
    }
  }
  // Write merged live.json and upcoming.json (preserve compact format from vol-0)
  const vol0Live = readJson<{ schemaVersion?: number }>(path.join(volDirs[0], "items", "live.json"));
  const vol0Upcoming = readJson<{ schemaVersion?: number }>(path.join(volDirs[0], "items", "upcoming.json"));
  writeJson(path.join(dataRoot, "items", "live.json"), {
    schemaVersion: vol0Live?.schemaVersion ?? 1,
    generatedAt: new Date().toISOString(),
    items: liveItems,
  });
  writeJson(path.join(dataRoot, "items", "upcoming.json"), {
    schemaVersion: vol0Upcoming?.schemaVersion ?? 1,
    generatedAt: new Date().toISOString(),
    items: upcomingItems,
  });
  console.log("Copied", itCount, "item shards");
  console.log("Merged live:", liveItems.length, "upcoming:", upcomingItems.length);
  console.log("Done. Run npm run data:index to rebuild search index.");
}

main();
