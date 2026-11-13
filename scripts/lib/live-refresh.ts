/**
 * The live pass: who is streaming right now, on every platform.
 *
 * This is split out of `scripts/sync.ts` because it is the one phase whose
 * cost is proportional to the **whole catalogue** rather than to a rotation:
 * every YouTube channel is one InnerTube Live-tab lookup, and there are
 * 63,000 of them. Inside the full sync that phase alone ran longer than the
 * job was allowed to live, so the run was killed before it wrote anything —
 * 45 minutes of network work and no commit.
 *
 * Run on its own (`--live-only`, `.github/workflows/live.yml`) it can repeat
 * as often as it fits, while the full sync stays short and always reaches the
 * write step.
 *
 * The outcome is the same either way: a stream that is live is stored as a
 * `live` item, a stream that stopped is retired to `past` with a real
 * duration, and a failed lookup changes nothing.
 */

import type { InnerTubeLive, InnerTubeSource } from "./youtubei";
import type { Channel, Item, PlatformId } from "./types";
import type {
  PlatformAdapter,
  PlatformChannel,
  PlatformUpload,
} from "./platforms";
import { primaryPlatformOf } from "./platforms";

/** The platforms whose `live()` adapter answers per channel. */
const PER_CHANNEL_LIVE_PLATFORMS = new Set<PlatformId>([
  "chzzk",
  "kick",
  "soop",
  "ci.me",
  "vk",
  "twitch",
]);

export interface LiveRefreshContext {
  /** Every channel in the catalogue, unfiltered. */
  channels: Channel[];
  /** The working item set, keyed by id. Mutated in place. */
  itemById: Map<string, Item>;
  /** Channel lookup by id, for the platform-wide feeds. */
  channelById: Map<string, Channel>;
  adapters: PlatformAdapter[];
  innertube: InnerTubeSource;
  now: string;
  /** How many YouTube channels this run may check. */
  limitLive: number;
  /**
   * Which window of the shard this run owns, 1-based.
   *
   * The shard is fixed by the id hash and `--shard N/M`; the page moves the
   * window inside it, so successive runs walk the shard instead of re-checking
   * the same channels. The scheduled workflow passes `GITHUB_RUN_NUMBER`.
   */
  page: number;
  /** How many per-channel platform links this run may check. */
  limitMultiPlatformLive: number;
  /**
   * How many YouTube lookups may be in flight at once. Defaults to 4.
   *
   * The rate limiter, not this number, sets the request rate — this only
   * decides how much network latency is hidden behind it.
   */
  concurrency?: number;
  /** Per-channel timeout in ms. Defaults to 10000 (10s). Null means default. */
  liveTimeoutMs?: number | null;
  /** The shard predicate the run was started with. */
  inShard: (channelId: string) => boolean;
  log: (msg: string) => void;
  /**
   * The item builders live in `sync.ts` (they are shared with the video
   * pipeline), so they are passed in rather than imported — importing them
   * would make this module and the pipeline import each other.
   */
  buildYouTubeItem: (
    live: {
      id: string;
      title: string;
      platform?: PlatformId;
      viewers?: number | null;
      thumbnail?: string | null;
      status?: "live" | "upcoming";
      scheduledStart?: string | null;
      actualStart?: string | null;
      isMember?: boolean | null;
    },
    channel: Channel,
    now: string,
  ) => Item | null;
  buildPlatformItem: (
    upload: PlatformUpload,
    now: string,
    owner?: Channel,
  ) => Item | null;
}

export interface LiveRefreshResult {
  /** Ids of the YouTube broadcasts found, for the optional Data API fill. */
  youtubeLiveItemIds: Set<string>;
  youtubeChecked: number;
  youtubeFound: number;
  youtubeRetired: number;
  multiPlatformChecked: number;
  multiPlatformFound: number;
  bilibiliChecked: number;
  niconicoChecked: number;
}

/**
 * Retires every stored live item of a platform that the platform no longer
 * reports.
 *
 * A live stream has no duration while it is live. When it ends, the length is
 * `actualEnd - actualStart` — the only moment the dataset can learn it, since
 * no API ever publishes it afterwards.
 */
function retireEndedStreams(
  items: Iterable<Item>,
  itemById: Map<string, Item>,
  platform: PlatformId,
  currentIds: Set<string>,
  now: string,
): number {
  let retired = 0;
  for (const item of items) {
    if (item.type !== "live" || item.platform !== platform) continue;
    if (item.status !== "live" && item.status !== "upcoming") continue;
    if (currentIds.has(item.id)) continue;
    const ended = itemById.get(item.id);
    if (!ended) continue;
    ended.status = "past";
    ended.actualEnd = ended.actualEnd ?? now;
    ended.publishedAt =
      ended.publishedAt ?? ended.actualStart ?? ended.scheduledStart ?? now;
    if (
      ended.duration === null &&
      ended.actualEnd &&
      (ended.actualStart || ended.publishedAt)
    ) {
      const start = ended.actualStart ?? ended.publishedAt;
      ended.duration = Math.floor(
        (Date.parse(ended.actualEnd) - Date.parse(start)) / 1000,
      );
    }
    ended.updatedAt = now;
    retired++;
  }
  return retired;
}

/** Keeps `addedAt` from the record already on disk, so history survives.
 *
 * Preserves enriched metadata (songTitle, originalArtist, tags, etc.) so
 * a live-status refresh never wipes curated song credits or duration data.
 */
function storeItem(itemById: Map<string, Item>, item: Item): void {
  const prev = itemById.get(item.id);
  if (!prev) {
    itemById.set(item.id, item);
    return;
  }
  itemById.set(item.id, {
    ...prev,
    ...item,
    addedAt: prev.addedAt ?? item.addedAt,
    songTitle: item.songTitle ?? prev.songTitle,
    originalArtist: item.originalArtist ?? prev.originalArtist,
    thumbnail: item.thumbnail ?? prev.thumbnail,
    description: item.description ?? prev.description,
    duration: item.duration ?? prev.duration,
    viewCount: item.viewCount ?? prev.viewCount,
    likeCount: item.likeCount ?? prev.likeCount,
    concurrentViewers: item.concurrentViewers ?? prev.concurrentViewers,
    publishedAt: item.publishedAt ?? prev.publishedAt,
    scheduledStart: item.scheduledStart ?? prev.scheduledStart,
    actualStart: item.actualStart ?? prev.actualStart,
    actualEnd: item.actualEnd ?? prev.actualEnd,
    tags: [...new Set([...(prev.tags ?? []), ...(item.tags ?? [])])].slice(0, 25),
  });
}

export async function refreshLivePass(
  ctx: LiveRefreshContext,
): Promise<LiveRefreshResult> {
  const { channels, itemById, channelById, adapters, innertube, now, log } = ctx;
  const result: LiveRefreshResult = {
    youtubeLiveItemIds: new Set<string>(),
    youtubeChecked: 0,
    youtubeFound: 0,
    youtubeRetired: 0,
    multiPlatformChecked: 0,
    multiPlatformFound: 0,
    bilibiliChecked: 0,
    niconicoChecked: 0,
  };

  const itemsByChannel = new Map<string, Item[]>();
  for (const item of itemById.values()) {
    const list = itemsByChannel.get(item.channelId) ?? [];
    list.push(item);
    itemsByChannel.set(item.channelId, list);
  }

  /* --- YouTube: the InnerTube Live tab ---------------------------------- */
  /**
   * InnerTube's channel Live tab is the live source.
   *
   * `liveBroadcasts.list` needs OAuth and the scheduled pipeline only has an
   * API key, so it cannot read another channel's broadcasts. The public Live
   * tab needs no quota and returns the currently live and upcoming entries.
   *
   * A check that succeeds but returns nothing is meaningful: the broadcast
   * that was live on the previous run has ended. A failed check (`null`)
   * changes nothing.
   */
  /**
   * A rotating window over the run's shard.
   *
   * Ordering by `lastItemsFetchedAt` looked like a rotation and was not one:
   * the live pass writes only the item files, so it never refreshes that field,
   * and every run on a shard picked the same channels — 4,000 distinct out of
   * 63,662 in a day, with 59,662 never checked at all. The ids are stable, so
   * the id order is, and the page is what advances: `page` × `limit` steps
   * through the shard and wraps, which covers it in `ceil(total / limit)`
   * visits with no cursor file to keep.
   */
  const candidates = channels
    .filter((c) => {
      const ytLink = c.platforms.find((p) => p.platform === "youtube");
      if (!ytLink || !ytLink.id) return false;
      return true;
    })
    .sort((a, b) => {
      const ytA = a.platforms.find((p) => p.platform === "youtube")!.id;
      const ytB = b.platforms.find((p) => p.platform === "youtube")!.id;
      return ytA.localeCompare(ytB);
    });

  const total = candidates.length;
  const limit = Math.max(0, ctx.limitLive);
  const start =
    total > limit ? ((Math.max(1, ctx.page) - 1) * limit) % total : 0;
  const liveTargets =
    start === 0
      ? candidates.slice(0, limit)
      : [
          ...candidates.slice(start, start + limit),
          ...candidates.slice(0, Math.max(0, start + limit - total)),
        ];

  if (liveTargets.length && innertube.isAvailable) {
    /**
     * The lookups run **concurrently**, but the results are applied in order.
     *
     * A check is two round-trips (~0.78 s measured with the 250 ms throttle),
     * so 6,000 channels sequentially is 78 minutes — longer than the job that
     * hosts it. The network is the cost, and it is almost all waiting, so a
     * pool of workers overlaps the waits while the rate limiter keeps the gap
     * between *requests* intact (`RateLimiter.wait()` serialises).
     *
     * Only the fetches overlap. `itemById` is still written in `liveTargets`
     * order, so the stored item order does not depend on which request came
     * back first — the pipeline stays deterministic (AGENTS rule 8).
     */
    const perChannelTimeoutMs = ctx.liveTimeoutMs || 10_000;
    const cutoffMs = Date.now() - 48 * 60 * 60 * 1000;

    /* --- Stage 1: RSS pre-filter pool (80 workers, CDN-cached) --------------
     *
     * Fetch all channel RSS feeds concurrently. Only channels with recent
     * videos (updated within 48h) or previously live/upcoming items advance
     * to Stage 2. Most channels return nothing, saving InnerTube requests.
     */
    const rssConcurrency = 80;
    const candidatesByChannelId = new Map<
      string,
      { id: string; title: string }[]
    >();
    const rssFailedChannelIds = new Set<string>();
    let rssCursor = 0;

    ctx.log(
      `rss scan: checking ${liveTargets.length} channel(s) with concurrency ${rssConcurrency}`,
    );

    const rssWorkers = Array.from(
      { length: Math.min(rssConcurrency, liveTargets.length) },
      async () => {
        for (;;) {
          const index = rssCursor++;
          if (index >= liveTargets.length) return;
          const channel = liveTargets[index]!;

          // Previously live/upcoming streams are always candidates so they
          // can be re-verified (24/7 streams, early-scheduled premieres).
          const activeItems = (itemsByChannel.get(channel.id) ?? []).filter(
            (item) =>
              item.platform === "youtube" &&
              (item.status === "live" || item.status === "upcoming"),
          );
          const activeVideoIds = new Set(
            activeItems.map((item) => item.id),
          );

          const recent = await innertube.fetchRSS(channel.id);
          if (recent === null && activeVideoIds.size === 0) {
            rssFailedChannelIds.add(channel.id);
            continue;
          }

          const videoMap = new Map<string, string>();
          for (const item of activeItems) {
            videoMap.set(item.id, item.title);
          }
          for (const entry of recent ?? []) {
            const updatedMs = Date.parse(entry.updated);
            if (!Number.isNaN(updatedMs) && updatedMs >= cutoffMs) {
              videoMap.set(entry.id, entry.title);
            }
          }

          if (videoMap.size > 0) {
            candidatesByChannelId.set(
              channel.id,
              [...videoMap.entries()].map(([id, title]) => ({ id, title })),
            );
          }
        }
      },
    );
    await Promise.all(rssWorkers);

    /* --- Stage 2: InnerTube /player pool (16 workers, rate-limited) -------
     *
     * Only channels with recent/active videos from Stage 1 are checked.
     * This cuts InnerTube requests by ~95% compared to checking every channel.
     */
    const channelsToVerify = liveTargets.filter((c) =>
      candidatesByChannelId.has(c.id),
    );
    const playerConcurrency = Math.max(1, Math.min(20, ctx.concurrency ?? 16));
    const streamsById = new Map<string, InnerTubeLive[] | null>();
    let playerCursor = 0;
    let checked = 0;
    let lastProgressAt = Date.now();

    const logProgress = (force: boolean): void => {
      const nowMs = Date.now();
      if (!force && nowMs - lastProgressAt < 5_000) return;
      lastProgressAt = nowMs;
      ctx.log(
        `innertube player: ${checked}/${channelsToVerify.length} candidate channel(s) verified`,
      );
    };

    ctx.log(
      `innertube player: verifying ${channelsToVerify.length}/${liveTargets.length} active channel(s) with concurrency ${playerConcurrency}`,
    );

    const playerWorkers = Array.from(
      { length: Math.min(playerConcurrency, channelsToVerify.length) },
      async () => {
        for (;;) {
          const index = playerCursor++;
          if (index >= channelsToVerify.length) return;
          const channel = channelsToVerify[index]!;
          const videos = candidatesByChannelId.get(channel.id) ?? [];

          const verifyChannel = async (): Promise<InnerTubeLive[]> => {
            const liveList: InnerTubeLive[] = [];
            for (const video of videos) {
              const state = await innertube.checkPlayerState(video.id);
              if (!state || (!state.isLive && !state.isUpcoming)) continue;
              liveList.push({
                id: video.id,
                title: state.title || video.title,
                description: state.description ?? null,
                tags: state.tags,
                duration: state.duration ?? null,
                viewCount: state.viewCount ?? null,
                isPremiere: state.isPremiere ?? false,
                thumbnail: null,
                status: state.isLive ? "live" : "upcoming",
                scheduledStart: state.isUpcoming ? state.start : null,
                actualStart: state.isLive ? state.start : null,
                actualEnd: state.end ?? null,
                isMember: state.isMember,
              });
            }
            return liveList;
          };

          const timeout = new Promise<null>((resolve) =>
            setTimeout(() => resolve(null), perChannelTimeoutMs),
          );
          streamsById.set(
            channel.id,
            await Promise.race([verifyChannel(), timeout]),
          );

          const c = ++checked;
          if (c % 25 === 0 || c === channelsToVerify.length) logProgress(false);
        }
      },
    );
    await Promise.all(playerWorkers);
    if (channelsToVerify.length > 0) logProgress(true);

    // Apply results deterministically in liveTargets order
    for (const channel of liveTargets) {
      if (rssFailedChannelIds.has(channel.id)) continue;

      // Channels skipped by Stage 1 had 304 Not Modified or no recent videos,
      // and no previously active items -> confirmed 0 live streams.
      const streams = candidatesByChannelId.has(channel.id)
        ? (streamsById.get(channel.id) ?? null)
        : [];

      if (streams === null) continue;
      result.youtubeChecked++;
      const current = new Set(streams.map((stream) => stream.id));
      result.youtubeFound += streams.length;

      for (const stream of streams) {
        const item = ctx.buildYouTubeItem(
          {
            id: stream.id,
            title: stream.title,
            platform: "youtube",
            thumbnail: stream.thumbnail,
            status: stream.status,
            scheduledStart: stream.scheduledStart,
            actualStart: stream.actualStart ?? null,
            isMember: stream.isMember ?? null,
          },
          channel,
          now,
        );
        if (!item) continue;

        // Populate extra metadata from InnerTube /player without Data API quota
        if (stream.description !== null) item.description = stream.description;
        if (stream.tags.length) item.tags = stream.tags;
        if (stream.duration !== null) item.duration = stream.duration;
        if (stream.viewCount !== null) item.viewCount = stream.viewCount;
        if (stream.isPremiere && item.category === "live") {
          item.category = "premiere";
        }

        storeItem(itemById, item);
        result.youtubeLiveItemIds.add(item.id);
      }

      result.youtubeRetired += retireEndedStreams(
        itemsByChannel.get(channel.id) ?? [],
        itemById,
        "youtube",
        current,
        now,
      );
    }
    log(
      `innertube live: checked ${result.youtubeChecked}/${liveTargets.length} channel(s), ` +
        `found ${result.youtubeFound}, stored ${result.youtubeLiveItemIds.size}, ` +
        `retired ${result.youtubeRetired}`,
    );
  } else if (liveTargets.length) {
    log("live: InnerTube unavailable — skipping live refresh");
  }

  /**
   * A schedule that has passed is no longer upcoming.
   *
   * Retirement above is per channel: it runs only for the channels this run
   * happened to check. An `upcoming` item whose broadcast aired before its
   * channel's next visit therefore lingered as "upcoming" for up to a full
   * sweep — and the catalogue is checked in pages, so a channel can wait a
   * day. The start time is now recorded, so the claim can be judged offline:
   * a broad grace period (12 h) covers even an unusually long stream, and
   * anything still live is re-stored as live by the next check, which
   * overwrites the status before this rule could touch it.
   */
  const UPCOMING_GRACE_MS = 12 * 3_600_000;
  const nowMs = Date.parse(now);
  let expiredUpcoming = 0;
  for (const item of itemById.values()) {
    if (item.type !== "live" || item.status !== "upcoming") continue;
    if (!item.scheduledStart) continue;
    const startMs = Date.parse(item.scheduledStart);
    if (!Number.isFinite(startMs) || nowMs - startMs < UPCOMING_GRACE_MS) continue;
    item.status = "past";
    item.actualEnd = item.actualEnd ?? now;
    item.publishedAt = item.publishedAt ?? item.scheduledStart;
    item.updatedAt = now;
    expiredUpcoming++;
  }
  if (expiredUpcoming) {
    log(`live: retired ${expiredUpcoming} scheduled stream(s) whose start has passed`);
  }

  /* --- the platforms with a per-channel live() adapter ------------------- */
  /**
   * CHZZK, KICK, SOOP, CI.ME and VK each expose a per-channel live endpoint.
   *
   * A record whose **own** platform is one of them is included even when it
   * has no YouTube channel — a CI.ME-only or KICK-only performer streams
   * there, and skipping it because its id is not a `UC…` id meant their live
   * streams were never checked at all.
   */
  const adapterById = new Map(adapters.map((a) => [a.id as string, a]));
  const multiTargets: {
    channel: Channel;
    platform: PlatformId;
    link: Channel["platforms"][number];
  }[] = [];
  for (const channel of channels) {
    const own = primaryPlatformOf(channel);
    const native = own ? PER_CHANNEL_LIVE_PLATFORMS.has(own) : false;
    const hasLiveLinks = channel.platforms.some((link) =>
      PER_CHANNEL_LIVE_PLATFORMS.has(link.platform),
    );
    if (!channel.id.startsWith("UC") && !native && !hasLiveLinks) continue;
    for (const link of channel.platforms) {
      if (!PER_CHANNEL_LIVE_PLATFORMS.has(link.platform)) continue;
      /**
       * Only targets whose adapter can actually answer are worth a slot.
       *
       * Twitch's adapter is absent without credentials, and those 2,257
       * links sort first (they have never been checked, so `lastCheckedAt`
       * is empty). Slicing `multiLimit` before this check let them consume
       * the entire budget and starved CI.ME / KICK / CHZZK / SOOP / VK —
       * the run reported "checked 1/8" with seven skips.
       */
      const adapter = adapterById.get(link.platform);
      if (!adapter?.live) continue;
      multiTargets.push({ channel, platform: link.platform, link });
    }
  }
  multiTargets.sort((a, b) =>
    (a.link.lastCheckedAt ?? "").localeCompare(b.link.lastCheckedAt ?? ""),
  );

  const multiLimit = Math.min(multiTargets.length, ctx.limitMultiPlatformLive);
  if (multiTargets.length) {
    ctx.log(
      `multi-platform live: starting ${multiLimit} channel(s) across ` +
        `${[...PER_CHANNEL_LIVE_PLATFORMS].join(", ")}`,
    );
  }
  let multiChecked = 0;
  let multiLastProgressAt = Date.now();
  const logMultiProgress = (force: boolean): void => {
    const nowMs = Date.now();
    if (!force && nowMs - multiLastProgressAt < 5_000) return;
    multiLastProgressAt = nowMs;
    ctx.log(
      `multi-platform live: ${multiChecked}/${multiLimit} channel(s) checked`,
    );
  };

  /**
   * Group targets by platform so batch-capable adapters (Twitch: Helix
   * `streams` accepts up to 100 ids/logins per request) are called once per
   * batch instead of once per channel. Without this, a job with thousands of
   * Twitch links hammered Helix with one `streams` call per channel and got
   * rate-limited (429) for every single one.
   */
  const byPlatform = new Map<
    PlatformId,
    { channel: Channel; platform: PlatformId; link: Channel["platforms"][number] }[]
  >();
  for (const target of multiTargets.slice(0, multiLimit)) {
    const bucket = byPlatform.get(target.platform) ?? [];
    bucket.push(target);
    byPlatform.set(target.platform, bucket);
  }

  for (const [platform, targets] of byPlatform) {
    const adapter = adapterById.get(platform);
    if (!adapter) continue;

    let streams: PlatformUpload[] = [];
    try {
      streams = adapter.liveMany
        ? await adapter.liveMany(
            targets.map((t) => ({
              platform: t.link.platform,
              id: t.link.id,
              handle: t.link.handle,
              name: t.link.name,
              url: t.link.url,
              subscribers: t.link.subscribers,
              avatar: t.link.avatar,
              description: null,
              tags: [],
            })),
          )
        : await Promise.all(
            targets.map((t) =>
              adapter.live!({
                platform: t.link.platform,
                id: t.link.id,
                handle: t.link.handle,
                name: t.link.name,
                url: t.link.url,
                subscribers: t.link.subscribers,
                avatar: t.link.avatar,
                description: null,
                tags: [],
              }),
            ),
          ).then((r) => r.flat());
    } catch (error) {
      log(
        `warn: ${platform} live check batch failed: ` +
          `${(error as Error).message}`,
      );
      continue;
    }

    result.multiPlatformChecked += targets.length;
    multiChecked += targets.length;
    if (multiChecked % 10 === 0 || multiChecked === multiLimit)
      logMultiProgress(false);

    const current = new Set(streams.map((stream) => stream.id));
    result.multiPlatformFound += streams.length;

    const ownerByLinkKey = new Map<string, Channel>();
    for (const target of targets) {
      if (target.link.id) ownerByLinkKey.set(target.link.id.toLowerCase(), target.channel);
      if (target.link.handle) ownerByLinkKey.set(target.link.handle.toLowerCase(), target.channel);
    }

    for (const stream of streams) {
      const owner = ownerByLinkKey.get(String(stream.channelId ?? "").toLowerCase());
      const item = ctx.buildPlatformItem(stream, now, owner);
      if (!item) continue;
      item.type = "live";
      item.status = stream.status ?? "live";
      item.platform = platform;
      storeItem(itemById, item);
    }

    for (const target of targets) {
      retireEndedStreams(
        itemsByChannel.get(target.channel.id) ?? [],
        itemById,
        platform,
        current,
        now,
      );
    }
  }

  if (multiTargets.length) {
    logMultiProgress(true);
    ctx.log(
      `multi-platform live: checked ${result.multiPlatformChecked}/` +
        `${multiLimit} channel(s) across ` +
        `${[...PER_CHANNEL_LIVE_PLATFORMS].join(", ")}, ` +
        `found ${result.multiPlatformFound}`,
    );
  }

  /* --- Bilibili: one partition-wide feed -------------------------------- */
  /**
   * Bilibili's live list is partition-wide (`online/list?rid=160`), not per
   * channel, so it is fetched once and matched against the channel ids the
   * dataset knows. A stream from a performer not in the catalogue is ignored,
   * which is what keeps the general live feed out of the dataset.
   */
  const bili = adapters.find((a) => a.id === "bilibili") as
    | (PlatformAdapter & {
        liveUploads?: PlatformUpload[];
        search?: (query: string, limit: number) => Promise<PlatformChannel[]>;
      })
    | undefined;
  if (bili?.search && bili.liveUploads !== undefined) {
    try {
      await bili.search("", 50);
      const liveStreams = bili.liveUploads ?? [];
      const currentIds = new Set(liveStreams.map((s) => s.id));
      let stored = 0;

      for (const stream of liveStreams) {
        const mid = stream.channelId;
        if (!mid) continue;
        const channel =
          channelById.get(mid) ?? channelById.get(`bilibili:${mid}`);
        if (!channel || !ctx.inShard(channel.id)) continue;
        result.bilibiliChecked++;

        const item = ctx.buildPlatformItem(stream, now, channel);
        if (!item) continue;
        item.type = "live";
        item.status = stream.status ?? "live";
        item.platform = "bilibili";
        storeItem(itemById, item);
        stored++;
      }

      const retired = retireEndedStreams(
        itemById.values(),
        itemById,
        "bilibili",
        currentIds,
        now,
      );
      log(
        `bilibili live: checked ${result.bilibiliChecked} channel(s), ` +
          `stored ${stored}, retired ${retired}`,
      );
    } catch (error) {
      log(`warn: bilibili live check failed: ${(error as Error).message}`);
    }
  }

  /* --- Niconico: one global live list ----------------------------------- */
  /**
   * Niconico's Content Search API v2 returns a global list of live programs
   * (`filters[liveStatus]=onair`), not a per-channel answer, so it is fetched
   * once and matched against the channels the dataset links to Niconico.
   */
  const nico = adapters.find((a) => a.id === "niconico") as
    | (PlatformAdapter & {
        liveUploads?: PlatformUpload[];
        live: (channel: PlatformChannel) => Promise<PlatformUpload[]>;
      })
    | undefined;
  if (nico?.live) {
    try {
      const dummyChannel: PlatformChannel = {
        platform: "niconico",
        id: "",
        handle: null,
        name: null,
        url: "https://www.nicovideo.jp/",
        subscribers: { tag: "hidden" },
        avatar: null,
        description: null,
        tags: [],
      };
      const liveStreams = await nico.live(dummyChannel);
      const currentIds = new Set(liveStreams.map((s) => s.id));
      let stored = 0;

      for (const stream of liveStreams) {
        const userId = stream.channelId;
        if (!userId) continue;
        const channel =
          channelById.get(userId) ?? channelById.get(`niconico:${userId}`);
        if (!channel || !ctx.inShard(channel.id)) continue;
        result.niconicoChecked++;

        const item = ctx.buildPlatformItem(stream, now, channel);
        if (!item) continue;
        item.type = "live";
        item.status = stream.status ?? "live";
        item.platform = "niconico";
        storeItem(itemById, item);
        stored++;
      }

      const retired = retireEndedStreams(
        itemById.values(),
        itemById,
        "niconico",
        currentIds,
        now,
      );
      log(
        `niconico live: checked ${result.niconicoChecked} channel(s), ` +
          `stored ${stored}, retired ${retired}`,
      );
    } catch (error) {
      log(`warn: niconico live check failed: ${(error as Error).message}`);
    }
  }

  return result;
}
