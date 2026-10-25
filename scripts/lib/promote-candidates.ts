/**
 * Promotes discovery candidates into channel records.
 *
 * Discovery (`npm run data:discover`) answers "who exists that we do not know
 * about". A directory entry is a **name**, not a record: it carries no channel
 * id, so it cannot be written into `data/channels/` as it stands. This module
 * closes the gap without inventing anything:
 *
 *   1. **Resolve** the name through InnerTube channel search.
 *   2. **Confirm** the hit against the record's own display name — a search
 *      result is a candidate, and a common name belongs to something else.
 *      The confirmation is a normalised exact match, never a fuzzy one.
 *   3. **Gate** the channel on the two-video rule from
 *      `scripts/lib/discovery-evidence.ts`: at least two distinct videos that
 *      each show virtual-creator identity *and* singing evidence. A directory
 *      calling somebody a VTuber is one claim; two of their own videos saying
 *      they sing is the other, and this catalogue is about singers.
 *   4. **Import** the survivors through `importYouTubeChannels()`, which is
 *      the one writer that turns a YouTube profile into a record, applies
 *      `data/overrides.json`, merges into the dataset and rebuilds the shard
 *      map.
 *
 * Nothing here writes a record for a channel that failed the gate. That is
 * the point of the module: the gate is the difference between a directory
 * scrape and a curated catalogue.
 */

import { importYouTubeChannels } from "./import-channels";
import type { ImportedChannel } from "./import-channels";
import { buildSearchIndex } from "../build-index";
import { normalizeName } from "./identity";
import { evidenceVideoCount } from "./discovery-evidence";
import { InnerTubeSource } from "./youtubei";

/** A performer a source named, with no channel id yet. */
export interface PromotionCandidate {
  name: string | null;
  /** Which source named them, for the log. */
  source: string;
}

export interface PromotionOptions {
  /** How many candidates to resolve in this run. */
  limit?: number;
  /** Channel-search hits to consider per name. */
  searchResults?: number;
  /** How many uploads to read when checking the gate. */
  uploadsPerChannel?: number;
  /** Rebuild the search index once the imports are written. */
  rebuildIndex?: boolean;
  onLog?: (message: string) => void;
}

export interface PromotionOutcome {
  /** Names the run looked at. */
  considered: number;
  /** Records written by the import. */
  added: ImportedChannel[];
  /** Channels that were already in the dataset. */
  existing: number;
  /** Candidates the gate turned away, with the reason. */
  rejected: { name: string; reason: string }[];
  /** Candidates whose lookup failed (network, rate limit). */
  failed: { name: string; reason: string }[];
}

const DEFAULT_LIMIT = 25;
const DEFAULT_UPLOADS = 12;
const DEFAULT_SEARCH_RESULTS = 5;

/**
 * Resolves candidates to channel ids, gates them, and imports the survivors.
 *
 * A failure is never fatal: an unreachable YouTube or a rate-limited lookup
 * becomes a `failed` entry and the run carries on.
 */
export async function promoteCandidates(
  candidates: PromotionCandidate[],
  options: PromotionOptions = {},
): Promise<PromotionOutcome> {
  const log = options.onLog ?? (() => {});
  const limit = Math.max(1, options.limit ?? DEFAULT_LIMIT);
  const uploadsPerChannel = Math.max(2, options.uploadsPerChannel ?? DEFAULT_UPLOADS);
  const searchResults = Math.max(1, options.searchResults ?? DEFAULT_SEARCH_RESULTS);

  const outcome: PromotionOutcome = {
    considered: 0,
    added: [],
    existing: 0,
    rejected: [],
    failed: [],
  };

  /** One attempt per distinct name, in the order the sources gave them. */
  const names: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const name = candidate.name?.trim();
    if (!name) continue;
    const key = normalizeName(name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    names.push(name);
    if (names.length >= limit) break;
  }
  if (!names.length) return outcome;

  const source = new InnerTubeSource({ delayMs: 250 });
  if (!(await source.connect())) {
    for (const name of names) {
      outcome.failed.push({ name, reason: "InnerTube is unavailable" });
    }
    return outcome;
  }

  const approved: string[] = [];

  for (const name of names) {
    outcome.considered++;
    const key = normalizeName(name);
    let channelId: string | null = null;

    try {
      const hits = await source.searchChannels(name, searchResults);
      for (const id of hits.slice(0, 4)) {
        const profile = await source.profile(id);
        if (!profile?.title) continue;
        if (nameMatches(profile.title, key)) {
          channelId = profile.id; // the profile's id, not the one we asked for
          break;
        }
      }
    } catch (error) {
      outcome.failed.push({ name, reason: messageOf(error) });
      continue;
    }

    if (!channelId) {
      outcome.rejected.push({ name, reason: "no channel with that exact name" });
      continue;
    }

    try {
      const uploads = await source.uploads(channelId, uploadsPerChannel);
      const evidence = evidenceVideoCount(uploads);
      if (evidence < 2) {
        outcome.rejected.push({
          name,
          reason: `${evidence} video(s) with virtual + singing evidence, 2 required`,
        });
        continue;
      }
    } catch (error) {
      outcome.failed.push({ name, reason: messageOf(error) });
      continue;
    }

    approved.push(channelId);
    log(`promote: ${name} → ${channelId} (gate passed)`);
  }

  if (!approved.length) return outcome;

  /**
   * The import caps a call at fifty ids, so a larger batch is written in
   * slices.
   *
   * The index is rebuilt here rather than by the import: the import rebuilds
   * it whenever it is asked to, and a run that added nothing would then
   * rewrite every search pack for no reason.
   */
  const chunkSize = 25;
  for (let i = 0; i < approved.length; i += chunkSize) {
    const chunk = approved.slice(i, i + chunkSize);
    const result = await importYouTubeChannels(chunk, {
      limit: chunk.length,
      rebuildIndex: false,
      onLog: log,
    });
    outcome.added.push(...result.added);
    outcome.existing += result.existing;
    for (const failure of result.failed) {
      outcome.failed.push({ name: failure.id, reason: failure.reason });
    }
    for (const added of result.added) {
      log(`promote: added ${added.name} (${added.region}, ${added.kind})`);
    }
  }

  if (outcome.added.length && options.rebuildIndex !== false) {
    buildSearchIndex();
    log(`promote: search index rebuilt for ${outcome.added.length} new record(s)`);
  }

  return outcome;
}

/**
 * Is this the channel the directory named?
 *
 * A YouTube title is decorated — 「Gawr Gura Ch. hololive-EN」,
 * 「Kizuna AI」 — so equality on the normalised name is the first test and a
 * prefix is the second, bounded so that a short name cannot claim a long one.
 * This is the same rule `findChannelByName()` applies to cross-platform
 * matches: a candidate, confirmed by the record's own display name, never by
 * an alias.
 */
function nameMatches(profileTitle: string, key: string): boolean {
  const title = normalizeName(profileTitle);
  if (!title || !key) return false;
  if (title === key) return true;
  if (title.startsWith(key)) return title.length - key.length <= 12;
  if (key.startsWith(title)) return key.length - title.length <= 12;
  return false;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message.split("\n")[0]! : String(error);
}
