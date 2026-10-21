/**
 * AiSList — community-maintained list of channels that use AI-generated
 * content.
 *
 * Source: https://github.com/Override92/AiSList
 *
 * Two lists are published:
 *   • `aislist_blocklist.txt` — high confidence, confirmed AI content
 *   • `aislist_warnlist.txt`  — medium confidence, strongly suspected
 *
 * Both are plain text, one entry per line, either `@handle` or a `UC…`
 * channel id. Comments start with `!`.
 *
 * This is a far better signal than keyword heuristics: a channel that looks
 * like a VTuber but is in the blocklist is *known* to be AI-generated. The
 * heuristic detector in `classify.ts` remains as a fallback for channels the
 * list has not seen.
 *
 * The lists are updated frequently upstream, so they are fetched live and
 * cached for a day.
 */

const BASE =
  "https://raw.githubusercontent.com/Override92/AiSList/master/AiSList";

export interface AiList {
  /** YouTube channel ids on the list. */
  ids: Set<string>;
  /** `@handle`s on the list (without the `@`, lower-cased). */
  handles: Set<string>;
  /** How many channels are on the high-confidence list. */
  blocklistCount: number;
  /** How many channels are on the medium-confidence list. */
  warnlistCount: number;
  /** ISO timestamp of the fetch. */
  fetchedAt: string;
}

function parseList(text: string): { ids: string[]; handles: string[] } {
  const ids: string[] = [];
  const handles: string[] = [];

  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("!") || line.startsWith("#")) continue;

    if (line.startsWith("@")) {
      const handle = line.slice(1).toLowerCase();
      if (handle) handles.push(handle);
      continue;
    }
    if (line.startsWith("UC") && line.length >= 20) {
      ids.push(line);
    }
  }
  return { ids, handles };
}

async function fetchList(name: string): Promise<string> {
  const res = await fetch(`${BASE}/${name}`, {
    headers: { "User-Agent": "VSingerSingerTracker/1.0" },
  });
  if (!res.ok) return "";
  return res.text();
}

/**
 * Fetches both lists and merges them.
 *
 * A channel on the blocklist takes precedence over the warnlist; the merged
 * result is used to set `isAi` on matching channels.
 */
export async function fetchAiList(): Promise<AiList | null> {
  try {
    const [blockText, warnText] = await Promise.all([
      fetchList("aislist_blocklist.txt"),
      fetchList("aislist_warnlist.txt"),
    ]);
    if (!blockText && !warnText) return null;

    const block = parseList(blockText);
    const warn = parseList(warnText);

    return {
      ids: new Set([...block.ids, ...warn.ids]),
      handles: new Set([...block.handles, ...warn.handles]),
      blocklistCount: block.ids.length + block.handles.length,
      warnlistCount: warn.ids.length + warn.handles.length,
      fetchedAt: new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

/**
 * True when the channel is on the list.
 *
 * Handles are compared case-insensitively; channel ids exactly.
 */
export function isOnAiList(
  list: AiList,
  channel: { id: string; handle?: string | null },
): boolean {
  if (list.ids.has(channel.id)) return true;
  if (channel.handle) {
    const handle = channel.handle.replace(/^@/, "").toLowerCase();
    if (list.handles.has(handle)) return true;
  }
  return false;
}
