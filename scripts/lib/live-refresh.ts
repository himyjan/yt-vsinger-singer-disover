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

import type { InnerTubeSource } from "./youtubei";
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

/** Keeps `addedAt` from the record already on disk, so history survives. */
function storeItem(itemById: Map<string, Item>, item: Item): void {
  const prev = itemById.get(item.id);
  itemById.set(item.id, { ...item, addedAt: prev?.addedAt ?? item.addedAt });
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
    .filter((c) => c.id.startsWith("UC") && ctx.inShard(c.id))
    .sort((a, b) => a.id.localeCompare(b.id));

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
    for (const channel of liveTargets) {
      const streams = await innertube.liveStreams(channel.id);
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
          },
          channel,
          now,
        );
        if (!item) continue;
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
      multiTargets.push({ channel, platform: link.platform, link });
    }
  }
  multiTargets.sort((a, b) =>
    (a.link.lastCheckedAt ?? "").localeCompare(b.link.lastCheckedAt ?? ""),
  );

  for (const target of multiTargets.slice(0, ctx.limitMultiPlatformLive)) {
    const adapter = adapterById.get(target.platform);
    if (!adapter?.live) continue;

    try {
      const liveChannel: PlatformChannel = {
        platform: target.link.platform,
        id: target.link.id,
        handle: target.link.handle,
        name: target.link.name,
        url: target.link.url,
        subscribers: target.link.subscribers,
        avatar: target.link.avatar,
        description: null,
        tags: [],
      };
      const streams = await adapter.live(liveChannel);
      result.multiPlatformChecked++;
      if (!streams || streams.length === 0) continue;
      result.multiPlatformFound += streams.length;
      const current = new Set(streams.map((stream) => stream.id));

      for (const stream of streams) {
        const item = ctx.buildPlatformItem(stream, now, target.channel);
        if (!item) continue;
        item.type = "live";
        item.status = stream.status ?? "live";
        item.platform = target.platform;
        storeItem(itemById, item);
      }

      retireEndedStreams(
        itemsByChannel.get(target.channel.id) ?? [],
        itemById,
        target.platform,
        current,
        now,
      );
    } catch (error) {
      log(
        `warn: ${target.platform} live check failed for ${target.link.id}: ` +
          `${(error as Error).message}`,
      );
    }
  }
  if (multiTargets.length) {
    log(
      `multi-platform live: checked ${result.multiPlatformChecked}/` +
        `${Math.min(multiTargets.length, ctx.limitMultiPlatformLive)} channel(s) across ` +
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
        if (!channel) continue;
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
        if (!channel) continue;
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
