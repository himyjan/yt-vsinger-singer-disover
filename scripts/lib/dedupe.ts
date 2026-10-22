/**
 * Channel de-duplication.
 *
 * The same performer arrives from several sources under different
 * identifiers:
 *
 *   - vdb knows them by their Bilibili space id and their YouTube channel id;
 *   - the Taiwan track list knows them by YouTube channel id and Twitch id;
 *   - the curated seeds know them by `@handle`;
 *   - the YouTube API knows them by channel id, and by handle when it
 *     resolves one.
 *
 * A performer with a YouTube channel *and* a Bilibili space therefore arrives
 * as two records with two ids. Left alone, the dataset would list them
 * twice, and a search would return both.
 *
 * The fix is the identity registry (`scripts/lib/identity.ts`): every record
 * is reduced to a set of **identity keys** — a YouTube channel id, a handle,
 * a platform-native id — and records that share a key are merged. The
 * registry is committed, so the merges are stable across runs and reviewable
 * in a diff.
 */

import { IdentityRegistry, type Candidate } from "./identity";
import type { Affiliation, Channel, RegionCode } from "./types";
import { pickAvatar } from "./platforms";

/** The identity keys a channel contributes. */
function keysFor(channel: Channel): string[] {
  const keys: string[] = [];

  // The canonical YouTube channel id.
  if (channel.id.startsWith("UC")) keys.push(`yt:${channel.id}`);

  // Every platform identity, by its platform-native id.
  for (const link of channel.platforms) {
    keys.push(`${link.platform}:${link.id}`);
    if (link.handle) keys.push(`handle:${link.handle.replace(/^@/, "")}`);
  }

  if (channel.handle) keys.push(`handle:${channel.handle.replace(/^@/, "")}`);

  return keys;
}

/**
 * The region implied by a channel's platform identities.
 *
 * A performer who is on Bilibili is mainland Chinese by definition, and one
 * on Niconico is Japanese. This has to survive a merge: a Chinese VTuber who
 * also has a YouTube channel should stay in China, even if their YouTube
 * name happens to be written in Japanese.
 */
function platformRegionOf(channel: Channel): RegionCode | null {
  const platforms = new Set(channel.platforms.map((p) => p.platform));
  if (platforms.size !== 1) return null;
  const only = [...platforms][0];
  if (only === "bilibili") return "cn";
  if (only === "niconico") return "jp";
  return null;
}

/**
 * Merges two channel records.
 *
 * The record that survives is the one with the more complete data; the
 * other's facts fill in its gaps. The canonical id is the one that looks
 * like a real channel id (`UC…` for YouTube) rather than a namespaced one.
 */
export function mergeChannels(target: Channel, other: Channel): Channel {
  const preferOther =
    !target.id.startsWith("UC") && other.id.startsWith("UC");

  const merged: Channel = {
    // `other` first, then `target`: the target's values win, and any field
    // the target does not have is filled in from the other record. A plain
    // `...target` would drop those fields entirely, which is how new fields
    // went missing whenever two records were merged.
    ...other,
    ...target,
    ...(preferOther ? { id: other.id } : {}),
    name: target.name || other.name,
    handle: target.handle ?? other.handle,
    kind: target.kind === "virtual" ? target.kind : other.kind,
    role: target.role === "unknown" ? other.role : target.role,
    regionSource: (() => {
      // The source has to match whichever region won.
      const fromTarget = platformRegionOf(target);
      const fromOther = platformRegionOf(other);
      if (fromTarget && !fromOther) return "platform";
      if (fromOther && !fromTarget) return "platform";
      if (target.regionSource && target.regionSource !== "unknown") {
        return target.regionSource;
      }
      return other.regionSource ?? "unknown";
    })(),
    region: (() => {
      // A platform-implied region wins over a name-derived one.
      const fromTarget = platformRegionOf(target);
      const fromOther = platformRegionOf(other);
      if (fromTarget && fromOther) return fromTarget;
      if (fromTarget) return fromTarget;
      if (fromOther) return fromOther;
      return target.region !== "unknown"
        ? target.region
        : (other.region as RegionCode);
    })(),
    language: target.language ?? other.language,
    agency: target.agency ?? other.agency,
    affiliation: (() => {
      // The more specific answer wins: a positive statement beats "unknown".
      const rank = (a: Affiliation | undefined) =>
        a === "group" ? 3 : a === "independent" ? 2 : a === "unknown" ? 1 : 0;
      return rank(target.affiliation) >= rank(other.affiliation)
        ? (target.affiliation ?? "unknown")
        : (other.affiliation ?? "unknown");
    })(),
    // The avatar belongs to the primary platform, so it is re-derived after
    // the platform lists are merged — otherwise a record could end up with a
    // Bilibili avatar and a YouTube id.
    avatar: pickAvatar({
      id: preferOther ? other.id : target.id,
      avatar: target.avatar ?? other.avatar,
      platforms: mergePlatforms(target.platforms, other.platforms),
    }),
    banner: target.banner ?? other.banner,
    description: target.description ?? other.description,
    subscribers:
      target.subscribers.tag === "hidden"
        ? other.subscribers
        : target.subscribers,
    videoCount: target.videoCount ?? other.videoCount,
    viewCount: target.viewCount ?? other.viewCount,
    uploadsPlaylistId:
      target.uploadsPlaylistId ?? other.uploadsPlaylistId,
    country: target.country ?? other.country,
    tags: [...new Set([...target.tags, ...other.tags])].slice(0, 30),
    isSinging: target.isSinging || other.isSinging,
    gender: target.gender !== "unknown" ? target.gender : other.gender,
    isAi: target.isAi || other.isAi,
    // The stronger value wins, per axis.
    confidence: {
      kind: Math.max(target.confidence?.kind ?? 0, other.confidence?.kind ?? 0),
      region: Math.max(
        target.confidence?.region ?? 0,
        other.confidence?.region ?? 0,
      ),
      role: Math.max(target.confidence?.role ?? 0, other.confidence?.role ?? 0),
      gender: Math.max(
        target.confidence?.gender ?? 0,
        other.confidence?.gender ?? 0,
      ),
      ai: Math.max(target.confidence?.ai ?? 0, other.confidence?.ai ?? 0),
      overall: 0,
    },
    source:
      target.source === "seed" || other.source === "seed"
        ? "seed"
        : target.source === "manual" || other.source === "manual"
          ? "manual"
          : target.source,
    addedAt:
      target.addedAt < other.addedAt ? target.addedAt : other.addedAt,
    updatedAt:
      target.updatedAt > other.updatedAt ? target.updatedAt : other.updatedAt,
    activity:
      target.activity !== "unknown" ? target.activity : other.activity,
    debutDate: target.debutDate ?? other.debutDate,
    graduateDate: target.graduateDate ?? other.graduateDate,
    platforms: mergePlatforms(target.platforms, other.platforms),
    externals: { ...other.externals, ...target.externals },
    popularVideoId: target.popularVideoId ?? other.popularVideoId,
  };

  merged.confidence.overall = Math.min(
    merged.confidence.kind,
    merged.confidence.region,
  );
  return merged;
}

/** Unions two platform lists, keeping one link per platform. */
function mergePlatforms(
  a: Channel["platforms"],
  b: Channel["platforms"],
): Channel["platforms"] {
  const out = [...a];
  for (const link of b) {
    const existing = out.find((p) => p.platform === link.platform);
    if (!existing) {
      out.push(link);
      continue;
    }
    // Fill in whatever the other link knows.
    existing.id = existing.id || link.id;
    existing.handle = existing.handle ?? link.handle;
    existing.name = existing.name ?? link.name;
    existing.url = existing.url || link.url;
    existing.avatar = existing.avatar ?? link.avatar;
    if (existing.subscribers.tag === "hidden") {
      existing.subscribers = link.subscribers;
    }
    if (existing.activity === "unknown") existing.activity = link.activity;
  }
  return out;
}

export interface DedupeResult {
  channels: Channel[];
  /** How many records were merged away. */
  merged: number;
  /** The merged pairs, for the log and for review. */
  pairs: { kept: string; merged: string }[];
}

/**
 * Removes duplicate channels.
 *
 * Two records are the same performer when they share an identity key. The
 * registry is consulted first, so a merge that was established in an earlier
 * run is honoured even if one of the source records has since changed.
 */
export function dedupeChannels(
  channels: Channel[],
  registry?: IdentityRegistry,
): DedupeResult {
  const byKey = new Map<string, Channel>();
  const mergedKeys = new Map<string, string>();
  const pairs: { kept: string; merged: string }[] = [];

  // First pass: the identity keys each record claims.
  const keyOwners = new Map<string, Channel>();
  for (const channel of channels) {
    for (const key of keysFor(channel)) {
      const owner = keyOwners.get(key);
      if (!owner) {
        keyOwners.set(key, channel);
        continue;
      }
      // Two records claim the same identity — they are the same performer.
      const keep = preferChannel(owner, channel);
      const drop = keep === owner ? channel : owner;
      const mergedChannel = mergeChannels(keep, drop);
      keyOwners.set(key, mergedChannel);
      byKey.set(mergedChannel.id, mergedChannel);
      pairs.push({ kept: mergedChannel.id, merged: drop.id });
    }
  }

  // Second pass: the registry knows about merges that the current data
  // cannot express — for instance a record that was renamed on YouTube.
  const result = new Map<string, Channel>();
  for (const channel of channels) {
    const candidate: Candidate = {
      id: channel.id.startsWith("UC") ? channel.id : undefined,
      name: channel.name,
      handle: channel.handle,
      region: channel.region,
      affiliation: channel.agency,
      externals: Object.fromEntries(
        channel.platforms.map((p) => [p.platform, [p.id]]),
      ),
      source: channel.source,
    };

    const registryMatch = registry?.findByKey(
      keysFor(channel)[0] ?? "",
    );
    if (registryMatch && registryMatch.id !== channel.id) {
      const existing = result.get(registryMatch.id);
      if (existing) {
        result.set(registryMatch.id, mergeChannels(existing, channel));
        pairs.push({ kept: registryMatch.id, merged: channel.id });
        continue;
      }
    }

    const existing = result.get(channel.id);
    if (existing) {
      result.set(channel.id, mergeChannels(existing, channel));
      pairs.push({ kept: channel.id, merged: channel.id });
      continue;
    }
    result.set(channel.id, channel);
  }

  // Third pass: one more sweep for keys that only became apparent after the
  // merges above.
  const finalByKey = new Map<string, string>();
  const out: Channel[] = [];
  for (const channel of result.values()) {
    const claimed = keysFor(channel).filter((key) => {
      const owner = finalByKey.get(key);
      if (owner === undefined) return true;
      if (owner === channel.id) return false;
      return false;
    });
    const conflict = claimed.some((key) => finalByKey.has(key));
    if (conflict) {
      const ownerId = claimed.map((k) => finalByKey.get(k)).find(Boolean)!;
      const owner = out.find((c) => c.id === ownerId);
      if (owner) {
        const mergedChannel = mergeChannels(owner, channel);
        out[out.indexOf(owner)] = mergedChannel;
        pairs.push({ kept: owner.id, merged: channel.id });
        continue;
      }
    }
    for (const key of claimed) finalByKey.set(key, channel.id);
    out.push(channel);
  }

  /**
   * Final pass: records with the same display name in the same region that
   * share no platform identity are the same performer under two ids — a
   * personal account and a group account, for instance. The name has to be
   * distinctive enough to be safe: two characters or more, and not a
   * placeholder.
   */
  const byName = new Map<string, Channel>();
  const nameMerged: Channel[] = [];
  for (const channel of out) {
    const key = `${normalizeName(channel.name)}|${channel.region}`;
    if (!normalizeName(channel.name) || key.startsWith("|")) {
      nameMerged.push(channel);
      continue;
    }
    const existing = byName.get(key);
    if (!existing) {
      byName.set(key, channel);
      nameMerged.push(channel);
      continue;
    }
    const mergedChannel = mergeChannels(existing, channel);
    byName.set(key, mergedChannel);
    nameMerged[nameMerged.indexOf(existing)] = mergedChannel;
    pairs.push({ kept: mergedChannel.id, merged: channel.id });
  }

  return {
    channels: nameMerged.sort((a, b) => a.id.localeCompare(b.id)),
    merged: pairs.length,
    pairs,
  };
}

/** Normalises a display name for the duplicate check. */
function normalizeName(name: string): string {
  return name
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}]/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .trim();
}

/**
 * Picks the record to keep.
 *
 * A record with a real channel id beats a namespaced one; a curated record
 * beats an inferred one; otherwise the one with more platform links wins.
 */
function preferChannel(a: Channel, b: Channel): Channel {
  const score = (c: Channel) =>
    (c.id.startsWith("UC") ? 4 : 0) +
    (c.source === "seed" || c.source === "manual" ? 2 : 0) +
    c.platforms.length +
    (c.subscribers.tag === "has" ? 1 : 0) +
    (c.avatar ? 1 : 0);

  return score(b) > score(a) ? b : a;
}
