/**
 * Which volume(s) own these ids.
 *
 * `data:volumes` splits the catalogue by `volumeOf(id)`, so a targeted run
 * (`data:details --id UC…`) only has work to do in the volume that holds the
 * record. Without this, a targeted run would start all twenty volume jobs and
 * nineteen of them would find nothing — a checkout and an install each, for
 * one record.
 *
 *   npx oxnode scripts/volume-of.ts 20 UC…,UC…
 *   → [7]
 *
 * With no id it prints every volume, which is what the bulk pass wants.
 */
import { parseVolumeCount, volumeOf } from "./lib/volume";

const count = parseVolumeCount(process.argv[2]);
const ids = process.argv
  .slice(3)
  .flatMap((value) => value.split(","))
  .map((id) => id.trim())
  .filter(Boolean);

if (!ids.length) {
  console.log(JSON.stringify(Array.from({ length: count }, (_, index) => index)));
} else {
  const volumes = [...new Set(ids.map((id) => volumeOf(id, count)))].sort(
    (a, b) => a - b,
  );
  console.log(JSON.stringify(volumes));
}
