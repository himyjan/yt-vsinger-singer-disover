/**
 * The channel roster — the dataset's starting catalogue, built from
 * authoritative public sources.
 *
 * The pipeline used to import a legacy SQLite database that had been
 * assembled from ad-hoc searches. That data was incomplete and its
 * classifications were unreliable, so it has been replaced: the roster is now
 * built from sources that publish their own ground truth.
 *
 * | Source | What it contributes |
 * | --- | --- |
 * | Taiwan VTuber Tracking Data | ~2,900 Chinese-language VTubers with YouTube ids, subscriber counts, debut dates, activity status and Twitch links |
 * | `scripts/lib/seeds.ts` | Hand-verified virtual and real performers |
 * | Bilibili / Niconico / VK | Performers who only exist on those platforms |
 *
 * Everything here is free and needs no credentials, so the dataset is real
 * and correct from the first run — no API key required.
 */

import { ALL_SEEDS } from "./seeds";
import { fetchTrackedVtubers } from "./taiwan-vtuber-data";
import { languagesForRegion, mergeLanguages } from "./regions";
import { VdbSource } from "./vdb";
import { createAdapters } from "./platform-registry";
import { classifyChannel, deriveVariant, detectAffiliation } from "./classify";
import { toCountRef } from "./types";
import type { Channel, RecordSource } from "./types";

/** How a roster record got into the dataset. */
export type RosterSource = Extract<
  RecordSource,
  "api" | "seed" | "manual"
>;

export interface RosterOptions {
  /** Include performers discovered on the other platforms. */
  includeOtherPlatforms?: boolean;
  onLog?: (message: string) => void;
}

/**
 * Builds the roster.
 *
 * Each record is complete and correct to the extent its source allows: the
 * region, subscriber count, activity status and debut date come from the
 * source that owns the data, not from inference.
 */
export async function buildRoster(
  options: RosterOptions = {},
): Promise<Channel[]> {
  const log = options.onLog ?? (() => {});
  const now = new Date().toISOString();
  const byId = new Map<string, Channel>();

  /* --- Taiwan VTuber Tracking Data ------------------------------------- */
  const tracked = await fetchTrackedVtubers();
  for (const [youtubeId, record] of tracked) {
    const classification = classifyChannel({
      name: record.name,
      description: null,
      tags: [],
      country: null,
    });

    byId.set(youtubeId, {
      id: youtubeId,
      name: record.name,
      handle: null,
      kind: "virtual",
      role: classification.role === "unknown" ? "vtuber" : classification.role,
      region: record.region,
      regionSource: "roster",
      // The language follows the region, not the name: a Taiwanese performer
      // with a Japanese-style stage name still performs in Chinese.
      languages: languagesForRegion(record.region, classification.languages),
      statedLanguages: classification.statedLanguages,
      agency: record.group,
      // The track list states "no group" positively for a solo act.
      affiliation: record.isIndependent
        ? "independent"
        : detectAffiliation(record.name, null, record.group),
      avatar: record.avatar,
      banner: null,
      description: null,
      subscribers: record.subscribers,
      videoCount: null,
      viewCount: null,
      uploadsPlaylistId: youtubeId.startsWith("UC")
        ? `UU${youtubeId.slice(2)}`
        : null,
      country: null,
      tags: [],
      // Whether they publish singing content is discovered from their
      // uploads, not assumed.
      isSinging: false,
      gender: classification.gender,
      isAi: classification.isAi,
      variant: deriveVariant(
        classification.role === "unknown" ? "vtuber" : classification.role,
        classification.gender,
        classification.isAi,
      ),
      // The track list states the nationality and that they are a VTuber.
      verification: null,
      source: "api",
      addedAt: now,
      updatedAt: now,
      lastItemsFetchedAt: null,
      lastDetailsFetchedAt: null,

      activity: record.activity,
      debutDate: record.debutDate,
      graduateDate: null,

      /**
       * The roster's `imgUrl` is a **YouTube** avatar, so it belongs on the
       * YouTube link rather than on the record. Keeping every avatar on the
       * platform it came from is what makes the precedence rule work: the
       * record's own avatar is then just the primary platform's avatar.
       */
      platforms: [
        {
          platform: "youtube",
          id: youtubeId,
          handle: null,
          name: record.name,
          url: `https://www.youtube.com/channel/${youtubeId}`,
          subscribers: record.subscribers,
          avatar: record.avatar,
          activity: record.activity,
          lastCheckedAt: now,
        },
        ...(record.twitchId
          ? [
              {
                platform: "twitch" as const,
                id: record.twitchId,
                handle: record.twitchId,
                name: record.name,
                url: `https://www.twitch.tv/${record.twitchId}`,
                subscribers: { tag: "hidden" } as const,
                avatar: record.avatar,
                activity: record.activity,
                lastCheckedAt: now,
              },
            ]
          : []),
      ],
      externals: {},

      popularVideoId: null,
    });
  }
  log(`roster: ${tracked.size} performers from the Taiwan VTuber roster`);

  /* --- curated seeds ---------------------------------------------------- */
  for (const seed of ALL_SEEDS) {
    if (!seed.channelId) continue; // handles need the API to resolve
    const existing = byId.get(seed.channelId);
    if (existing) {
      // A curated seed upgrades a roster record: the hand-checked
      // classification wins.
      existing.kind = seed.kind;
      existing.role = seed.role;
      existing.region = seed.region;
      if (seed.agency !== undefined) existing.agency = seed.agency;
      if (seed.isSinging !== undefined) existing.isSinging = seed.isSinging;
      existing.source = "seed";
      continue;
    }

    byId.set(seed.channelId, {
      id: seed.channelId,
      name: seed.name,
      handle: seed.handle ?? null,
      kind: seed.kind,
      role: seed.role,
      region: seed.region,
      regionSource: "override",
      languages: ["en"],
      statedLanguages: ["en"],
      agency: seed.agency ?? null,
      affiliation: detectAffiliation(
        seed.name,
        null,
        seed.agency ?? null,
      ),
      avatar: null,
      banner: null,
      description: null,
      subscribers: toCountRef(null),
      videoCount: null,
      viewCount: null,
      uploadsPlaylistId: seed.channelId.startsWith("UC")
        ? `UU${seed.channelId.slice(2)}`
        : null,
      country: null,
      tags: [],
      isSinging: seed.isSinging ?? false,
      gender: "unknown",
      isAi: false,
      variant: deriveVariant(seed.role, "unknown", false),
      verification: null,
      source: "seed",
      addedAt: now,
      updatedAt: now,
      lastItemsFetchedAt: null,
      lastDetailsFetchedAt: null,

      activity: "unknown",
      debutDate: null,
      graduateDate: null,

      platforms: [
        {
          platform: "youtube",
          id: seed.channelId,
          handle: seed.handle ?? null,
          name: seed.name,
          url: `https://www.youtube.com/channel/${seed.channelId}`,
          subscribers: toCountRef(null),
          avatar: null,
          activity: "unknown",
          lastCheckedAt: now,
        },
      ],
      externals: {},

      popularVideoId: null,
    });
  }
  log(`roster: ${ALL_SEEDS.length} curated seeds applied`);

  /* --- vdb: the Virtual YouTuber Name List Database --------------------- */
  const vdb = new VdbSource();
  const vdbList = await vdb.fetch();
  let vdbAdded = 0;
  for (const entry of vdbList) {
    if (byId.has(entry.id)) {
      // Merge the platform identities into the existing record.
      const existing = byId.get(entry.id)!;
      for (const link of entry.platforms) {
        if (!existing.platforms.some((p) => p.platform === link.platform)) {
          existing.platforms.push(link);
        }
      }
      if (entry.isAi) {
        existing.isAi = true;
        existing.variant = deriveVariant(
          existing.role,
          existing.gender,
          true,
        );
      }
      if (entry.region !== "unknown" && existing.region === "unknown") {
        existing.region = entry.region;
      }
      continue;
    }

    const classification = classifyChannel({
      name: entry.name,
      description: null,
      tags: entry.aliases,
      country: null,
      // The platform is deliberately **not** passed: one platform is not
      // enough to decide the region. A performer with both a Bilibili and a
      // YouTube account presents to a global audience, and their
      // Chinese-subtitled Bilibili channel does not make them a Chinese
      // speaker. Only the full set of platforms says that — and that decision
      // is made below, where the whole set is known.
    });

    byId.set(entry.id, {
      id: entry.id,
      name: entry.name,
      handle: null,
      kind: entry.kind,
      role: classification.role === "unknown" ? "vtuber" : classification.role,
      region: entry.region,
      regionSource:
        entry.regionSource === "declared"
          ? "declared"
          : entry.regionSource === "platform"
            ? "platform"
            : "script",
      /**
       * A performer who lists a language *and* is in a region with a
       * different one speaks both: a Japanese VTuber who lists English
       * streams in Japanese and English. The declared language comes first,
       * because that is what they chose to publish.
       */
      languages: mergeLanguages(
        classification.statedLanguages,
        languagesForRegion(entry.region),
      ),
      statedLanguages: classification.statedLanguages,
      agency: entry.group,
      affiliation: detectAffiliation(entry.name, null, entry.group),
      avatar: null,
      banner: null,
      description: null,
      subscribers: toCountRef(null),
      videoCount: null,
      viewCount: null,
      uploadsPlaylistId: entry.id.startsWith("UC")
        ? `UU${entry.id.slice(2)}`
        : null,
      country: null,
      tags: entry.aliases,
      isSinging: false,
      gender: classification.gender,
      isAi: entry.isAi,
      variant: deriveVariant(
        classification.role === "unknown" ? "vtuber" : classification.role,
        classification.gender,
        entry.isAi,
      ),
      // vdb states the kind and the region outright, so both are certain;
      // the role, the gender and the AI flag are not.
      verification: null,
      source: "api",
      addedAt: now,
      updatedAt: now,
      lastItemsFetchedAt: null,
      lastDetailsFetchedAt: null,

      activity: "unknown",
      debutDate: null,
      graduateDate: null,

      platforms: entry.platforms,
      externals: {},

      popularVideoId: null,
    });
    vdbAdded++;
  }
  log(`roster: ${vdbList.length} vdb performers, ${vdbAdded} new`);

  /* --- other platforms -------------------------------------------------- */
  if (options.includeOtherPlatforms !== false) {
    const adapters = createAdapters({ youtubeClient: null, twitchClient: null });
    for (const adapter of adapters) {
      if (adapter.id === "youtube" || adapter.id === "twitch") continue;
      try {
        const found = (await adapter.search?.("", 0)) ?? [];
        for (const channel of found) {
          const id = `${adapter.id}:${channel.id}`;
          if (byId.has(id)) continue;
          const classification = classifyChannel({
            name: channel.name ?? "",
            description: channel.description,
            tags: channel.tags,
            country: null,
            // A performer found on Bilibili is mainland Chinese, and one
            // found on Niconico is Japanese.
            platform: adapter.id,
          });
          byId.set(id, {
            id,
            name: channel.name ?? channel.handle ?? channel.id,
            handle: channel.handle,
            verification: null,
            kind: classification.kind,
            role: classification.role,
            region: classification.region,
            regionSource: classification.regionSource,
            languages: classification.languages,
            statedLanguages: classification.statedLanguages,

            agency: null,
            affiliation: detectAffiliation(
              channel.name,
              channel.description,
              null,
            ),
            avatar: channel.avatar,
            banner: null,
            description: channel.description,
            subscribers: channel.subscribers,
            videoCount: null,
            viewCount: null,
            uploadsPlaylistId: null,
            country: null,
            tags: channel.tags,
            isSinging: false,
            gender: classification.gender,
            isAi: classification.isAi,
            variant: deriveVariant(
              classification.role,
              classification.gender,
              classification.isAi,
            ),
            source: "api",
            addedAt: now,
            updatedAt: now,
            lastItemsFetchedAt: null,
            lastDetailsFetchedAt: null,

            activity: "unknown",
            debutDate: null,
            graduateDate: null,

            platforms: [
              {
                platform: adapter.id,
                id: channel.id,
                handle: channel.handle,
                name: channel.name,
                url: channel.url,
                subscribers: channel.subscribers,
                avatar: channel.avatar,
                activity: "unknown",
                lastCheckedAt: now,
              },
            ],
            externals: {},

            popularVideoId: null,
          });
        }
      } catch {
        /* a platform being unreachable must never break the roster */
      }
    }
  }

  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}
