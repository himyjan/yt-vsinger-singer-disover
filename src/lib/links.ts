/**
 * Builds the "all links" block for a channel.
 *
 * A performer is usually present on several platforms, and their channel
 * description often links to a handful more. This collects every link we
 * know about into a single, consistently ordered list.
 */

import type { Channel, ChannelSummary, PlatformId } from "@shared/lib/types";

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
  "ci.me": { label: "CI.ME", icon: "🔗" },
};

export function platformMeta(platform: string): {
  label: string;
  color: string;
  icon: string;
} {
  return (
    PLATFORM_META[platform as PlatformId] ?? {
      label: platform,
      color: "#6b7280",
      icon: "🔗",
    }
  );
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
    ? full.platforms.map((p) => ({
        platform: p.platform as PlatformId,
        label: platformMeta(p.platform).label,
        url: p.url,
        handle: p.handle,
      }))
    : (summary.links ?? []).map((l) => ({
        platform: l.p as PlatformId,
        label: platformMeta(l.p).label,
        url: l.u,
        handle: l.h,
      }));

  for (const link of platformLinks) push(link);

  // Extra external handles found in the channel description.
  const externals = full.externals ?? summary.externals;
  if (externals) {
    for (const [platform, handle] of Object.entries(externals)) {
      const meta = EXTERNAL_META[platform] ?? {
        label: platform,
        icon: "🔗",
      };
      push({
        platform,
        label: meta.label,
        url: externalUrl(platform, handle),
        handle,
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

/** Builds a profile URL for an external platform handle. */
export function externalUrl(platform: string, handle: string): string {
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
      return `https://${platform}/${handle}`;
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
