/**
 * Builds the "all links" block for a channel.
 *
 * A performer is usually present on several platforms, and their channel
 * description often links to a handful more. This collects every link we
 * know about into a single, consistently ordered list.
 */

import type { Channel, ChannelSummary, PlatformId } from "@shared/lib/types";
import { addressHost, toHref } from "@shared/lib/address";

export interface DisplayLink {
  platform: PlatformId | string;
  label: string;
  url: string;
  handle: string | null;
}

const PLATFORM_META: Record<
  PlatformId,
  { label: string; color: string; icon: string }
> = {
  youtube: { label: "YouTube", color: "#ff0000", icon: "▶" },
  twitch: { label: "Twitch", color: "#9146ff", icon: "◢" },
  bilibili: { label: "Bilibili", color: "#fb7299", icon: "📺" },
  niconico: { label: "Niconico", color: "#252525", icon: "🎬" },
  vk: { label: "VK", color: "#0077ff", icon: "◈" },
  chzzk: { label: "CHZZK", color: "#03c75a", icon: "🟢" },
  kick: { label: "KICK", color: "#53fc18", icon: "🟣" },
  soop: { label: "SOOP", color: "#ff6a00", icon: "🔴" },
  "ci.me": { label: "CI.ME", color: "#7b34f3", icon: "🟣" },
};

const EXTERNAL_META: Record<string, { label: string; icon: string }> = {
  youtube: { label: "YouTube", icon: "▶" },
  youtube_video: { label: "YouTube video", icon: "▶" },
  youtube_playlist: { label: "YouTube playlist", icon: "▶" },
  twitch: { label: "Twitch", icon: "◢" },
  x: { label: "X", icon: "𝕏" },
  twitter: { label: "X", icon: "𝕏" },
  instagram: { label: "Instagram", icon: "◎" },
  tiktok: { label: "TikTok", icon: "♪" },
  bilibili: { label: "Bilibili", icon: "📺" },
  niconico: { label: "Niconico", icon: "🎬" },
  vk: { label: "VK", icon: "◈" },
  chzzk: { label: "CHZZK", icon: "🟢" },
  kick: { label: "KICK", icon: "🟣" },
  soop: { label: "SOOP", icon: "🔴" },
  discord: { label: "Discord", icon: "🎮" },
  spotify: { label: "Spotify", icon: "🎧" },
  /** Not a platform: the address a `web:<n>` key holds. */
  website: { label: "Website", icon: "🌐" },
  "ci.me": { label: "CI.ME", icon: "🔗" },
};

/**
 * Platforms the dataset stores but has no adapter for.
 *
 * The rosters list a performer's Weibo, Pixiv, BOOTH, marshmallow, peing and
 * so on, and the drawer shows every one of them in the Followers list. A raw
 * key (`weiboByName`, `ci-en`) is not a label.
 */
const EXTRA_META: Record<string, { label: string; icon: string }> = {
  weibo: { label: "Weibo", icon: "🔴" },
  weiboByName: { label: "Weibo", icon: "🔴" },
  userlocal: { label: "UserLocal", icon: "📊" },
  peing: { label: "Peing", icon: "❓" },
  marshmallow: { label: "Marshmallow", icon: "🍡" },
  acfun: { label: "AcFun", icon: "🎬" },
  pixiv: { label: "pixiv", icon: "🎨" },
  booth: { label: "BOOTH", icon: "🛍" },
  afdian: { label: "爱发电", icon: "⚡" },
  popiask: { label: "Popiask", icon: "💬" },
  "amazon.co.jp": { label: "Amazon", icon: "📦" },
  showroom: { label: "SHOWROOM", icon: "📺" },
  pomeet: { label: "Pomeet", icon: "🍮" },
  github: { label: "GitHub", icon: "🐙" },
  fantia: { label: "Fantia", icon: "🎨" },
  facebook: { label: "Facebook", icon: "📘" },
  telegram: { label: "Telegram", icon: "✈️" },
  "ci-en": { label: "Ci-en", icon: "📝" },
  patreon: { label: "Patreon", icon: "🧡" },
  line: { label: "LINE", icon: "💬" },
  teespring: { label: "Teespring", icon: "👕" },
};

export function platformMeta(platform: string): {
  label: string;
  color: string;
  icon: string;
} {
  const known = PLATFORM_META[platform as PlatformId];
  if (known) return known;

  /**
   * Platforms a performer links to but the dataset has no adapter for —
   * `twitter`, `instagram`, `userlocal`, the address-only `other` / `web` /
   * `email`. They are still shown (the follower list lists every account),
   * so they need a readable label rather than the raw key.
   */
  const external = EXTERNAL_META[platform] ?? EXTRA_META[platform];
  if (external) return { label: external.label, color: "#6b7280", icon: external.icon };
  if (platform === "other" || platform === "web") {
    return { label: "Website", color: "#6b7280", icon: "🌐" };
  }
  if (platform === "email") {
    return { label: "Email", color: "#6b7280", icon: "✉️" };
  }
  return { label: platform, color: "#6b7280", icon: "🔗" };
}

/** Collects every known link for a channel, in a stable order. */
export function channelLinks(
  channel: Channel | ChannelSummary | null | undefined,
): DisplayLink[] {
  if (!channel) return [];
  const out: DisplayLink[] = [];
  const seen = new Set<string>();

  const push = (link: DisplayLink) => {
    if (seen.has(link.url)) return;
    seen.add(link.url);
    out.push(link);
  };

  // Platform identities.
  //
  // A full `Channel` record carries `platforms[]`; a `ChannelSummary` — the
  // lightweight projection used by list views — carries the same information
  // as `links[]`. Both shapes must work, because the channel drawer receives
  // whichever one the caller had to hand.
  const full = channel as Channel;
  const summary = channel as ChannelSummary;

  const platformLinks: DisplayLink[] = full.platforms?.length
    ? full.platforms.flatMap((p) => {
        /**
         * `other` / `web` / `email` carry an address rather than a platform
         * identity, and the rosters store it encoded. A value with no
         * resolvable address is dropped — a relative path on our own site is
         * a dead link.
         */
        const url = toHref(p.url) ?? toHref(p.id);
        if (!url) return [];
        const address = ["other", "web", "email"].includes(p.platform);
        return [{
          platform: p.platform as PlatformId,
          label: address ? addressLabel(url) : platformMeta(p.platform).label,
          url,
          handle: address ? null : p.handle,
        }];
      })
    : (summary.links ?? []).flatMap((l) => {
        const url = toHref(l.u);
        if (!url) return [];
        const address = ["other", "web", "email"].includes(l.p);
        return [{
          platform: l.p as PlatformId,
          label: address ? addressLabel(url) : platformMeta(l.p).label,
          url,
          handle: address ? null : l.h,
        }];
      });

  for (const link of platformLinks) push(link);

  // Extra external handles found in the channel description.
  const externals = full.externals ?? summary.externals;
  if (externals) {
    for (const [platform, handle] of Object.entries(externals)) {
      const meta = EXTERNAL_META[platform] ?? {
        label: platform.startsWith("web:") ? "Website" : platform,
        icon: "🔗",
      };
      const url = externalUrl(platform, handle);
      // No resolvable address: the handle is not a link, and a link that 404s
      // is worse than no link.
      if (!url) continue;
      push({
        platform,
        label: meta.label,
        url,
        // A `web:<n>` value is the address itself, not a handle to prefix.
        handle: platform.startsWith("web:") ? null : handle,
      });
    }
  }

  // Order: the primary platform first, then YouTube, then everything else.
  const order = [
    "youtube",
    "twitch",
    "bilibili",
    "niconico",
    "chzzk",
    "kick",
    "soop",
    "ci.me",
    "vk",
  ];
  out.sort((a, b) => {
    const ai = order.indexOf(a.platform);
    const bi = order.indexOf(b.platform);
    return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
  });

  return out;
}

/** Whether a string is already an absolute address. */
function isAbsoluteUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

/**
 * The label for a link a roster filed under `other` / `web` / `email`.
 *
 * Such a link is not a platform: it is an address the performer published.
 * Naming it after the host (`open.spotify.com`) says more than `other`, and
 * an e-mail address is labelled as one.
 */
function addressLabel(url: string): string {
  if (/^mailto:/i.test(url)) return "Email";
  return addressHost(url);
}

/**
 * Builds a profile URL for an external platform handle.
 *
 * Two shapes reach here: a **handle** for a known platform (`@KenshiYonezu`
 * on YouTube), and the **address itself** for `web:<n>` — a Spotify album, a
 * personal site, a shop. A key this function does not know has no URL scheme
 * to guess, and `https://<key>/<handle>` is a broken link; `null` tells the
 * caller to show the address instead.
 */
export function externalUrl(
  platform: string,
  handle: string,
): string | null {
  // `web:1` → the value is `open.spotify.com/album/…`, not a handle.
  if (platform.startsWith("web:")) {
    const trimmed = handle.trim();
    if (!trimmed) return null;
    return isAbsoluteUrl(trimmed) ? trimmed : `https://${trimmed}`;
  }

  switch (platform) {
    case "youtube":
      if (handle.startsWith("user/") || handle.startsWith("c/")) {
        return `https://www.youtube.com/${handle}`;
      }
      return handle.startsWith("UC")
        ? `https://www.youtube.com/channel/${handle}`
        : `https://www.youtube.com/@${handle.replace(/^@/, "")}`;
    case "youtube_video":
      return `https://www.youtube.com/watch?v=${encodeURIComponent(handle)}`;
    case "youtube_playlist":
      return `https://music.youtube.com/playlist?list=${encodeURIComponent(handle)}`;
    case "twitch":
      return `https://www.twitch.tv/${handle}`;
    case "x":
    case "twitter":
      return `https://x.com/${handle}`;
    case "instagram":
      return `https://instagram.com/${handle}`;
    case "tiktok":
      return `https://tiktok.com/@${handle}`;
    case "bilibili":
      return `https://space.bilibili.com/${handle}`;
    case "niconico":
      return `https://www.nicovideo.jp/user/${handle}`;
    case "vk":
      return `https://vk.com/${handle}`;
    case "chzzk":
      return `https://chzzk.naver.com/${handle}`;
    case "kick":
      return `https://kick.com/${handle}`;
    case "discord":
      return `https://discord.gg/${handle}`;
    case "spotify":
      return `https://open.spotify.com/${handle.includes("/") ? handle : `artist/${handle}`}`;
    case "soop":
      return `https://www.sooplive.com/station/${handle}`;
    case "ci.me":
      return `https://ci.me/${handle}`;
    default:
      /**
       * A key with no adapter — `other`, `email`, a platform added to the
       * dataset but not to this table. A value that is already an address is
       * usable; a bare handle has no site to put it on, and guessing
       * `https://<key>/<handle>` produces a link that 404s.
       */
      return isAbsoluteUrl(handle) ? handle : null;
  }
}

/** The canonical watch URL for an item. */
export function itemUrl(item: {
  id: string;
  type: string;
  platform?: string;
  url?: string;
}): string {
  if (item.url) return item.url;
  if (item.platform === "twitch") return `https://www.twitch.tv/`;
  if (item.platform === "bilibili") {
    return `https://www.bilibili.com/video/${item.id}`;
  }
  if (item.platform === "niconico") {
    return `https://www.nicovideo.jp/watch/${item.id}`;
  }
  if (item.platform === "vk") return `https://vk.com/video${item.id}`;
  if (item.type === "playlist") {
    return `https://www.youtube.com/playlist?list=${item.id}`;
  }
  return `https://www.youtube.com/watch?v=${item.id}`;
}
