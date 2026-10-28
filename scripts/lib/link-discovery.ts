/**
 * Cross-platform link discovery.
 *
 * A large part of the catalogue comes from vdb, which files **9,000+
 * performers under Bilibili alone** — no YouTube channel, no Twitch login.
 * For some of them that is the truth: they stream on Bilibili and nowhere
 * else. For many others it is a gap in the roster, and the performer's
 * YouTube channel exists, is linked from their own profile, and is what
 * decides their region.
 *
 * This module closes that gap. It reads the identities a performer publishes
 * about themselves, in order of how much they can be trusted:
 *
 * | Source | What it is |
 * | --- | --- |
 * | the record's own description | the Bilibili signature, the YouTube about text |
 * | the record's `externals` | handles harvested from a description |
 * | the performer's X profile | the bio and the website field |
 * | Wikidata | `P2397` YouTube, `P4047` Twitch, `P2002` X |
 * | web search | the optional, search-grounded fallback |
 *
 * ## Only the performer's own platform may name them
 *
 * Discovery adds **links**, never names. A performer's Bilibili name is the
 * name the record shows; the YouTube channel is another account, not another
 * authority. The one field a discovered YouTube channel is allowed to decide
 * is the region — because YouTube publishes the channel's country, and that
 * is the fact a mirror cannot corrupt.
 *
 * ## A candidate is not a link
 *
 * A web search or a wiki page returns *candidates*: the name matched, but
 * nobody said the account is the same performer. A candidate is only accepted
 * when the profile it resolves to points back at the record — the Bilibili
 * space id in the YouTube description, the same X handle, or the same name in
 * the channel title. That is what keeps one 「雫るる」 from absorbing another.
 */

import { extractExternalLinks } from "./twitch";
import {
  extractPlatformId,
  isPlaceholderAvatar,
  isPlaceholderName,
} from "./platforms";
import type { PlatformAdapter, PlatformChannel } from "./platforms";
import type { InnerTubeSource } from "./youtubei";
import type { TwitchGqlSource } from "./twitch-gql";
import { normalizeName } from "./identity";
import { detectClipAccount, isFanAccountName } from "./classify";
import { toCountRef } from "./types";
import type { Channel, PlatformId, PlatformLink } from "./types";

/** A platform identity that was *mentioned* somewhere. */
export interface LinkCandidate {
  platform: PlatformId;
  /** The platform-native id, handle or login. */
  id: string;
  /**
   * Where it was found.
   *
   * `description`, `externals` and `x-bio` are the performer's own words, so
   * the link is taken at face value. `wikidata` and `search` are matches on a
   * **name**, so the resolved profile has to confirm the identity.
   */
  via: "description" | "externals" | "x-bio" | "wikidata" | "search";
}

/** Platforms this module can turn into a `PlatformLink`. */
const RESOLVABLE = new Set<PlatformId>([
  "youtube",
  "twitch",
  "bilibili",
  "niconico",
  "vk",
  "chzzk",
  "kick",
  "soop",
  "ci.me",
]);

/**
 * Every platform identity a block of text mentions.
 *
 * The text is whatever the performer wrote — a Bilibili signature, a YouTube
 * description, an X bio — so it usually contains several links of several
 * kinds. `extractExternalLinks()` is the one parser for all of them; this
 * function only decides which of the results can be resolved into a link.
 */
export function linksInText(
  text: string | null | undefined,
  via: LinkCandidate["via"],
): LinkCandidate[] {
  if (!text) return [];
  const out: LinkCandidate[] = [];
  const seen = new Set<string>();

  const push = (platform: PlatformId, id: string) => {
    const value = id.trim();
    if (!value || !RESOLVABLE.has(platform)) return;
    const key = `${platform}:${value.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ platform, id: value, via });
  };

  for (const [platform, id] of Object.entries(extractExternalLinks(text))) {
    if (platform === "youtube_video" || platform === "youtube_playlist") continue;
    if (platform === "twitter") continue;
    push(platform, id);
  }

  /**
   * A URL that `extractExternalLinks()` did not recognise as a handle —
   * `youtube.com/user/…`, a Bilibili `space` URL with a trailing path — is
   * still a link worth trying.
   */
  const urls = text.match(/https?:\/\/[^\s<>"'）)」】]+/g) ?? [];
  for (const url of urls) {
    const found = extractPlatformId(url);
    if (found) push(found.platform, found.id);
  }

  return out;
}

/** What resolving a candidate needs. */
export interface LinkContext {
  innertube: InnerTubeSource;
  twitch: TwitchGqlSource;
  adapters: Map<PlatformId, PlatformAdapter>;
  /** The language to ask YouTube in, for the channel's own name. */
  lang?: string;
}

/** The profile text a resolved link carries, used to verify an identity. */
export interface ResolvedLink {
  link: PlatformLink;
  /** The description, links and title that came with the profile. */
  text: string;
  /**
   * The profile's own description, on its own.
   *
   * `text` is for matching and for harvesting handles; the description is
   * what a record stores, so it has to be kept apart: a deleted Bilibili
   * account answers with the tombstone 「账号已注销」 as its signature, and
   * that is not a description of anything.
   */
  description?: string | null;
  /**
   * The country the platform publishes, as an ISO code.
   *
   * YouTube is the only platform that states one, and it is the fact a
   * **mirror** cannot corrupt — which is why a discovered YouTube channel is
   * allowed to correct the region of a Bilibili-only record.
   */
  country?: string | null;
}

/**
 * Resolves a candidate into a real platform account.
 *
 * Every branch returns `null` rather than throwing: one deleted account is a
 * fact about that account, not a reason to stop a run of thousands.
 */
export async function resolveCandidate(
  candidate: LinkCandidate,
  ctx: LinkContext,
): Promise<ResolvedLink | null> {
  const now = new Date().toISOString();
  const id = candidate.id.trim();
  if (!id) return null;

  if (candidate.platform === "youtube") {
    return resolveYouTube(id, ctx, now);
  }

  if (candidate.platform === "twitch") {
    const profile = await ctx.twitch.profile(id);
    if (!profile) return null;
    return {
      link: {
        platform: "twitch",
        id: profile.id,
        handle: profile.login,
        name: profile.displayName,
        url: `https://www.twitch.tv/${profile.login ?? id}`,
        subscribers: toCountRef(profile.followers),
        avatar: profile.avatar,
        lastCheckedAt: now,
      },
      text: [profile.displayName, profile.description].filter(Boolean).join(" "),
      description: profile.description,
    };
  }

  const adapter = ctx.adapters.get(candidate.platform);
  if (!adapter) return null;
  const profile = await adapter.resolve(id);
  if (!profile) return null;
  return {
    link: platformLinkFromChannel(profile, now),
    text: [profile.name, profile.description, ...(profile.tags ?? [])]
      .filter(Boolean)
      .join(" "),
    description: profile.description,
  };
}

/** YouTube needs two steps: the handle is not the id. */
async function resolveYouTube(
  raw: string,
  ctx: LinkContext,
  now: string,
): Promise<ResolvedLink | null> {
  const handle = raw
    .replace(/^https?:\/\/(?:www\.|m\.)?youtube\.com\//i, "")
    .replace(/^(?:@|channel\/|user\/|c\/)/i, "")
    .replace(/[/?#].*$/, "");
  if (!handle) return null;

  const channelId = handle.startsWith("UC")
    ? handle
    : await ctx.innertube.resolveHandle(handle);
  if (!channelId) return null;

  const profile = await ctx.innertube.profile(channelId, {
    lang: ctx.lang ?? "en",
    about: true,
  });
  if (!profile) return null;

  const text = [
    profile.title,
    profile.description,
    ...(profile.links ?? []),
  ]
    .filter((value): value is string => !!value)
    .join(" ");

  return {
    link: {
      platform: "youtube",
      id: profile.id,
      handle: profile.handle,
      name: profile.title,
      url: `https://www.youtube.com/channel/${profile.id}`,
      subscribers: toCountRef(profile.subscribers),
      videoCount: profile.videos ?? null,
      viewCount: profile.views ?? null,
      avatar: profile.avatar,
      lastCheckedAt: now,
    },
    text,
    description: profile.description,
    country: profile.country,
  };
}

/** Converts an adapter channel into the dataset's link shape. */
export function platformLinkFromChannel(
  channel: PlatformChannel,
  now: string,
): PlatformLink {
  return {
    platform: channel.platform,
    id: channel.id,
    handle: channel.handle,
    name: channel.name,
    url: channel.url,
    subscribers: channel.subscribers,
    videoCount: channel.videoCount ?? null,
    viewCount: channel.viewCount ?? null,
    // A platform's "no avatar" picture is not an avatar.
    avatar: isPlaceholderAvatar(channel.avatar) ? null : channel.avatar,
    lastCheckedAt: now,
  };
}

/**
 * The identities a record already carries, as needles to look for in a
 * candidate profile.
 *
 * A Bilibili space id is the strongest: the performer links to their own
 * Bilibili from their YouTube description, and nobody else's description
 * contains it.
 */
export function identityNeedles(channel: Channel): string[] {
  const needles = new Set<string>();
  for (const link of channel.platforms ?? []) {
    const id = link.id?.trim().toLowerCase();
    if (id && id.length >= 4) needles.add(id);
    // The numeric Bilibili id is the one that appears in a YouTube about page.
    const url = link.url?.trim().toLowerCase();
    if (url) {
      needles.add(url.replace(/^https?:\/\//, "").replace(/\/+$/, ""));
    }
  }
  for (const [platform, handle] of Object.entries(channel.externals ?? {})) {
    const value = String(handle ?? "").trim().toLowerCase();
    if (value.length >= 3) needles.add(value.replace(/^@/, ""));
    if (platform === "twitter" && value) needles.add(value.replace(/^@/, ""));
  }
  return [...needles];
}

/**
 * The names that may confirm a **name-search** candidate: the display name,
 * and only the display name.
 *
 * Aliases are deliberately excluded. They are romanisations and translations
 * the pipeline added — vdb lists 「维多利亚」 as `Victoria` — and a common
 * romanisation matches something else entirely: the Canadian city of Victoria
 * has a YouTube channel, and it is not a VTuber. A link found in the
 * performer's **own text** is taken at face value and does not need this
 * check; a link found by searching a name does.
 *
 * The name also has to be distinctive: three CJK characters are a name, while
 * two are shared by too many performers (「小卯」, 「星野」), and three Latin
 * letters are an acronym dozens of channels share. `docs/SOURCES.md` states
 * the same rule.
 */
export function confirmingNames(channel: Channel): string[] {
  const name = normalizeName(channel.name ?? "");
  return isDistinctiveName(name) ? [name] : [];
}

/**
 * Whether a normalised name is distinctive enough to confirm an identity.
 *
 * Three CJK characters are a name, while two are shared by too many
 * performers (「小卯」, 「星野」), and six latin letters are the shortest name
 * that is not an acronym dozens of channels share. A roster row used as a
 * search query is held to the same rule: searching a two-character name
 * returns the wrong performer first.
 */
export function isDistinctiveName(name: string): boolean {
  const normalised = normalizeName(name ?? "");
  if (!normalised) return false;
  const cjk = (
    normalised.match(
      /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu,
    ) ?? []
  ).length;
  return cjk >= 2 ? normalised.length >= 3 : normalised.length >= 6;
}

/**
 * Whether a resolved profile is the same performer as the record.
 *
 * Two ways to say yes, and either is enough:
 *
 * 1. **The profile points back at the record** — the Bilibili space URL, the
 *    X handle, the Twitch login. A shared id is proof.
 * 2. **The profile's own name is one of the record's names**, and the name is
 *    distinctive (see below). A display name match is evidence, not proof,
 *    which is why the caller only uses it for a candidate that came from a
 *    **name** search in the first place.
 *
 * A one- or two-character name is not distinctive — 「ゆず」 belongs to
 * hundreds of channels — so it never confirms an identity on its own.
 */
export function confirmsIdentity(
  resolved: ResolvedLink,
  channel: Channel,
  candidate: LinkCandidate,
): boolean {
  const text = resolved.text.toLowerCase();
  for (const needle of identityNeedles(channel)) {
    if (needle.length >= 4 && text.includes(needle)) return true;
  }

  // A link found in the performer's own words is not a guess.
  if (candidate.via === "description" || candidate.via === "externals" ||
      candidate.via === "x-bio") {
    return true;
  }

  const channelNames = confirmingNames(channel);
  if (!channelNames.length) return false;
  const candidateName = normalizeName(resolved.link.name ?? "");
  if (!candidateName) return false;
  /**
   * Either side may carry the decoration the other dropped.
   *
   * 「雫るる_Official」 normalises to 「雫るるofficial」 — the suffix is not a
   * word in a CJK name, so `normalizeName()` keeps it — while the YouTube
   * channel is just 「雫るる」. The record's name is the distinctive one and
   * the channel's name is a *prefix* of it, so containment has to be tested
   * in both directions, not only candidate-inside-record.
   */
  return channelNames.some(
    (name) =>
      name === candidateName ||
      candidateName.includes(name) ||
      name.includes(candidateName),
  );
}

/**
 * The links an X profile advertises.
 *
 * X has no free read API, so the bio is read through the public **FxTwitter**
 * mirror, which returns the same profile JSON. The bio and the website field
 * are where a Japanese VTuber puts their YouTube channel — the pattern the
 * dataset is missing most.
 */
export async function linksFromXProfile(handle: string): Promise<LinkCandidate[]> {
  const clean = handle.replace(/^@/, "").replace(/[^A-Za-z0-9_]/g, "");
  if (!clean) return [];
  try {
    const res = await fetch(`https://api.fxtwitter.com/${clean}`, {
      headers: {
        Accept: "application/json",
        "User-Agent": "VSingerSingerTracker/1.0",
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return [];
    const json = (await res.json()) as {
      user?: {
        description?: string | null;
        website?: { url?: string | null } | null;
        location?: string | null;
      };
    };
    const user = json.user;
    if (!user) return [];
    const text = [
      user.description,
      user.website?.url,
      user.location,
    ]
      .filter(Boolean)
      .join(" ");
    return linksInText(text, "x-bio");
  } catch {
    return [];
  }
}

/**
 * The links a Wikidata item publishes.
 *
 * A Wikidata match is a **name** match here, so the caller has to verify it
 * through `confirmsIdentity()` before the link is written down.
 */
export function linksFromWikidata(match: {
  youtubeChannelId: string | null;
  externals: Record<string, string>;
}): LinkCandidate[] {
  const out: LinkCandidate[] = [];
  if (match.youtubeChannelId) {
    out.push({
      platform: "youtube",
      id: match.youtubeChannelId,
      via: "wikidata",
    });
  }
  const twitch = match.externals.twitch;
  if (twitch) out.push({ platform: "twitch", id: twitch, via: "wikidata" });
  return out;
}

/**
 * Adds the links that are missing from a record, and reports what it added.
 *
 * The caller owns the write: this function only mutates the record it is
 * given. A platform is only added once — the record's existing link is the
 * authority, and a second account on the same platform is a different
 * performer far more often than it is the same one.
 */
export async function addMissingLinks(
  channel: Channel,
  candidates: LinkCandidate[],
  ctx: LinkContext,
): Promise<ResolvedLink[]> {
  const added: ResolvedLink[] = [];
  const have = new Set((channel.platforms ?? []).map((link) => link.platform));

  for (const candidate of candidates) {
    if (have.has(candidate.platform)) continue;

    const resolved = await resolveCandidate(candidate, ctx);
    if (!resolved) continue;
    if (isPlaceholderName(resolved.link.name)) continue;
    /**
     * A **search** result can be the fan account, not the performer.
     *
     * 搬運組, 字幕組 and 切片 channels are named after the person they clip,
     * so a name search finds them first. A link the performer wrote down
     * themselves needs no such check — they would not link their own
     * re-uploader — but a name match does.
     */
    if (
      candidate.via === "search" &&
      (detectClipAccount(resolved.link.name, resolved.text) ||
        isFanAccountName(resolved.link.name))
    ) {
      continue;
    }
    if (!confirmsIdentity(resolved, channel, candidate)) continue;

    channel.platforms.push(resolved.link);
    have.add(candidate.platform);
    added.push(resolved);

    /**
     * The description is the richest text the project has, so the harvest is
     * repeated on the profile that was just fetched: a YouTube about page
     * usually links the performer's X, Twitch and Instagram in one place.
     */
    harvestExternals(channel, resolved.text);
  }
  return added;
}

/** Merges every platform handle found in `text` into `channel.externals`. */
export function harvestExternals(channel: Channel, text: string | null): void {
  if (!text) return;
  const found = extractExternalLinks(text);
  channel.externals = { ...(channel.externals ?? {}) };
  /**
   * `web:<n>` keys are **not** merged by position. The number means nothing
   * outside the description it came from, so a second description's
   * `web:1` is a different site; it is skipped rather than overwriting the
   * address already stored under that key.
   */
  let webCount = Object.keys(channel.externals).filter((key) =>
    key.startsWith("web:"),
  ).length;
  for (const [platform, handle] of Object.entries(found)) {
    if (platform === "youtube_video" || platform === "youtube_playlist") continue;
    if (platform === "web") continue;
    if (platform.startsWith("web:")) {
      if (webCount >= 2) continue;
      webCount += 1;
      channel.externals[`web:${webCount}`] = handle;
      continue;
    }
    if (!channel.externals[platform]) channel.externals[platform] = handle;
  }
}
