/**
 * KICK — the streaming platform.
 *
 * KICK has become a significant home for VTubers, and its public API needs
 * no credentials:
 *
 *   GET https://kick.com/api/v2/channels/{login}
 *
 * returns the channel's id, slug, follower count, the live stream, the bio,
 * the profile picture and the social accounts the performer listed. That one
 * request is the whole profile: KICK has no separate details endpoint.
 *
 * The avatar is `user.profile_pic`, not `user.profile_image_url` — an earlier
 * version read the YouTube-shaped field name, which KICK never sends, so
 * every KICK record silently kept a null avatar.
 *
 * ## Discovery
 *
 * KICK's category listing — `GET https://api.kick.com/public/v1/channels?
 * category_id=…` — needs an app access token (`KICK_CLIENT_ID` /
 * `KICK_CLIENT_SECRET`), and the `kick.com/public/…` paths answer 404 without
 * one. So this adapter refreshes known logins and their live stream, and KICK
 * identities enter the dataset through the roster, a seed or the suggestions
 * queue, where the details pass fills them in.
 */

import { classifyItem } from "../classify";
import type { CountRef, PlatformId } from "../types";
import type {
  PlatformAdapter,
  PlatformChannel,
  PlatformUpload,
} from "../platforms";
import { REQUEST_TIMEOUT_MS } from "../io";

const API = "https://kick.com/api/v2";

export interface KickOptions {
  /** How many channels to pull per request. */
  limit?: number;
  onLog?: (message: string) => void;
}

/**
 * KICK timestamps are `"2026-10-29 10:17:56"` — UTC, with a space instead of
 * the `T`, and no zone. `Date.parse()` reads that as **local** time, so a
 * stream that started at 10:17 UTC is stored three hours off in Tokyo. The
 * dataset stores ISO 8601 with a zone, so the value is normalised here.
 */
export function kickTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const cleaned = value.trim().replace(" ", "T");
  const withZone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(cleaned)
    ? cleaned
    : `${cleaned}Z`;
  const parsed = Date.parse(withZone);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

export class KickAdapter implements PlatformAdapter {
  readonly id: PlatformId = "kick";
  readonly label = "KICK";
  readonly color = "#53fc18";

  /**
   * KICK publishes no upload total — only the live stream and a VOD list with
   * no count — so a record on it never has one to fill.
   */
  readonly reportsVideoCount = false;

  private readonly limit: number;
  private readonly onLog: (message: string) => void;

  constructor(options: KickOptions = {}) {
    this.limit = options.limit ?? 30;
    this.onLog = options.onLog ?? (() => {});
  }

  isConfigured(): boolean {
    return true;
  }

  private async getJson<T>(url: string): Promise<T | null> {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: {
          Accept: "application/json",
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          Referer: "https://kick.com/",
        },
      });
      if (!res.ok) {
        this.onLog(`kick: request returned HTTP ${res.status}`);
        return null;
      }
      return (await res.json()) as T;
    } catch (error) {
      this.onLog(`kick: request failed: ${(error as Error).message}`);
      return null;
    }
  }

  async resolve(query: string): Promise<PlatformChannel | null> {
    const login = query
      .trim()
      .replace(/^@+/, "")
      .replace(/^https?:\/\/kick\.com\//, "")
      .split(/[/?#]/)[0]!;
    if (!login) return null;

    const data = await this.getJson<any>(`${API}/channels/${login}`);
    if (!data?.slug) return null;

    /**
     * The API answers by **slug**, so a lookup by the record's numeric id
     * returns whatever channel happens to own that slug — KICK does have a
     * channel called `1`. A record keyed by a numeric id whose login is
     * unknown must not be renamed after a different performer, so a numeric
     * lookup is only accepted when the ids match.
     */
    if (/^\d+$/.test(login)) {
      const ids = [data.user_id, data.id].map((v) => String(v ?? ""));
      if (!ids.includes(login)) {
        this.onLog(`kick: no channel with id ${login} (slug lookup returned ${data.slug})`);
        return null;
      }
    }

    const followers = Number(data.followers_count ?? 0);
    const subscribers: CountRef =
      followers > 0 ? { tag: "has", count: followers } : { tag: "no" };

    return {
      platform: "kick",
      id: String(data.user_id ?? data.id ?? data.slug),
      handle: data.slug,
      name: data.user?.username ?? data.slug,
      url: `https://kick.com/${data.slug}`,
      subscribers,
      // KICK serves *no picture* as `…/default1-fullsize.webp`, which
      // `isPlaceholderAvatar()` rejects before it reaches the record.
      avatar: data.user?.profile_pic ?? data.user?.profile_image_url ?? null,
      description: data.user?.bio ?? data.bio ?? null,
      tags: [],
      links: kickLinks(data.user),
    };
  }

  async uploads(
    channel: PlatformChannel,
    limit: number,
  ): Promise<PlatformUpload[]> {
    // KICK has no public video list — only the live stream.
    return this.live(channel).then((list) => list.slice(0, limit));
  }

  async live(channel: PlatformChannel): Promise<PlatformUpload[]> {
    if (!channel.handle) return [];
    const data = await this.getJson<any>(`${API}/channels/${channel.handle}`);
    const stream = data?.livestream;
    if (!stream) return [];

    const classified = classifyItem({
      title: stream.session_title ?? "",
      description: null,
      tags: [],
      channelKind: "virtual",
      status: "live",
      isShort: false,
      durationSeconds: null,
      channelRegion: "unknown",
    });

    const startedAt = kickTimestamp(stream.start_time ?? stream.created_at);

    return [
      {
        platform: "kick",
        id: String(stream.id),
        channelId: channel.id,
        title: stream.session_title ?? "",
        description: null,
        thumbnail:
          (typeof stream.thumbnail === "string"
            ? stream.thumbnail
            : stream.thumbnail?.url) ??
          stream.thumbnail_url ??
          null,
        publishedAt: startedAt,
        scheduledStart: startedAt,
        duration: null,
        status: "live",
        category: "live",
        songTitle: classified.songTitle,
        originalArtist: classified.originalArtist,
        viewCount: stream.viewer_count ?? null,
        url: `https://kick.com/${channel.handle}`,
      },
    ];
  }
}

/**
 * The accounts a KICK profile publishes beside its bio.
 *
 * The performer filled these in themselves, so they are evidence, not a
 * guess; `extractExternalLinks()` reads them like any other profile text.
 * Only the ones KICK actually sends are turned into URLs.
 */
function kickLinks(user: any): string[] {
  if (!user) return [];
  const links: string[] = [];
  const push = (url: string | null | undefined): void => {
    const value = (url ?? "").trim();
    if (value) links.push(value);
  };
  const handle = (value: unknown): string =>
    String(value ?? "")
      .trim()
      .replace(/^@+/, "");

  const youtube = handle(user.youtube);
  if (youtube) {
    push(
      /^https?:\/\//.test(youtube)
        ? youtube
        : youtube.startsWith("UC")
          ? `https://www.youtube.com/channel/${youtube}`
          : `https://www.youtube.com/@${youtube}`,
    );
  }
  const twitter = handle(user.twitter);
  if (twitter) {
    push(/^https?:\/\//.test(twitter) ? twitter : `https://x.com/${twitter}`);
  }
  const instagram = handle(user.instagram);
  if (instagram) {
    push(
      /^https?:\/\//.test(instagram)
        ? instagram
        : `https://www.instagram.com/${instagram}`,
    );
  }
  const tiktok = handle(user.tiktok);
  if (tiktok) {
    push(
      /^https?:\/\//.test(tiktok) ? tiktok : `https://www.tiktok.com/@${tiktok}`,
    );
  }
  const facebook = handle(user.facebook);
  if (facebook) {
    push(
      /^https?:\/\//.test(facebook)
        ? facebook
        : `https://www.facebook.com/${facebook}`,
    );
  }
  const discord = handle(user.discord);
  if (discord) push(discord);
  return links;
}
