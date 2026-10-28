/**
 * Volumes: the split of the catalogue that happens when one repository is no
 * longer enough.
 *
 * A **shard** is a slice of one run's work — it rotates, and a channel is
 * refreshed every few days. A **volume** is a slice of the dataset itself: it
 * is permanent, and a channel lives in exactly one of them. That is what makes
 * a split safe, because the two things a split must never do are lose a record
 * and move one between repositories without deleting the copy it left behind.
 *
 * The assignment is **rendezvous hashing** (also called highest random
 * weight): every record scores the same id against every volume, and it goes
 * to the one that scores highest.
 *
 *   volumeOf(id, N) = argmax_i hash(id, i)
 *
 * The property that matters is what happens when `N` grows. With `hash % N`,
 * going from 4 volumes to 5 remaps about 80 % of the catalogue — a split that
 * has to move almost everything is not a split, it is a rewrite of every
 * repository at once. Rendezvous remaps about `1/(N+1)`: adding a fifth volume
 * moves one channel in five, and never moves a channel between the four that
 * already exist. That is the invariant `docs/DEPLOY.md` states and
 * `scripts/split-volumes.ts` verifies.
 *
 * Nothing here touches the filesystem or the network: the function is pure, so
 * the same id lands in the same volume on every machine, in every run, and in
 * the browser when it has to fetch from the right origin.
 */

/* -------------------------------------------------------------------------- */
/* Hashing                                                                     */
/* -------------------------------------------------------------------------- */

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

function fnv1a(text: string): number {
  let hash = FNV_OFFSET;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
  }
  return hash >>> 0;
}

/**
 * A 32-bit avalanche over an FNV-1a hash.
 *
 * FNV-1a alone is a poor comparison key: changing the last character of the
 * input mostly changes the low bits, so `argmax` over raw FNV hashes is close
 * to a comparison of the input's last character. Rendezvous hashing needs the
 * whole word to be well spread, so the hash is finished with a mixer first.
 */
function mix(hash: number): number {
  let h = hash >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * The weight a volume gives a record. Exported because the split tool prints
 * the ranking when it explains a surprising assignment.
 */
export function volumeScore(id: string, index: number): number {
  return mix(fnv1a(`${id}#${index}`));
}

/* -------------------------------------------------------------------------- */
/* Assignment                                                                  */
/* -------------------------------------------------------------------------- */

/** Upper bound on volumes. Beyond this the URL list dwarfs the data. */
export const MAX_VOLUMES = 64;

/**
 * The volume a channel id belongs to. Pure: same id, same count, same answer,
 * on every machine.
 */
export function volumeOf(id: string, count: number): number {
  if (count <= 1) return 0;
  const limit = Math.min(count, MAX_VOLUMES);
  let best = 0;
  let bestScore = volumeScore(id, 0);
  for (let index = 1; index < limit; index++) {
    const score = volumeScore(id, index);
    if (score > bestScore) {
      best = index;
      bestScore = score;
    }
  }
  return best;
}

/** The directory / repository name of a volume: `vol-0`, `vol-1`, … */
export function volumeName(index: number): string {
  return `vol-${index}`;
}

/** `vol-3` → `3`; anything else → `null`. */
export function volumeIndexOf(name: string): number | null {
  const match = /^vol-(\d+)$/.exec(name);
  if (!match) return null;
  const index = Number(match[1]);
  return Number.isInteger(index) && index >= 0 && index < MAX_VOLUMES
    ? index
    : null;
}

/** Parses `--count`; `auto` and anything unusable mean "one". */
export function parseVolumeCount(value: string | undefined): number {
  const raw = (value ?? "").trim();
  if (!raw || raw === "auto") return 1;
  const count = Number(raw);
  if (!Number.isInteger(count) || count < 1) return 1;
  return Math.min(count, MAX_VOLUMES);
}

/* -------------------------------------------------------------------------- */
/* Planning                                                                    */
/* -------------------------------------------------------------------------- */

export interface VolumeSlice<T> {
  index: number;
  name: string;
  records: T[];
}

/**
 * Groups records into `count` slices, in volume order.
 *
 * The records keep the order they were read in, so a plan is diffable: the
 * same dataset produces the same file layout, and adding a volume only moves
 * the records that changed volume.
 */
export function planVolumes<T>(
  records: T[],
  count: number,
  idOf: (record: T) => string,
): VolumeSlice<T>[] {
  const slices: VolumeSlice<T>[] = Array.from({ length: count }, (_, index) => ({
    index,
    name: volumeName(index),
    records: [],
  }));
  for (const record of records) {
    slices[volumeOf(idOf(record), count)].records.push(record);
  }
  return slices;
}

/**
 * How many volumes the catalogue needs to fit a per-repository budget.
 *
 * Rendezvous is not a balanced split — it is a *stable* one — so the answer is
 * computed from the real assignment rather than from a byte count divided by
 * N. The loop stops as soon as every slice fits.
 */
export function volumesNeeded(
  byteSizes: { id: string; bytes: number }[],
  budgetBytes: number,
  max = MAX_VOLUMES,
): number {
  let best = max;
  for (let count = 1; count <= max; count++) {
    const totals = new Array<number>(count).fill(0);
    for (const { id, bytes } of byteSizes) totals[volumeOf(id, count)] += bytes;
    if (Math.max(...totals) <= budgetBytes) {
      best = count;
      break;
    }
  }
  return best;
}

/* -------------------------------------------------------------------------- */
/* Guarantees                                                                  */
/* -------------------------------------------------------------------------- */

export interface PartitionProblem {
  id: string;
  message: string;
}

/**
 * Checks a materialised split against the rules the ladder states.
 *
 * It takes the ids that *should* exist and the ids found in each volume
 * directory, because a verification that only looked at the volumes would
 * happily accept a split that lost a million records.
 */
export function checkPartition(
  expected: string[],
  found: Map<number, string[]>,
  count: number,
): PartitionProblem[] {
  const problems: PartitionProblem[] = [];
  const seen = new Map<string, number>();

  for (const [index, ids] of found) {
    for (const id of ids) {
      const previous = seen.get(id);
      if (previous !== undefined) {
        problems.push({
          id,
          message:
            previous === index
              ? `appears twice in ${volumeName(index)}`
              : `appears in both ${volumeName(previous)} and ${volumeName(index)}`,
        });
        continue;
      }
      seen.set(id, index);
      const expectedIndex = volumeOf(id, count);
      if (expectedIndex !== index) {
        problems.push({
          id,
          message: `is in ${volumeName(index)} but volumeOf() names ${volumeName(expectedIndex)}`,
        });
      }
    }
  }

  for (const id of expected) {
    if (!seen.has(id)) problems.push({ id, message: "is missing from every volume" });
  }

  return problems;
}

/**
 * The share of the catalogue that moves when the count grows from `from` to
 * `to`. Used by `--self-test` and printed when a split is planned: a stable
 * function moves about `1/(N+1)` per added volume, `hash % N` moves far more.
 */
export function movedShare(ids: string[], from: number, to: number): number {
  if (!ids.length) return 0;
  let moved = 0;
  for (const id of ids) if (volumeOf(id, from) !== volumeOf(id, to)) moved++;
  return moved / ids.length;
}
