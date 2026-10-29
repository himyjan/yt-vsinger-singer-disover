/**
 * VTuber singing-event names and hashtags, for the YouTube discovery pass.
 *
 * One unified file: `lists/singing-events.json`. Every entry has a unique
 * name — calendar events and X/YouTube hashtags that normalize to the same
 * text are merged into one entry, not duplicated.
 *
 *   - `scripts/harvest-singing-events.ts` reads the 歌枠リレーカレンダー Google
 *     Sheet and merges entries into `lists/singing-events.json`.
 *   - `scripts/harvest-x-singing-tags.py` searches X for event announcements
 *     and merges new tags into the same file.
 *   - `scripts/harvest-youtube-singing-tags.ts` searches YouTube via InnerTube
 *     and merges new tags into the same file.
 *   - `scripts/harvest-virtuallivecalendar.ts` scrapes virtuallivecalendar.jp
 *     and merges new events into the same file.
 *   - `scripts/harvest-twipla.ts` scrapes twipla.jp and merges new tags into
 *     the same file.
 *
 * An event name is doing double duty:
 *
 *   - it is the **search query** — searching YouTube for
 *     「虹色シンフォニー歌枠リレー」 finds every participant's stream;
 *   - it is the **evidence** — the name says 歌枠リレー, so a video carrying it
 *     is singing content.
 */

import path from "node:path";
import { readJson } from "./io";

export const SINGING_EVENTS_PATH = path.join(
  process.cwd(),
  "lists",
  "singing-events.json",
);

/** One unique singing-event entry, keyed by its name. */
export interface SingingEventEntry {
  /** Unique event name (no leading `#`). */
  name: string;
  /** `YYYY-MM` the event runs in, when from the calendar. */
  month: string | null;
  /** How often the tag was seen, when from X/YouTube. */
  count: number | null;
  /** When the tag was first seen, when from X/YouTube. */
  firstSeen: string | null;
  /** Where this entry came from: "calendar", "x", "youtube", "twipla", ... */
  sources: string[];
}

export interface SingingEventsFile {
  generatedAt: string;
  sources: string[];
  entries: SingingEventEntry[];
}

/** All singing-event entries, unique by name. A missing file is an empty list. */
export function readSingingEvents(): SingingEventEntry[] {
  const file = readJson<SingingEventsFile>(SINGING_EVENTS_PATH, {
    generatedAt: "",
    sources: [],
    entries: [],
  });
  if (!Array.isArray(file.entries)) return [];
  return file.entries.filter(
    (entry): entry is SingingEventEntry =>
      !!entry && typeof entry.name === "string" && entry.name.length > 0,
  );
}

/**
 * The search queries worth running, best first.
 *
 * Calendar entries come first (they have a date and timetable), then
 * tag-only entries. Entries are already unique by name in the file —
 * no deduplication needed here.
 */
export function singingEventQueries(options: {
  limit?: number;
  events?: SingingEventEntry[];
} = {}): string[] {
  const limit = options.limit ?? 24;
  const entries = options.events ?? readSingingEvents();

  return entries.slice(0, limit).map((e) => e.name);
}
