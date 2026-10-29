/**
 * The channel → summary projection.
 *
 * A `ChannelSummary` is what a list view needs: the name, the avatar, the
 * region, the subscriber counts — no description, no videos, no verification
 * history. It is **derived**, never stored: the summaries are built from the
 * channel records the app has already downloaded, so there is one copy of
 * each channel on disk instead of two that can disagree.
 *
 * Kept in its own module because both halves use it: the pipeline writes it
 * to `data/channels/manifest.json`-adjacent projections (see `dataset.ts`),
 * and the browser builds the list with it. It must stay free of `node:`
 * imports — it is bundled into the app.
 */

import type { Channel, ChannelSummary } from "./types";
import { countHidden, countValue } from "./types";

export function toSummary(c: Channel): ChannelSummary {
  const ownSubscribers = countValue(c.subscribers);
  /**
   * A channel can hide its count while one of its platforms publishes one —
   * the Channels card then read "— subs" even though the performer's Bilibili
   * audience was known. The projection falls back to the largest published
   * platform count, so the card, the sort and the drawer agree.
   */
  const platformSubscribers = c.platforms
    .map((p) => countValue(p.subscribers))
    .filter((count): count is number => count !== null);
  const subscribers =
    ownSubscribers ??
    (platformSubscribers.length ? Math.max(...platformSubscribers) : null);

  return {
    id: c.id,
    name: c.name,
    aliases: c.aliases ?? [],
    handle: c.handle,
    kind: c.kind,
    role: c.role,
    region: c.region,
    regionSource: c.regionSource,
    languages: c.languages,
    agency: c.agency,
    affiliation: c.affiliation,
    tags: c.tags ?? [],
    avatar: c.avatar,
    subscribers,
    isSinging: c.isSinging,
    activity: c.activity,
    subscribersHidden: subscribers === null && countHidden(c.subscribers),
    twitchLogin:
      c.platforms.find((p) => p.platform === "twitch")?.handle ?? null,
    gender: c.gender,
    isAi: c.isAi,
    isOfficialArtist: c.isOfficialArtist === true,
    // `isOfficialArtist: false` is only written by a pass that asked YouTube,
    // so it doubles as "checked"; `undefined` means nobody asked.
    officialArtistChecked: typeof c.isOfficialArtist === "boolean",
    variant: c.variant,
    verification: c.verification,
    links: c.platforms.map((p) => ({
      p: p.platform,
      u: p.url,
      h: p.handle,
    })),
    externals: c.externals,
    addedAt: c.addedAt,
    reincarnationOf: c.reincarnationOf ?? null,
    followers: c.platforms
      /**
       * `other` / `web` / `email` are addresses, not accounts: they have no
       * followers, so they stay out of the per-platform list.
       */
      .filter((p) => !["other", "web", "email"].includes(p.platform))
      .map((p) => ({
        p: p.platform,
        n:
          p.subscribers.tag === "has"
            ? p.subscribers.count
            : p.subscribers.tag === "no"
              ? 0
              : null,
        hidden: p.subscribers.tag === "hidden",
        v: p.videoCount ?? null,
      })),
  };
}
