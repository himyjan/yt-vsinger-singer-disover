/**
 * VTuber Music Dataset — curated cover-song metadata.
 *
 * Source: https://github.com/meihei3/VTuber-music-dataset
 * Raw CSV: data/vtuber_music.csv
 *
 * ```csv
 * ,vtuber,music,original,collab,collabVTuber,id,channelId,publishedAt,memo
 * 0,YuNi,だから僕は音楽を辞めた,ヨルシカ,True,燦鳥ノム,BcM4jKW9pRQ,UCHTnX0CSX_KObo5I9WuZ64g,2019-06-28 18:00:01,
 * ```
 *
 * This is the highest-quality source of song metadata available for free:
 * it states the **song** and the **original artist** for each cover, which
 * cannot be reliably extracted from a title alone. The heuristic extractor in
 * `classify.ts` is good, but the dataset is authoritative — so it wins when
 * both are available.
 */

const CSV_URL =
  "https://raw.githubusercontent.com/meihei3/VTuber-music-dataset/refs/heads/master/data/vtuber_music.csv";

export interface MusicDatasetEntry {
  /** YouTube video id. */
  videoId: string;
  /** Uploading channel id. */
  channelId: string;
  /** The performer, as listed. */
  vtuber: string;
  /** The song that was performed. */
  song: string;
  /** The original artist of the song. */
  original: string;
  /** Whether the upload is a collaboration. */
  collab: boolean;
  /** The collaborating performer, when applicable. */
  collabVtuber: string | null;
  /** ISO timestamp of the upload. */
  publishedAt: string | null;
  /** Free-text note, e.g. a third performer. */
  memo: string | null;
}

/**
 * Parses one CSV line, honouring double-quoted fields.
 */
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === ",") {
      out.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  out.push(current);
  return out.map((v) => v.trim());
}

/** Converts the dataset's `2025-06-28 18:00:01` timestamps to ISO. */
function parsePublishedAt(value: string): string | null {
  if (!value) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(value);
  if (!m) {
    const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!d) return null;
    return `${d[1]}-${d[2]}-${d[3]}T00:00:00.000Z`;
  }
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.000Z`;
}

/**
 * Fetches and parses the dataset.
 *
 * Returns `null` when the source is unreachable — the caller then falls back
 * to the heuristic song extraction.
 */
export async function fetchMusicDataset(): Promise<MusicDatasetEntry[] | null> {
  try {
    const res = await fetch(CSV_URL, {
      headers: { "User-Agent": "VSingerSingerTracker/1.0" },
    });
    if (!res.ok) return null;
    const text = await res.text();

    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    if (!lines.length) return null;

    // The first line is the header; the leading index column is unnamed.
    const header = parseCsvLine(lines[0]!);
    const index = (name: string): number =>
      header.findIndex((h) => h.toLowerCase() === name.toLowerCase());

    const col = {
      vtuber: index("vtuber"),
      music: index("music"),
      original: index("original"),
      collab: index("collab"),
      collabVTuber: index("collabVTuber"),
      id: index("id"),
      channelId: index("channelId"),
      publishedAt: index("publishedAt"),
      memo: index("memo"),
    };

    if (col.id < 0 || col.music < 0) return null;

    const out: MusicDatasetEntry[] = [];
    for (const line of lines.slice(1)) {
      const cells = parseCsvLine(line);
      const videoId = cells[col.id];
      if (!videoId) continue;

      out.push({
        videoId,
        channelId: col.channelId >= 0 ? (cells[col.channelId] ?? "") : "",
        vtuber: col.vtuber >= 0 ? (cells[col.vtuber] ?? "") : "",
        song: cells[col.music] ?? "",
        original: col.original >= 0 ? (cells[col.original] ?? "") : "",
        collab:
          col.collab >= 0
            ? /^(true|yes|1)$/i.test(cells[col.collab] ?? "")
            : false,
        collabVtuber:
          col.collabVTuber >= 0 ? (cells[col.collabVTuber] || null) : null,
        publishedAt:
          col.publishedAt >= 0
            ? parsePublishedAt(cells[col.publishedAt] ?? "")
            : null,
        memo: col.memo >= 0 ? (cells[col.memo] || null) : null,
      });
    }
    return out;
  } catch {
    return null;
  }
}

/** Indexes a dataset by video id for fast lookup. */
export function indexMusicDataset(
  entries: MusicDatasetEntry[],
): Map<string, MusicDatasetEntry> {
  const map = new Map<string, MusicDatasetEntry>();
  for (const entry of entries) map.set(entry.videoId, entry);
  return map;
}
