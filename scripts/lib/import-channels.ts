/**
 * Importing suggested channels into the dataset.
 *
 * The discovery pipeline grows the catalogue by searching YouTube. That is
 * how it finds performers nobody has named yet — but it cannot find the
 * channels a person already follows: a subscription list is private, and no
 * keyword search reproduces it.
 *
 * So the app can hand the pipeline a list of ids, and this module turns each
 * one into a **channel record**:
 *
 *   1. the profile is fetched through InnerTube — description, avatar,
 *      subscriber count and the country YouTube publishes (no API key, no
 *      quota);
 *   2. the profile is requested again in the language of the region the first
 *      answer implies, so a Japanese channel is stored under its Japanese
 *      name rather than an English alias;
 *   3. `classifyChannel()` decides kind, role, region, agency and gender from
 *      the same evidence a sync would use;
 *   4. the records are merged into the dataset and written through the one
 *      writer, `writeChannelShards()`.
 *
 * **Consent.** Importing somebody's subscriptions writes third-party channel
 * data into a public repository. The caller must pass `consent: true`, and
 * the HTTP layer refuses the request otherwise; the UI asks the user to
 * confirm they own the account or have permission. The check is deliberate:
 * a subscription list is not a public artefact.
 */

import { acquireRunLock } from "./io";
import {
  readAllChannelRecords,
  rebuildChannelsManifest,
  refreshManifestChannelCounts,
  writeChannelShards,
} from "./dataset";
import { InnerTubeSource, type InnerTubeProfile } from "./youtubei";
import {
  classifyChannel,
  detectActivity,
  detectAffiliation,
  deriveVariant,
} from "./classify";
import { extractExternalLinks } from "./twitch";
import { isPlaceholderName, normalizeChannelId } from "./platforms";
import { profileLanguage } from "./regions";
import { splitName } from "./names";
import { removeSuggestions, suggestionKey } from "./suggestions";
import { toCountRef } from "./types";
import { buildSearchIndex } from "../build-index";
import type { Channel } from "./types";

/* -------------------------------------------------------------------------- */
/* InnerTube                                                                  */
/* -------------------------------------------------------------------------- */

let sourcePromise: Promise<InnerTubeSource | null> | null = null;

/**
 * One InnerTube client for the whole server process.
 *
 * Building it costs a handshake; keeping it means a second import does not
 * pay for it again. A failure is remembered as `null` so a broken network
 * does not retry the handshake on every request.
 */
async function innertube(): Promise<InnerTubeSource | null> {
  if (!sourcePromise) {
    sourcePromise = (async () => {
      const source = new InnerTubeSource({ delayMs: 150 });
      const ready = await source.connect();
      return ready ? source : null;
    })();
  }
  return sourcePromise;
}

/* -------------------------------------------------------------------------- */
/* Profiles → records                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Builds a dataset record from a profile.
 *
 * This is intentionally the **same evidence** `classifyChannel()` sees during
 * a sync: the platform's title and description, plus the published country.
 * Nothing is invented — a field the profile does not carry stays empty, and
 * the details pass fills it later.
 */
function recordFromProfile(
  profile: InnerTubeProfile,
  first: InnerTubeProfile,
  now: string,
): Channel | null {
  const id = normalizeChannelId(profile.id);
  if (!id.startsWith("UC")) return null;

  const name = (profile.title ?? first.title ?? "").trim();
  // A tombstone — 「账号已注销」 — is not a name.
  if (isPlaceholderName(name)) return null;

  const description = profile.description
    ? profile.description.slice(0, 1000)
    : null;
  const country = first.country ?? profile.country ?? null;

  const classification = classifyChannel({
    name,
    description,
    tags: [],
    country,
    platform: "youtube",
  });

  const handle = (profile.handle ?? first.handle ?? "")
    .replace(/^@/, "")
    .trim() || null;

  const aliases: string[] = [];
  for (const part of splitName(name)) {
    if (part !== name && !aliases.includes(part)) aliases.push(part);
  }

  const subscribers = toCountRef(profile.subscribers);
  const avatar = profile.avatar ?? first.avatar ?? null;

  return {
    id,
    name,
    nameSource: "platform",
    aliases: aliases.slice(0, 12),
    handle,
    kind: classification.kind,
    role: classification.role,
    region: classification.region,
    regionSource: classification.regionSource,
    languages: classification.languages,
    statedLanguages: classification.statedLanguages,

    agency: classification.agency,
    affiliation: detectAffiliation(name, description, classification.agency),
    avatar,
    banner: null,
    description,
    subscribers,
    videoCount: null,
    viewCount: null,
    uploadsPlaylistId: null,
    country,
    tags: [],
    isSinging: classification.isSinging,
    gender: classification.gender,
    isAi: classification.isAi,
    isOfficialArtist: profile.officialArtist,
    variant: deriveVariant(
      classification.role,
      classification.gender,
      classification.isAi,
    ),
    verification: null,
    source: "api",
    addedAt: now,
    updatedAt: now,
    // The profile was just fetched, so the details pass has nothing to do.
    lastItemsFetchedAt: null,
    lastDetailsFetchedAt: now,

    activity: detectActivity(name, description, null),
    debutDate: null,
    graduateDate: null,

    platforms: [
      {
        platform: "youtube",
        id,
        handle,
        name,
        url: `https://www.youtube.com/channel/${id}`,
        subscribers,
        avatar,
        lastCheckedAt: now,
      },
    ],
    externals: extractExternalLinks(description),

    popularVideoId: null,
  };
}

/* -------------------------------------------------------------------------- */
/* Import                                                                     */
/* -------------------------------------------------------------------------- */

export interface ImportOptions {
  /** How many ids to fetch in this call. */
  limit?: number;
  /** Where to start in `ids` — lets the caller resume a long list. */
  offset?: number;
  /** Rebuild the search index at the end of the whole list. */
  rebuildIndex?: boolean;
  onLog?: (message: string) => void;
}

export interface ImportedChannel {
  id: string;
  name: string;
  region: string;
  kind: string;
}

export interface ImportResult {
  /** How many ids this call looked at. */
  processed: number;
  /** Where the next call should start. */
  nextOffset: number;
  /** Ids left after this call. */
  remaining: number;
  /** Records created. */
  added: ImportedChannel[];
  /** Ids that were already in the dataset. */
  existing: number;
  /** Ids that could not be fetched, with the reason. */
  failed: { id: string; reason: string }[];
  /** Whether the search index was rebuilt after the last batch. */
  indexRebuilt: boolean;
}

const DEFAULT_LIMIT = 12;

export async function importYouTubeChannels(
  rawIds: string[],
  options: ImportOptions = {},
): Promise<ImportResult> {
  const log = options.onLog ?? (() => {});
  const limit = Math.max(1, Math.min(50, options.limit ?? DEFAULT_LIMIT));
  const offset = Math.max(0, options.offset ?? 0);

  /** Clean, de-duplicated ids in the order the caller gave them. */
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const raw of rawIds) {
    const id = normalizeChannelId(String(raw ?? ""));
    if (!id.startsWith("UC") || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }

  const batch = ids.slice(offset, offset + limit);
  const now = new Date().toISOString();

  const existingIds = new Set(readAllChannelRecords().map((c) => c.id));
  const records: Channel[] = [];
  const added: ImportedChannel[] = [];
  const failed: { id: string; reason: string }[] = [];
  let existing = 0;

  const source = await innertube();
  if (!source) {
    return {
      processed: 0,
      nextOffset: offset,
      remaining: Math.max(0, ids.length - offset),
      added: [],
      existing: 0,
      failed: batch.map((id) => ({
        id,
        reason: "InnerTube is unavailable — check the network and try again.",
      })),
      indexRebuilt: false,
    };
  }

  for (const id of batch) {
    if (existingIds.has(id)) {
      existing++;
      continue;
    }
    try {
      /**
       * First answer: the country, which decides the region. `about: true`
       * costs one extra request and is the only place YouTube states it.
       */
      const first = await source.profile(id, { lang: "en", about: true });
      if (!first) {
        failed.push({ id, reason: "the channel did not resolve" });
        continue;
      }

      /**
       * Second answer: the language of the region the country implies.
       *
       * Storing the English localization as the name is how a Japanese
       * channel ends up looking English, so this is not optional.
       */
      const regionHint = classifyChannel({
        name: first.title ?? "",
        description: first.description,
        tags: [],
        country: first.country,
        platform: "youtube",
      }).region;
      const lang = profileLanguage(regionHint);
      const localized =
        lang === "en"
          ? null
          : await source.profile(id, { lang, about: false });
      const profile = localized ?? first;

      const record = recordFromProfile(profile, first, now);
      if (!record) {
        failed.push({ id, reason: "the channel has no usable name" });
        continue;
      }
      if (existingIds.has(record.id)) {
        existing++;
        continue;
      }
      existingIds.add(record.id);
      records.push(record);
      added.push({
        id: record.id,
        name: record.name,
        region: record.region,
        kind: record.kind,
      });
    } catch (err) {
      failed.push({ id, reason: (err as Error).message });
    }
  }

  const processed = batch.length;
  const nextOffset = Math.min(ids.length, offset + processed);
  const remaining = Math.max(0, ids.length - nextOffset);

  if (records.length > 0) {
    /**
     * Re-read before writing, as every producer does: a sync that ran during
     * the network pass must not be overwritten by this call's snapshot.
     */
    const release = acquireRunLock("import");
    try {
      const fresh = readAllChannelRecords();
      const byId = new Map(fresh.map((c) => [c.id, c]));
      for (const record of records) {
        if (!byId.has(record.id)) byId.set(record.id, record);
      }
      const all = [...byId.values()];
      writeChannelShards(all, now);
      rebuildChannelsManifest(all, now);
      refreshManifestChannelCounts(all, now);
    } finally {
      release();
    }
    log(
      `import: ${added.length} added · ${existing} already tracked · ` +
        `${failed.length} failed · ${remaining} remaining`,
    );
  }

  /**
   * A resolved id leaves the suggestion list whether it was created now or
   * had already been imported — there is nothing left to do with it.
   */
  const resolvedKeys = [
    ...added.map((entry) => suggestionKey({ platform: "youtube", id: entry.id })),
    ...batch
      .filter((id) => existingIds.has(id))
      .map((id) => suggestionKey({ platform: "youtube", id })),
  ];
  if (resolvedKeys.length > 0) removeSuggestions(resolvedKeys);

  let indexRebuilt = false;
  if (options.rebuildIndex && remaining === 0) {
    buildSearchIndex();
    indexRebuilt = true;
  }

  return {
    processed,
    nextOffset,
    remaining,
    added,
    existing,
    failed,
    indexRebuilt,
  };
}
