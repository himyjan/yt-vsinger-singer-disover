/**
 * Upstream revision tracking.
 *
 * The dataset is assembled from several public repositories. Each of them
 * changes on its own schedule, and the pipeline should be able to answer two
 * questions:
 *
 * 1. **Which revision is this dataset built from?** — so a change can be
 *    traced back to the upstream commit that caused it.
 * 2. **Is there anything new to fetch?** — so a sync can skip the work when
 *    an upstream has not moved.
 *
 * The revisions are recorded in `data/upstream.json` and committed, so the
 * next run can compare against them.
 */

import fs from "node:fs";
import path from "node:path";

/** A source the dataset is built from. */
export interface UpstreamSource {
  /** The stable id. */
  id: string;
  /** The label. */
  label: string;
  /** The repository, for the ones that live in git. */
  repo?: string;
  /** The branch to track. */
  branch?: string;
  /** A URL that is not a git repository, but still has a version. */
  url?: string;
}

/** The sources the dataset is built from. */
export const UPSTREAMS: UpstreamSource[] = [
  {
    id: "vdb",
    label: "vdb — the Virtual YouTuber Name List Database",
    repo: "dd-center/vdb",
    branch: "master",
    url: "https://vdb.vtbs.moe/json/list.json",
  },
  {
    id: "taiwan-tracker",
    label: "Taiwan VTuber Tracking Data",
    repo: "TaiwanVtuberData/TaiwanVtuberTrackingData",
    branch: "master",
    url: "https://taiwanvtuberdata.github.io/",
  },
  {
    id: "aislist",
    label: "AiSList",
    repo: "Override92/AiSList",
    branch: "master",
  },
  {
    id: "music-dataset",
    label: "VTuber Music Dataset",
    repo: "meihei3/VTuber-music-dataset",
    branch: "master",
  },
  {
    id: "youtubei",
    label: "YouTube.js — the InnerTube client",
    repo: "LuanRT/YouTube.js",
    branch: "master",
  },
];

/** One source's recorded revision. */
export interface UpstreamRevision {
  id: string;
  label: string;
  /** The commit SHA, when the source is a git repository. */
  sha: string | null;
  /** The commit date. */
  committedAt: string | null;
  /** The commit message, truncated. */
  message: string | null;
  /** When the pipeline last checked. */
  checkedAt: string;
}

export interface UpstreamFile {
  schemaVersion: number;
  generatedAt: string;
  sources: UpstreamRevision[];
}

/**
 * Fetches the latest commit of a repository.
 *
 * The GitHub API is unauthenticated and allows 60 requests an hour, which is
 * plenty for a handful of sources once a day.
 */
async function fetchHead(
  repo: string,
  branch: string,
): Promise<{ sha: string; committedAt: string | null; message: string | null } | null> {
  try {
    const res = await fetch(
      `https://api.github.com/repos/${repo}/commits/${branch}`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "VSingerSingerTracker/1.0",
        },
      },
    );
    if (!res.ok) return null;
    const json = (await res.json()) as {
      sha?: string;
      commit?: { message?: string; committer?: { date?: string } };
    };
    if (!json.sha) return null;
    return {
      sha: json.sha,
      committedAt: json.commit?.committer?.date ?? null,
      message: (json.commit?.message ?? "").split("\n")[0]!.slice(0, 140),
    };
  } catch {
    return null;
  }
}

/**
 * Checks every upstream and compares it with the recorded revision.
 *
 * @param filePath Where the revisions are stored.
 */
export async function checkUpstreams(
  filePath: string,
  onLog?: (message: string) => void,
): Promise<{
  file: UpstreamFile;
  changed: { id: string; from: string | null; to: string | null }[];
}> {
  const log = onLog ?? (() => {});
  const previous = readRevisions(filePath);
  const previousById = new Map(previous.sources.map((s) => [s.id, s]));

  const sources: UpstreamRevision[] = [];
  const changed: { id: string; from: string | null; to: string | null }[] = [];
  const now = new Date().toISOString();

  for (const upstream of UPSTREAMS) {
    if (!upstream.repo) continue;
    const head = await fetchHead(upstream.repo, upstream.branch ?? "master");
    if (!head) {
      log(`upstream ${upstream.id}: could not be reached`);
      const old = previousById.get(upstream.id);
      if (old) sources.push(old);
      continue;
    }

    const old = previousById.get(upstream.id);
    if (old && old.sha === head.sha) {
      log(`upstream ${upstream.id}: unchanged (${head.sha.slice(0, 7)})`);
    } else if (old) {
      log(
        `upstream ${upstream.id}: updated ${old.sha?.slice(0, 7) ?? "?"} → ${head.sha.slice(0, 7)}`,
      );
      changed.push({ id: upstream.id, from: old.sha, to: head.sha });
    } else {
      log(`upstream ${upstream.id}: recorded for the first time (${head.sha.slice(0, 7)})`);
      changed.push({ id: upstream.id, from: null, to: head.sha });
    }

    sources.push({
      id: upstream.id,
      label: upstream.label,
      sha: head.sha,
      committedAt: head.committedAt,
      message: head.message,
      checkedAt: now,
    });
  }

  const file: UpstreamFile = {
    schemaVersion: 1,
    generatedAt: now,
    sources,
  };
  return { file, changed };
}

/** Reads the recorded revisions. */
export function readRevisions(filePath: string): UpstreamFile {
  try {
    if (!fs.existsSync(filePath)) {
      return { schemaVersion: 1, generatedAt: "", sources: [] };
    }
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as UpstreamFile;
  } catch {
    return { schemaVersion: 1, generatedAt: "", sources: [] };
  }
}

/** Writes the recorded revisions. */
export function writeRevisions(
  filePath: string,
  file: UpstreamFile,
): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(file, null, 2)}\n`);
}

/** A one-line summary, for the CLI. */
export function describeUpstreams(file: UpstreamFile): string {
  if (!file.sources.length) return "no upstreams recorded";
  return file.sources
    .map((s) => `${s.id}@${s.sha?.slice(0, 7) ?? "?"}`)
    .join(" ");
}
