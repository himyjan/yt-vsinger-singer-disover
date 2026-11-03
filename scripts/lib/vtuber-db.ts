/**
 * VtuberDB (vtuberdb.com) — the VTuber人物録 (pre-release namelist).
 *
 * The namelist at https://vtuberdb.com/namelist/ publishes its roster as CSV
 * through `./csv.php` (same folder). Each row carries the performer's name,
 * reading, status, agency/unit and — crucially — a **YouTube channel id and
 * URL**, so matching against the dataset is direct (no name search needed).
 *
 *   https://vtuberdb.com/namelist/csv.php
 *
 * The old Cargo API (`api.php`) no longer carries the roster — it answers
 * with a single test record — so the namelist CSV is the source of truth.
 *
 * No authentication required.
 *
 *   npm run data:vtuber-db              # the whole roster (~1000 entries)
 *   npm run data:vtuber-db -- --limit 50  # a sample, for a parser check
 *
 * Nothing here writes `data/` — adding the channels is
 *   npm run data:vtuber-db-import
 */

import fs from "node:fs";
import path from "node:path";

const CSV_URL = "https://vtuberdb.com/namelist/csv.php";
const USER_AGENT = "VSingerSingerTracker/1.0 (dataset builder; +https://github.com/)";

/** One performer from the VTuber人物録 namelist CSV. */
export interface VtuberDbEntry {
  /** Stable row key: the pid, falling back to the YouTube URL / channel id. */
  pageName: string;
  /** Display name (名前). */
  displayName: string | null;
  /** Reading (読み). */
  kana: string | null;
  /** Activity status (ステータス). */
  status: string | null;
  /** Agency / affiliation (所属). */
  agency: string | null;
  /** Unit (ユニット). */
  unit: string | null;
  /** Catch copy / concept (キャッチコピー). */
  catchcopy: string | null;
  /** Fan mark (ファンマーク). */
  fanmark: string | null;
  /** X URL. */
  xUrl: string | null;
  /** YouTube URL. */
  youtubeUrl: string | null;
  /** Subscriber count (登録者数). */
  subscribers: number | null;
  /** YouTube channel id (チャンネルID). */
  channelId: string | null;
  /** Icon URL (アイコンURL). */
  iconUrl: string | null;
  /** Former agency (前所属). */
  prevAgency: string | null;
  /** Former unit (前ユニット). */
  prevUnit: string | null;
  /** Date added (追加日). */
  addedDate: string | null;
  /** Date fetched (取得日). */
  fetchedDate: string | null;
  /** Person id (人物ID). */
  pid: string | null;
  /** Whether the YouTube / X link is dead (リンク切れ). */
  dead: boolean;
  /** Special activity label (特殊活動ラベル). */
  label: string | null;
  /** Main streaming language (言語). */
  lang: string | null;
  /** Name variant (別表記). */
  variant: string | null;
  /** Alias (別名義). */
  alias: string | null;
  /** Former name (旧名). */
  former: string | null;
  /** Nickname (愛称). */
  nickname: string | null;
}

interface CsvColumn {
  index: number;
  name: string;
}

const COLUMNS: CsvColumn[] = [
  { index: 0, name: "名前" },
  { index: 1, name: "読み" },
  { index: 2, name: "ステータス" },
  { index: 3, name: "所属" },
  { index: 4, name: "ユニット" },
  { index: 5, name: "キャッチコピー" },
  { index: 6, name: "ファンマーク" },
  { index: 7, name: "X URL" },
  { index: 8, name: "YouTube URL" },
  { index: 9, name: "登録者数" },
  { index: 10, name: "チャンネルID" },
  { index: 11, name: "アイコンURL" },
  { index: 12, name: "前所属" },
  { index: 13, name: "前ユニット" },
  { index: 14, name: "追加日" },
  { index: 15, name: "取得日" },
  { index: 16, name: "人物ID" },
  { index: 17, name: "X" },
  { index: 18, name: "言語" },
  { index: 19, name: "別表記" },
  { index: 20, name: "別名義" },
  { index: 21, name: "旧名" },
  { index: 22, name: "愛称" },
  { index: 23, name: "VtuberDBページ" },
  { index: 24, name: "リンク切れ" },
  { index: 25, name: "特殊活動ラベル" },
];

/** Splits one CSV line into fields, honouring double-quoted fields. */
function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  while (i < line.length) {
    const c = line[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (c === ",") {
      fields.push(field);
      field = "";
      i++;
      continue;
    }
    field += c;
    i++;
  }
  fields.push(field);
  return fields;
}

/** Parses the whole CSV text into an array of row arrays (raw field text,
 * quotes retained). Newlines inside double-quoted fields do not end a row. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let buffer = "";
  let inQuotes = false;
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (i + 1 < text.length && text[i + 1] === '"') {
          buffer += '""';
          i += 2;
          continue;
        }
        inQuotes = false;
      }
      buffer += c;
      i++;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      buffer += c;
      i++;
      continue;
    }
    if (c === "\r") {
      if (text[i + 1] === "\n") i++;
      if (buffer.trim()) rows.push(parseCsvLine(buffer));
      buffer = "";
      i++;
      continue;
    }
    if (c === "\n") {
      if (buffer.trim()) rows.push(parseCsvLine(buffer));
      buffer = "";
      i++;
      continue;
    }
    buffer += c;
    i++;
  }
  if (buffer.trim()) rows.push(parseCsvLine(buffer));
  return rows;
}

function cell(row: string[], col: CsvColumn): string | null {
  const v = row[col.index];
  return v === undefined || v === "" ? null : v;
}

async function fetchCsv(): Promise<string | null> {
  try {
    const res = await fetch(CSV_URL, {
      headers: { "User-Agent": USER_AGENT, "Accept": "text/csv" },
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) return null;
    return (await res.text()) as string;
  } catch {
    return null;
  }
}

/**
 * Harvests all VTubers from the namelist CSV.
 *
 * Every row that carries a YouTube channel id is returned; rows without one
 * (dead or link-less entries) are skipped. `limit` caps how many rows are
 * returned, taken in file order.
 */
export async function harvestVtuberDb(limit: number): Promise<VtuberDbEntry[]> {
  const text = await fetchCsv();
  if (!text) {
    // A source that is unreachable must not fail the run.
    console.error("VtuberDB namelist feed unavailable — leaving previous cache untouched");
    return [];
  }

  const rows = parseCsv(text);
  if (rows.length < 2) return [];

  const header = rows[0]!;
  // Map column names to indexes robustly, in case the sheet gains/drops cols.
  const byName = new Map<string, number>();
  header.forEach((h, i) => byName.set(h.trim(), i));
  const col = (name: string): CsvColumn | null => {
    const i = byName.get(name);
    return i === undefined ? null : { index: i, name };
  };

  const entries: VtuberDbEntry[] = [];
  for (let r = 1; r < rows.length && entries.length < limit; r++) {
    const row = rows[r]!;
    const channelIdCol = col("チャンネルID")!;
    const channelId = cell(row, channelIdCol);
    if (!channelId || !/^UC[\w-]{20,}$/.test(channelId)) continue;

    const deadRaw = cell(row, col("リンク切れ")!);
    const dead = deadRaw ? /^(TRUE|true|1|はい)$/i.test(deadRaw) : false;

    const subsRaw = cell(row, col("登録者数")!);
    let subscribers: number | null = null;
    if (subsRaw) {
      const n = Number(subsRaw.replace(/,/g, ""));
      if (!Number.isNaN(n)) subscribers = n;
    }

    const pageNameCol = col("VtuberDBページ");
    const pidCol = col("人物ID");
    const pageName =
      cell(row, pageNameCol ?? { index: -1, name: "" }) ??
      cell(row, pidCol ?? { index: -1, name: "" }) ??
      channelId;

    entries.push({
      pageName,
      displayName: cell(row, col("名前")!),
      kana: cell(row, col("読み")!),
      status: cell(row, col("ステータス")!),
      agency: cell(row, col("所属")!),
      unit: cell(row, col("ユニット")!),
      catchcopy: cell(row, col("キャッチコピー")!),
      fanmark: cell(row, col("ファンマーク")!),
      xUrl: cell(row, col("X URL")!),
      youtubeUrl: cell(row, col("YouTube URL")!),
      subscribers,
      channelId,
      iconUrl: cell(row, col("アイコンURL")!),
      prevAgency: cell(row, col("前所属")!),
      prevUnit: cell(row, col("前ユニット")!),
      addedDate: cell(row, col("追加日")!),
      fetchedDate: cell(row, col("取得日")!),
      pid: cell(row, pidCol ?? { index: -1, name: "" }),
      dead,
      label: cell(row, col("特殊活動ラベル")!),
      lang: cell(row, col("言語")!),
      variant: cell(row, col("別表記")!),
      alias: cell(row, col("別名義")!),
      former: cell(row, col("旧名")!),
      nickname: cell(row, col("愛称")!),
    });
  }

  return entries;
}
