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
};

const EXTERNAL_META: Record<string, { label: string; icon: string }> = {
  x: { label: "X", icon: "𝕏" },
  twitter: { label: "X", icon: "𝕏" },
  instagram: { label: "Instagram", icon: "◎" },
  tiktok: { label: "TikTok", icon: "♪" },
  bilibili: { label: "Bilibili", icon: "📺" },
  niconico: { label: "Niconico", icon: "🎬" },
  discord: { label: "Discord", icon: "🎮" },
  spotify: { label: "Spotify", icon: "🎧" },
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
  if (full.externals) {
    for (const [platform, handles] of Object.entries(full.externals)) {
      const meta = EXTERNAL_META[platform] ?? {
        label: platform,
        icon: "🔗",
      };
      for (const handle of handles) {
        push({
          platform,
          label: meta.label,
          url: externalUrl(platform, handle),
          handle,
        });
      }
    }
  }

  // Order: the primary platform first, then YouTube, then everything else.
  const order = ["youtube", "twitch", "bilibili", "niconico", "vk"];
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
    case "discord":
      return `https://discord.gg/${handle}`;
    case "spotify":
      return `https://open.spotify.com/artist/${handle}`;
    default:
      return `https://${platform}/${handle}`;
  }
}

/** The canonical watch URL for an item. */
export function itemUrl(item: {
  id: string;
  type: string;
  platform?: string;
}): string {
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
