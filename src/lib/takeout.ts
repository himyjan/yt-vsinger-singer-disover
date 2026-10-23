/**
 * Subscription-list import.
 *
 * The YouTube Data API stops returning `mine=true` subscriptions after about
 * a thousand entries, while the account itself can hold thousands. Refresh
 * reads the complete list through InnerTube when the local dev server is
 * available; on a static build three files can carry the rest, and all three
 * are read here without a single API call or OAuth popup:
 *
 *  - Google Takeout's `subscriptions.csv` — `Channel Id, Channel Url,
 *    Channel Title` (the complete, slow path).
 *  - The CSV written by `SUBS_EXPORT_SCRIPT`, which has the same shape.
 *  - A **PocketTube** backup (`.json`, groups → array of `UC…` ids), which is
 *    the fastest path for someone already using it — no Takeout queue.
 *
 * `parseSubscriptionsFile()` picks the right reader from the content.
 */

export interface TakeoutSubscription {
  /** `UC…` channel id. */
  channelId: string;
  /** The channel title as it was when Takeout ran. */
  title: string;
  /** The channel URL, when the file has one. */
  url: string | null;
}

/**
 * Reads a Takeout `subscriptions.csv`.
 *
 * The header is matched by name, not position, because Takeout has changed
 * the column order between exports; when there is no header the first three
 * columns are assumed to be id, URL and title, which is the current layout.
 */
export function parseTakeoutCsv(text: string): TakeoutSubscription[] {
  const rows = parseCsv(text);
  if (rows.length === 0) return [];

  const header = rows[0].map((cell) => cell.trim().toLowerCase());
  const idColumn = header.indexOf("channel id");
  const urlColumn = header.indexOf("channel url");
  const titleColumn = header.indexOf("channel title");
  const hasHeader = idColumn >= 0 || titleColumn >= 0 || urlColumn >= 0;

  const idIndex = hasHeader ? idColumn : 0;
  const urlIndex = hasHeader ? urlColumn : 1;
  const titleIndex = hasHeader ? titleColumn : 2;

  const out: TakeoutSubscription[] = [];
  const seen = new Set<string>();

  for (const row of rows.slice(hasHeader ? 1 : 0)) {
    const id = (idIndex >= 0 ? row[idIndex] : "")?.trim() ?? "";
    const url = (urlIndex >= 0 ? row[urlIndex] : "")?.trim() ?? "";
    const title = (titleIndex >= 0 ? row[titleIndex] : "")?.trim() ?? "";

    /** Newer exports omit the id column in some locales; the URL carries it. */
    const channelId =
      /^UC[\w-]{20,}$/.test(id) ? id : (url.match(/channel\/(UC[\w-]{20,})/)?.[1] ?? "");
    if (!channelId || seen.has(channelId)) continue;
    seen.add(channelId);

    out.push({ channelId, title: title || channelId, url: url || null });
  }

  return out;
}

/**
 * Reads a **PocketTube** backup, or any JSON that contains channel ids.
 *
 * PocketTube's own export is JSON, not Takeout's CSV — a map of group name to
 * an array of `UC…` ids — which is easily mistaken for "an unsupported file"
 * and is the export that carries an account with more than a thousand
 * subscriptions. Rather than pin one shape, every string is inspected for a
 * channel id and every object for the usual id/title spellings; a backup
 * from another tool is then read too.
 */
export function parseSubscriptionsJson(text: string): TakeoutSubscription[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }

  const out: TakeoutSubscription[] = [];
  const seen = new Set<string>();

  const add = (rawId: unknown, rawTitle: unknown): void => {
    const id =
      typeof rawId === "string" ? rawId.match(/UC[\w-]{20,}/)?.[0] ?? "" : "";
    if (!id || seen.has(id)) return;
    seen.add(id);
    const title =
      typeof rawTitle === "string" && rawTitle.trim() ? rawTitle.trim() : id;
    out.push({
      channelId: id,
      title,
      url: `https://www.youtube.com/channel/${id}`,
    });
  };

  const walk = (value: unknown, depth: number): void => {
    if (depth > 12 || value == null) return;
    if (typeof value === "string") {
      add(value, null);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1);
      return;
    }
    if (typeof value !== "object") return;

    const record = value as Record<string, unknown>;
    add(
      record.channelId ??
        record.channel_id ??
        record.browseId ??
        record.channelUrl ??
        record.url ??
        record.id,
      record.channelTitle ??
        record.channelName ??
        record.title ??
        record.name,
    );
    for (const item of Object.values(record)) walk(item, depth + 1);
  };

  walk(data, 0);
  return out;
}

/**
 * Reads whichever subscription file was chosen: a CSV (Takeout or the export
 * script) or JSON (PocketTube). The first non-space character is enough to
 * tell them apart; a JSON file with no channel ids falls back to the CSV
 * reader, which then reports "no subscriptions" rather than failing silently.
 */
export function parseSubscriptionsFile(text: string): TakeoutSubscription[] {
  const head = text.trimStart();
  if (head.startsWith("{") || head.startsWith("[")) {
    const fromJson = parseSubscriptionsJson(text);
    if (fromJson.length > 0) return fromJson;
  }
  return parseTakeoutCsv(text);
}

/**
 * A small RFC 4180 reader: quoted fields, doubled quotes, and embedded
 * newlines (channel titles do contain commas).
 */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (ch !== "\r") {
      field += ch;
    }
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter((cells) => cells.some((cell) => cell.trim() !== ""));
}
