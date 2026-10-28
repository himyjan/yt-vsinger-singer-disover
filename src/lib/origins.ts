/**
 * Where the dataset lives.
 *
 * One repository serves one dataset, so this is a single origin — unless the
 * catalogue has been split into **volumes**, in which case `data/volumes.json`
 * names the others and every loader fans out over them.
 *
 * The file is absent on a normal deployment, and its absence *is* the
 * single-origin case: no flag, no build-time variable, nothing to keep in step
 * with the split. A client that finds the file does what the file says; a
 * client that does not finds exactly the behaviour it had before.
 */

const BASE = import.meta.env.BASE_URL || "/";

export interface DatasetOrigin {
  /** Which volume this is, from `volumes.json`. */
  index: number;
  /** How many there are in total. */
  count: number;
  /** As declared in `volumes.json` — empty for the primary origin. */
  base: string;
  /** Resolves a dataset-relative path (`data/manifest.json`) to a URL. */
  url: (path: string) => string;
}

/** Joins a prefix with a dataset-relative path, without doubling slashes. */
function join(prefix: string, path: string): string {
  return `${prefix}${path.replace(/^\//, "")}`;
}

const PRIMARY: DatasetOrigin = {
  index: 0,
  count: 1,
  base: "",
  url: (path) => join(BASE, path),
};

/** The origin the page was served from. */
export function primaryOrigin(): DatasetOrigin {
  return PRIMARY;
}

/** One JSON file, from one origin. A missing or broken file is `null`. */
export async function fetchUrl<T>(target: string): Promise<T | null> {
  try {
    const res = await fetch(target, { headers: { Accept: "application/json" } });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

interface VolumesFile {
  schemaVersion?: number;
  count?: number;
  volumes?: { index?: number; name?: string; base?: string }[];
}

/**
 * A volume's address.
 *
 * `base` is either a path relative to the deployment (`vol-2/`) or an absolute
 * URL (`https://…/vol-2/`), because the split may live on another host — the
 * point of volumes is that they are separate repositories, and separate
 * repositories are separate sites.
 */
function originAt(base: string, index: number, count: number): DatasetOrigin {
  const absolute = /^[a-z][a-z0-9+.-]*:\/\//i.test(base);
  const prefix = absolute
    ? `${base.replace(/\/*$/, "")}/`
    : `${join(BASE, base).replace(/\/*$/, "")}/`;
  return { index, count, base, url: (path) => join(prefix, path) };
}

let cached: Promise<DatasetOrigin[]> | null = null;

/**
 * Every origin to read, in volume order.
 *
 * All of them or none: a `volumes.json` that names three volumes but gives an
 * address for two cannot be half-read, because half the catalogue would look
 * like the whole of it.
 */
export function loadOrigins(): Promise<DatasetOrigin[]> {
  if (!cached) cached = discover();
  return cached;
}

async function discover(): Promise<DatasetOrigin[]> {
  const file = await fetchUrl<VolumesFile>(PRIMARY.url("data/volumes.json"));
  const list = file?.volumes ?? [];
  const count = file?.count ?? list.length;
  if (count <= 1 || list.length === 0) return [PRIMARY];

  /**
   * Volume 0 is the origin we are reading from, so an empty base is the
   * correct address for it. Any *other* empty base means a volume whose
   * location nobody wrote down: show one volume rather than pretend it is all.
   */
  const bases = list.map((volume) => (volume.base ?? "").trim());
  const broken = list.some(
    (volume, position) => (volume.index ?? position) !== 0 && !bases[position],
  );
  if (broken) return [PRIMARY];

  return list.map((volume, position) =>
    originAt(bases[position], volume.index ?? position, list.length),
  );
}

/** Drops the discovered list, so a reload can pick up a new split. */
export function resetOrigins(): void {
  cached = null;
}
