/**
 * The suggestion list — channels somebody follows but the dataset does not.
 *
 * The discovery pipeline finds channels by searching YouTube, which is how a
 * catalogue grows without a human. It is not the only way: a person who
 * already follows four thousand performers knows about channels no keyword
 * search will surface, and they should not have to hand-edit a seed file to
 * say so.
 *
 * A **suggestion** is therefore a candidate, not a record:
 *
 *   - it is cheap to add — an id and a name, no network call;
 *   - it is explicit — the file is committed, so a suggestion is reviewable
 *     in a diff before it becomes part of the dataset;
 *   - it is not authoritative — the platform is still the source of the
 *     name, the region and the classification, which are filled in when the
 *     suggestion is *imported* (`import-channels.ts`).
 *
 * The list lives beside the data rather than inside it: `data/suggestions.json`
 * is an **input**, like `data/overrides.json`, and `data/channels/` remains
 * the only channel store.
 */

import path from "node:path";
import { DATA_DIR, readJson, writeJson } from "./io";
import type { ArtistKind, PlatformId } from "./types";

/** One channel somebody suggested, before it is imported. */
export interface Suggestion {
  /** The platform the id belongs to. */
  platform: PlatformId;
  /** The platform's immutable id (`UC…` on YouTube). */
  id: string;
  /** The name the suggester saw — a fallback, not the authority. */
  name: string;
  /** Canonical profile URL, when there is one. */
  url: string | null;
  /** An optional hint. The classifier decides; this only orders the queue. */
  kind: ArtistKind | null;
  /** Free-text note from the suggester. */
  note: string | null;
  /** Where the suggestion came from. */
  source: "subscription" | "manual";
  /** ISO timestamp. */
  addedAt: string;
}

export interface SuggestionsFile {
  schemaVersion: 1;
  generatedAt: string;
  suggestions: Suggestion[];
}

export const SUGGESTIONS_PATH = path.join(DATA_DIR, "suggestions.json");

/** A suggestion is unique per platform identity. */
export function suggestionKey(suggestion: {
  platform: string;
  id: string;
}): string {
  return `${suggestion.platform}:${suggestion.id}`;
}

export function readSuggestions(): SuggestionsFile {
  const file = readJson<SuggestionsFile>(SUGGESTIONS_PATH, {
    schemaVersion: 1,
    generatedAt: "",
    suggestions: [],
  });
  if (!Array.isArray(file.suggestions)) {
    return { schemaVersion: 1, generatedAt: "", suggestions: [] };
  }
  return file;
}

/** Every suggestion, de-duplicated by platform identity. */
export function listSuggestions(): Suggestion[] {
  const seen = new Set<string>();
  const out: Suggestion[] = [];
  for (const entry of readSuggestions().suggestions) {
    if (!entry?.platform || !entry?.id) continue;
    const key = suggestionKey(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}

export interface AddSuggestionsResult {
  added: Suggestion[];
  /** Entries that were already on the list. */
  duplicates: number;
  total: number;
}

/**
 * Appends suggestions, ignoring duplicates.
 *
 * The list is written deterministically: sorted by platform and id, so two
 * runs that add the same channels in a different order produce the same
 * file and a reviewable diff.
 */
export function addSuggestions(
  entries: {
    platform?: string;
    id?: string;
    name?: string;
    url?: string | null;
    kind?: ArtistKind | null;
    note?: string | null;
    source?: Suggestion["source"];
  }[],
): AddSuggestionsResult {
  const now = new Date().toISOString();
  const current = listSuggestions();
  const byKey = new Map(current.map((s) => [suggestionKey(s), s]));

  const added: Suggestion[] = [];
  let duplicates = 0;

  for (const entry of entries) {
    const platform = (entry.platform ?? "youtube") as PlatformId;
    const id = (entry.id ?? "").trim();
    if (!id) continue;
    const key = `${platform}:${id}`;
    if (byKey.has(key)) {
      duplicates++;
      continue;
    }
    const suggestion: Suggestion = {
      platform,
      id,
      name: (entry.name ?? "").trim() || id,
      url:
        entry.url ??
        (platform === "youtube"
          ? `https://www.youtube.com/channel/${id}`
          : null),
      kind: entry.kind ?? null,
      note: entry.note ?? null,
      source: entry.source ?? "manual",
      addedAt: now,
    };
    byKey.set(key, suggestion);
    added.push(suggestion);
  }

  if (added.length > 0) {
    const suggestions = [...byKey.values()].sort((a, b) =>
      suggestionKey(a).localeCompare(suggestionKey(b)),
    );
    writeJson(SUGGESTIONS_PATH, {
      schemaVersion: 1,
      generatedAt: now,
      suggestions,
    } satisfies SuggestionsFile);
  }

  return {
    added,
    duplicates,
    total: byKey.size,
  };
}

/** Removes suggestions by `platform:id` key. Returns how many were removed. */
export function removeSuggestions(keys: string[]): number {
  if (keys.length === 0) return 0;
  const drop = new Set(keys);
  const current = listSuggestions();
  const kept = current.filter((s) => !drop.has(suggestionKey(s)));
  const removed = current.length - kept.length;
  if (removed === 0) return 0;
  writeJson(SUGGESTIONS_PATH, {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    suggestions: kept,
  } satisfies SuggestionsFile);
  return removed;
}
