import { readAllChannelRecords } from "./lib/dataset";
import { classifyChannel } from "./lib/classify";
import { REGION_TRUST } from "./lib/dedupe";
import { primaryPlatformOf } from "./lib/platforms";

const all = readAllChannelRecords();
const changes: string[] = [];
let same = 0;
for (const c of all) {
  const fresh = classifyChannel({
    name: c.name,
    description: c.description,
    tags: c.tags,
    country: c.country,
    platform: primaryPlatformOf(c) ?? undefined,
  });
  if (REGION_TRUST[fresh.regionSource] <= REGION_TRUST[c.regionSource ?? "unknown"]) continue;
  if (fresh.region === c.region) { same++; continue; }
  changes.push(`${c.region}(${c.regionSource}) → ${fresh.region}(${fresh.regionSource}) | ${c.name}`);
}
console.log(`changed: ${changes.length} · source-only: ${same}`);
const byMove: Record<string, number> = {};
for (const c of changes) {
  const key = c.split(" | ")[0]!;
  byMove[key] = (byMove[key] ?? 0) + 1;
}
console.log(Object.entries(byMove).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${v}\t${k}`).join("\n"));
const show = process.argv[2];
if (show) console.log(changes.filter((c) => c.includes(show)).slice(0, 30).join("\n"));
