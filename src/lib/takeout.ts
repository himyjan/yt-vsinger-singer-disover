/**
 * Google Takeout subscription import.
 *
 * The YouTube Data API stops returning `mine=true` subscriptions after about
 * a thousand entries, while the account itself can hold thousands. Takeout
 * has no such limit: `Takeout/YouTube and YouTube Music/subscriptions/subscriptions.csv`
 * lists every channel the account follows as `Channel Id, Channel Url,
 * Channel Title`.
 *
 * Parsing it locally means an account with 4,000 subscriptions can be
 * matched against the dataset without a single API call — and without the
 * OAuth popup.
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
