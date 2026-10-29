/**
 * VTuber singing-event names and hashtags, for the YouTube discovery pass.
 *
 * Two sources feed this, and both are **inputs** rather than dataset facts:
 *
 *   - `scripts/harvest-singing-events.ts` reads the 歌枠リレーカレンダー Google
 *     Sheet — the community's canonical list of every singing relay, filed by
 *     the day it runs — and writes `.cache/singing-events.json`.
 *   - `scripts/harvest-x-singing-tags.py` searches X for event announcements
 *     and recruitment posts and writes `.cache/x-singing-tags.json`.
 *
 * An event name is doing double duty, and that is the point:
 *
 *   - it is the **search query** — searching YouTube for
 *     「虹色シンフォニー歌枠リレー」 finds every participant's stream;
 *   - it is the **evidence** — the name says 歌枠リレー, so a video carrying it
 *     is singing content, and a channel that publishes it is a singing
 *     channel. The sync's virtual-and-singing gate normally needs the virtual
 *     word and the singing word in the same video; an event search supplies
 *     the singing half, and the calendar it came from supplies the other.
 *
 * Both files live in `.cache/` because they change every harvest and would
 * make every data commit a diff.
 */

import path from "node:path";
import { readJson } from "./io";

export const SINGING_EVENTS_PATH = path.join(
  process.cwd(),
  ".cache",
  "singing-events.json",
);
export const X_SINGING_TAGS_PATH = path.join(
  process.cwd(),
  ".cache",
  "x-singing-tags.json",
);

export interface SingingEvent {
  name: string;
  /** `YYYY-MM` the event runs in. */
  month: string;
}

export interface SingingEventsFile {
  generatedAt: string;
  source: string;
  yearSheet?: string | null;
  months?: number;
  events: SingingEvent[];
}

export interface XSingingTag {
  /** Without the leading `#`. */
  tag: string;
  count: number;
  firstSeen: string | null;
}

export interface XSingingTagsFile {
  generatedAt: string;
  source: string;
  tags: XSingingTag[];
}

/** The calendar's events, newest month first. A missing file is an empty list. */
export function readSingingEvents(): SingingEvent[] {
  const file = readJson<SingingEventsFile>(SINGING_EVENTS_PATH, {
    generatedAt: "",
    source: "",
    events: [],
  });
  if (!Array.isArray(file.events)) return [];
  return file.events.filter(
    (entry): entry is SingingEvent =>
      !!entry && typeof entry.name === "string" && entry.name.length > 0,
  );
}

/** The X hashtags, a missing file answering an empty list. */
export function readXSingingTags(): XSingingTag[] {
  const file = readJson<XSingingTagsFile>(X_SINGING_TAGS_PATH, {
    generatedAt: "",
    source: "x.com",
    tags: [],
  });
  if (!Array.isArray(file.tags)) return [];
  return file.tags.filter(
    (entry): entry is XSingingTag =>
      !!entry && typeof entry.tag === "string" && entry.tag.length > 0,
  );
}

/**
 * The search queries worth running, best first.
 *
 * The calendar is the stronger source — an event there has a date, a timetable
 * and a participant list — so its names come first, and the X hashtags fill in
 * the events the calendar has not filed yet. Both are deduplicated by their
 * normalised form so an event listed as 「虹色シンフォニー歌枠リレー」 and as
 * `#虹色シンフォニー歌枠リレー` is one query.
 */
export function singingEventQueries(options: {
  limit?: number;
  events?: SingingEvent[];
  tags?: XSingingTag[];
} = {}): string[] {
  const limit = options.limit ?? 24;
  const events = options.events ?? readSingingEvents();
  const tags = options.tags ?? readXSingingTags();

  const seen = new Set<string>();
  const queries: string[] = [];
  const push = (query: string) => {
    const key = query.replace(/^#/, "").replace(/\s+/g, "").toLowerCase();
    if (!key || seen.has(key)) return;
    seen.add(key);
    queries.push(query);
  };

  for (const event of events) push(event.name);
  for (const tag of tags) push(`#${tag.tag}`);

  return queries.slice(0, limit);
}
