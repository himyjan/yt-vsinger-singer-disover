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

import { acquireRunLock, readJson } from "./io";
import {
  layout,
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
import type { Activity, Channel, CountRef, Gender, RegionCode } from "./types";

/**
 * The subscriber count a record starts with.
 *
 * The platform's own number is the one to keep. When the profile carries none
 * — InnerTube omits it for a channel that hides it, and the import has no
 * second source — a roster that dumped `channels.list` has the count and the
 * `hiddenSubscriberCount` flag with it, so it fills the hole. A roster must
 * not turn a hidden count into a number the channel never published, which is
 * why the flag wins over the value.
 */
function subscriberCount(
  platform: CountRef,
  roster?: {
    subscribers?: number | null;
    subscribersHidden?: boolean;
  },
): CountRef {
  if (platform.tag === "has") return platform;
  if (roster?.subscribersHidden) return { tag: "hidden" };
  if (typeof roster?.subscribers === "number" && roster.subscribers > 0) {
    return { tag: "has", count: roster.subscribers };
  }
  return platform;
}

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
/* Overrides                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * A hand-written correction from `data/overrides.json`.
 *
 * The ones that matter to an import are the classification fields: a curated
 * `kind` or `isSinging` is why a channel is being imported at all — somebody
 * filed it under 「Vtuber」 — and inferring it away would file it in the wrong
 * half of the dataset.
 */
interface ChannelOverride {
  kind?: Channel["kind"];
  role?: Channel["role"];
  region?: Channel["region"];
  agency?: string | null;
  affiliation?: Channel["affiliation"];
  tags?: string[];
  gender?: Channel["gender"];
  isAi?: boolean;
  isSinging?: boolean;
  /** The channel this performer streamed as before reincarnating (轉生). */
  reincarnationOf?: string | null;
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
 *
 * The sync applies `data/overrides.json` to every record, so a hand-written
 * correction is the last word there. The import has to do the same: a curated
 * channel that is imported by inference alone would be re-classified on the
 * next run and lose the correction it was imported for.
 */
function recordFromProfile(
  profile: InnerTubeProfile,
  first: InnerTubeProfile,
  now: string,
  override?: ChannelOverride,
  rosterClaim = false,
  hint?: RosterHint,
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
    /**
     * The roster that named this id files it as a virtual performer. The
     * description usually says the same thing; when it does not —
     * 「I'm just a guy trying to have fun, png made by @owo_uou」 — this is
     * the only claim there is.
     */
    virtualClaim: rosterClaim ? "roster" : null,
    hasAvatar: !!(profile.avatar ?? first.avatar),
    override: override
      ? {
          kind: override.kind,
          role: override.role,
          region: override.region,
          agency: override.agency,
          isSinging: override.isSinging,
          // A curated kind is a statement, and the aggregator test is a guess.
          curated: !!(override.kind || override.role || override.isSinging !== undefined),
        }
      : undefined,
  });

  /**
   * The gender: the classifier's answer, then the roster's, then nothing.
   * It decides the `variant` label as well, so it is read once.
   */
  const gender: Gender =
    override?.gender ??
    (classification.gender !== "unknown"
      ? classification.gender
      : hint?.gender?.[id]) ??
    "unknown";

  const handle = (profile.handle ?? first.handle ?? "")
    .replace(/^@/, "")
    .trim() || null;

  const aliases: string[] = [];
  for (const part of splitName(name)) {
    if (part !== name && !aliases.includes(part)) aliases.push(part);
  }

  const subscribers = toCountRef(profile.subscribers);
  const avatar = profile.avatar ?? first.avatar ?? null;
  const textActivity = detectActivity(name, description, null);

  return {
    id,
    name,
    nameSource: "platform",
    aliases: aliases.slice(0, 12),
    handle,
    kind: classification.kind,
    role: classification.role,
    /**
     * A roster's region is a fallback, never an override: it fills the answer
     * the profile left `unknown` and leaves everything else alone.
     */
    region:
      hint?.region && classification.region === "unknown"
        ? hint.region
        : classification.region,
    regionSource:
      hint?.region && classification.region === "unknown"
        ? "roster"
        : classification.regionSource,
    languages: classification.languages,
    statedLanguages: classification.statedLanguages,

    agency: classification.agency ?? hint?.agency?.[id] ?? null,
    affiliation:
      override?.affiliation ??
      detectAffiliation(
        name,
        description,
        classification.agency ?? hint?.agency?.[id] ?? null,
      ),
    avatar,
    banner: null,
    description,
    /**
     * The platform's count wins; the roster's is the fallback, because a
     * roster's dump is a snapshot and the profile was read a moment ago.
     * `toCountRef()` turns an absent count into `hidden`, which would claim
     * the channel hides it, so the roster's number replaces that too.
     */
    subscribers: subscriberCount(subscribers, hint?.stats?.[id]),
    videoCount: hint?.stats?.[id]?.videoCount ?? null,
    viewCount: hint?.stats?.[id]?.viewCount ?? null,
    uploadsPlaylistId: null,
    country,
    tags: override?.tags ?? [],
    isSinging: override?.isSinging ?? classification.isSinging,
    gender,
    isAi: override?.isAi ?? classification.isAi,
    // The import fetches the channel page, which is where the 🎵 badge lives.
    isOfficialArtist: profile.officialArtist,
    officialArtistCheckedAt: now,
    variant: deriveVariant(
      classification.role,
      gender,
      override?.isAi ?? classification.isAi,
    ),
    verification: null,
    source: "api",
    addedAt: now,
    updatedAt: now,
    // The profile was just fetched, so the details pass has nothing to do.
    lastItemsFetchedAt: null,
    lastDetailsFetchedAt: now,

    /**
     * A graduation the text states is a fact about the performer and outranks
     * a roster that still lists them as active — a roster is a snapshot, and
     * 「卒業しました」 is the performer saying it themselves. Everything else
     * is the roster's to state, because a directory that groups its rows by
     * state knows more than a description that mentions none.
     */
    activity:
      textActivity === "graduated" ? "graduated" : hint?.activity?.[id] ?? textActivity,
    debutDate: hint?.debut?.[id] ?? null,
    graduateDate: null,
    reincarnationOf: override?.reincarnationOf ?? null,

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

/**
 * What the roster that supplied an id says about it.
 *
 * A roster is not the platform: it does not decide the name, and it must not
 * overrule a country the channel publishes. It does know two things the
 * profile cannot always state — which **scene** it files the performer in
 * (`region`) and whether the performer has graduated (`activity`).
 */
export interface RosterHint {
  /**
   * The region the roster is scoped to, applied only where the profile
   * decided nothing. A Japanese performer who streams with a Hong Kong group
   * keeps the `jp` their own country and kana gave them.
   */
  region?: RegionCode;
  /** The state the roster lists the performer in, per channel id. */
  activity?: Record<string, Activity>;
  /**
   * The agency the roster files the performer under, per channel id.
   *
   * bacharu publishes the group a performer belongs to — `hololive`,
   * `NIJISANJI`, `ReAcT` — and that is a statement about the performer's
   * affiliation, which `classifyChannel()` can only guess from the text. It
   * is a **fallback**: an agency the title or the description names, and a
   * hand-written override, still win.
   */
  agency?: Record<string, string>;
  /**
   * The debut date the roster publishes, per channel id (`YYYY-MM-DD`).
   *
   * YouTube's profile does not state a debut, and the dataset's `debutDate`
   * is otherwise filled only by the Taiwan tracker and the wiki sources. A
   * directory that files its entries by debut knows it.
   */
  debut?: Record<string, string>;
  /**
   * The gender the roster states, per channel id.
   *
   * A **fallback**: `classifyChannel()` reads the text, and a channel that
   * says 「female VTuber」 has already answered. This is for the ones that do
   * not — a bio in a language the classifier has no pronoun for.
   */
  gender?: Record<string, Gender>;
  /**
   * The languages the roster states for the performer, per channel id.
   *
   * YouTube answers a profile in the UI language it is asked in, and a
   * channel that published an English localization answers with its English
   * **description** — which the language detector then reads as `en`, the
   * very mistake this field exists to avoid. The roster knows the performer
   * speaks Spanish, so the profile is asked for in Spanish and the stored
   * description is the one the performer wrote.
   *
   * It decides the **request**, not the record: `languages` is still the
   * classifier's answer, and a roster's claim does not overrule the text.
   */
  languages?: Record<string, string[]>;
  /**
   * Counts the roster publishes and the profile does not.
   *
   * InnerTube's channel page carries subscribers but not the channel's total
   * view count, and the import has never written `videoCount`. A roster that
   * dumps a `channels.list` response — VtuberHK's `channels.json` — has all
   * three, so it fills them where the profile cannot.
   */
  stats?: Record<
    string,
    {
      subscribers?: number | null;
      subscribersHidden?: boolean;
      videoCount?: number | null;
      viewCount?: number | null;
    }
  >;
}

export interface ImportOptions {
  /** How many ids to fetch in this call. */
  limit?: number;
  /** Where to start in `ids` — lets the caller resume a long list. */
  offset?: number;
  /** Rebuild the search index at the end of the whole list. */
  rebuildIndex?: boolean;
  /**
   * The ids a **roster** supplied, rather than a search or a subscription.
   *
   * The roster files each of them as a virtual performer, and that is a claim
   * about identity the profile itself may not repeat — see
   * `ChannelSignals.virtualClaim`. Membership, not the name, is the claim:
   * the fan and clip tests still run, and the roster still does not get to
   * choose the name, the region or the role.
   */
  rosterIds?: Set<string>;
  /**
   * What the roster says about the region and the state of its entries.
   *
   * See `RosterHint`: the region is a fallback, never an override, and the
   * activity is a fact about the performer the profile does not publish.
   */
  rosterHint?: RosterHint;
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

/**
 * The gender a roster states, in this dataset's two values.
 *
 * Rosters write it freely — `Female`, `female`, `Non-Binary (she/they)`,
 * `prefer-not-to-say` — and only the two the dataset models are taken. A
 * roster's gender is a **hint** on the record, never a decision: an unmapped
 * value is `null`, which leaves the classifier's answer in place.
 */
export function rosterGender(value: string | null | undefined): Gender | null {
  const text = (value ?? "").trim().toLowerCase();
  if (text === "female" || text === "f" || text === "woman") return "female";
  if (text === "male" || text === "m" || text === "man") return "male";
  return null;
}

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
  // The same corrections the sync applies, read once per call so a long
  // import stays consistent with the file it started with.
  const overrides = readJson<Record<string, ChannelOverride>>(
    layout.overrides,
    {},
  );
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
      /**
       * The roster knows the language when the country does not: a Spanish
       * performer publishes no country and has an `unknown` region, and asking
       * YouTube in English would store the English localization of a Spanish
       * description.
       */
      const lang = profileLanguage(regionHint, options.rosterHint?.languages?.[id]);
      const localized =
        lang === "en"
          ? null
          : await source.profile(id, { lang, about: false });
      const profile = localized ?? first;

      const record = recordFromProfile(
        profile,
        first,
        now,
        overrides[id],
        !!options.rosterIds?.has(id),
        options.rosterHint,
      );
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
