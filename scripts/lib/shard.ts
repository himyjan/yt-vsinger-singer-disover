/**
 * Deterministic sharding.
 *
 * The catalogue is far larger than one run can work through, so every
 * long-running pass — the sync, the details fill, the link resolver — works on
 * one **shard** of it, and the scheduled workflow rotates the shard from run
 * to run.
 *
 * The shard is a pure function of the channel's immutable platform id, so the
 * same channel lands in the same shard on every machine and every run. That is
 * what lets the workflow use `GITHUB_RUN_NUMBER` as a cursor without storing
 * one: a cursor file (or `Math.random()`) would make the git history of
 * `data/` unreviewable and would lose its place whenever the workflow was
 * re-run.
 */

/**
 * The deterministic shard a channel id belongs to.
 *
 * FNV-1a over the id, which is tiny, stable and spreads ids evenly enough for
 * a rotation. The result is a zero-based shard index.
 */
export function shardOf(id: string, count: number): number {
  if (count <= 1) return 0;
  let hash = 2166136261;
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % count;
}

/**
 * True when the id belongs to the run's shard.
 *
 * `shardIndex` is **1-based** on the command line (`--shard 2/4`), which is
 * how a person counts; the hash is zero-based.
 */
export function inShard(
  id: string,
  shardIndex: number,
  shardCount: number,
): boolean {
  return shardCount <= 1 || shardOf(id, shardCount) === shardIndex - 1;
}

/** Parses `--shard N/M` into a 1-based index and a count. */
export function parseShard(
  value: string | undefined,
): { index: number; count: number } {
  const match = /^(\d+)\s*\/\s*(\d+)$/.exec((value ?? "").trim());
  if (!match) return { index: 1, count: 1 };
  const count = Number(match[2]);
  const index = Number(match[1]);
  if (!Number.isInteger(count) || count < 1) return { index: 1, count: 1 };
  if (!Number.isInteger(index) || index < 1 || index > count) {
    return { index: 1, count: 1 };
  }
  return { index, count };
}
