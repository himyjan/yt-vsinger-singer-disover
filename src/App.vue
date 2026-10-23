<script setup lang="ts">
/**
 * VSinger & Singer Tracker — main application shell.
 *
 * Layout:
 *   • Desktop — a sticky header with the global scope switch, region filter,
 *     search bar and view tabs, then a responsive card grid.
 *   • Mobile — the same header, condensed, plus a fixed bottom tab bar.
 *
 * Every view is filtered through `filterItems` / `filterChannels`, which apply
 * the global scope switch (Virtual / Real / Both) and the region filter. That
 * is why the switch works in every part of the app without each view having
 * to know about it.
 */
import { computed, onMounted, reactive, ref, watch } from "vue";
import type {
  Channel,
  ChannelSummary,
  Item,
  RegionCode,
} from "@shared/lib/types";
import {
  loadAllChannels,
  loadItems,
  loadLive,
  loadManifest,
  loadSummaries,
  loadUpcoming,
  filterChannels,
  filterItems,
  formatCount,
  resetDatasetCache,
  search,
  sortChannels,
  sortItems,
} from "@/lib/dataset";
import {
  activeAccount,
  addAccount,
  type LinkedAccount,
  allAccounts,
  allSubscriptions,
  clearSuggested,
  initTheme,
  isSuggested,
  markSuggested,
  removeAccount,
  setActiveAccount,
  setRegion,
  setScope,
  setSubscriptions,
  setView,
  setYouTubeBadge,
  setYouTubeDetail,
  state,
  subscriptionKey,
  suggestedKey,
  toggleSaved,
  toggleTheme,
  showToast,
  YOUTUBE_BADGE_TTL_MS,
  type Scope,
  type Subscription,
  type ViewId,
} from "@/lib/store";
import {
  AUTH_PROVIDERS,
  normalizeForMatch,
  type AuthProvider,
  type ProviderAccount,
} from "@/lib/auth";
import { parseSubscriptionsFile } from "@/lib/takeout";
import { SUBS_EXPORT_SCRIPT } from "@/lib/subs-export";
import { fetchYouTubeChannel, type YouTubeChannelDetail } from "@/lib/youtube-detail";
import { channelLinks, itemUrl, platformMeta } from "@/lib/links";
import LiveCard from "@/components/LiveCard.vue";
import ChannelCard from "@/components/ChannelCard.vue";
import ChannelDrawer from "@/components/ChannelDrawer.vue";
import SubscriptionDetail from "@/components/SubscriptionDetail.vue";
import OfficialArtistBadge from "@/components/OfficialArtistBadge.vue";

/* -------------------------------------------------------------------------- */
/* State                                                                      */
/* -------------------------------------------------------------------------- */

const manifest = ref<Awaited<ReturnType<typeof loadManifest>>>(null);
const summaries = ref<ChannelSummary[]>([]);
const channels = ref<Channel[]>([]);
const live = ref<Item[]>([]);
const upcoming = ref<Item[]>([]);
const allItems = ref<Item[]>([]);
const loading = ref(true);
const searchHits = ref<any[]>([]);
const searching = ref(false);

const drawerChannel = ref<Channel | null>(null);
const drawerItem = ref<Item | null>(null);
/** The subscription's fresh 🎵 result, when it is newer than the dataset. */
const drawerBadgeOverride = ref(false);

/**
 * The one untracked subscription whose YouTube details are open.
 *
 * Tracked channels use `ChannelDrawer`; this path exists because the card
 * itself only has the subscription feed's four fields. The request is made
 * on open and cached, never for all 4,800 cards.
 */
const activeSub = ref<Subscription | null>(null);
const activeSubDetail = ref<YouTubeChannelDetail | null>(null);
const subDetailLoading = ref(false);
const subDetailError = ref("");
let subDetailRequest = 0;

/**
 * Background 🎵 badge sync.
 *
 * The TV subscription feed does not carry `AUDIO_BADGE`, so one channel page
 * is read per channel. It is intentionally a background task with a visible
 * progress/stop control; the result is cached, and a completed sync does not
 * run again for a month.
 */
const badgeSync = reactive({
  running: false,
  done: 0,
  total: 0,
  failed: 0,
  stopped: false,
  error: "",
});
let badgeAbort: AbortController | null = null;
let badgeTimer: ReturnType<typeof setTimeout> | null = null;
/** Invalidates an earlier run when Stop and Resume race. */
let badgeRunToken = 0;

const channelById = computed(() => {
  const map = new Map<string, Channel>();
  for (const channel of channels.value) map.set(channel.id, channel);
  return map;
});

const summaryById = computed(() => {
  const map = new Map<string, ChannelSummary>();
  for (const summary of summaries.value) map.set(summary.id, summary);
  return map;
});

/**
 * A name index for subscriptions.
 *
 * A subscription can be matched to the dataset by name when its channel id
 * differs — a performer's YouTube topic channel, for example. The stored
 * `known` flag uses that rule, so opening the card must use it too; otherwise
 * a tracked card opens the untracked detail modal.
 */
const summaryByName = computed(() => {
  const map = new Map<string, ChannelSummary>();
  for (const summary of summaries.value) {
    const key = normalizeForMatch(summary.name);
    if (!map.has(key)) map.set(key, summary);
  }
  return map;
});

/**
 * Per-channel projections used by the subscription cards.
 *
 * They are built once from the dataset, not per card. A tracked subscription
 * shows the dataset's live/upcoming/song state; an untracked one gets the
 * detail snapshot only after it is opened.
 */
const liveByChannel = computed(() => {
  const map = new Map<string, Item>();
  for (const item of live.value) {
    if (!map.has(item.channelId)) map.set(item.channelId, item);
  }
  return map;
});

const upcomingByChannel = computed(() => {
  const map = new Map<string, Item>();
  for (const item of upcoming.value) {
    if (!map.has(item.channelId)) map.set(item.channelId, item);
  }
  return map;
});

const songCountByChannel = computed(() => {
  const map = new Map<string, number>();
  const songCategories = new Set(["cover", "mv", "original", "performance"]);
  for (const item of allItems.value) {
    if (!songCategories.has(item.category)) continue;
    map.set(item.channelId, (map.get(item.channelId) ?? 0) + 1);
  }
  return map;
});

/* -------------------------------------------------------------------------- */
/* Filtering                                                                  */
/* -------------------------------------------------------------------------- */

const CATEGORIES = [
  { id: "cover", label: "Covers" },
  { id: "mv", label: "MVs" },
  { id: "original", label: "Originals" },
  { id: "live", label: "Live" },
  { id: "premiere", label: "Premieres" },
  { id: "performance", label: "Performances" },
] as const;

const SUB_FILTERS = [
  { id: "all", label: "All", countKey: "all" },
  { id: "tracked", label: "Tracked", countKey: "tracked" },
  { id: "untracked", label: "Not tracked", countKey: "untracked" },
  { id: "suggested", label: "Suggested", countKey: "suggested" },
] as const;

/** The subscribed / not-subscribed filter of the Channels view. */
const CHANNEL_SUB_FILTERS = [
  { id: "all", label: "All" },
  { id: "subscribed", label: "Subscribed" },
  { id: "not-subscribed", label: "Not subscribed" },
] as const;

const LANGUAGES = [
  { id: "all", label: "Any language", title: "Every performer" },
  { id: "ja", label: "🇯🇵 日本語", title: "Performers who stream in Japanese" },
  { id: "yue", label: "🇭🇰 廣東語", title: "Performers who stream in Cantonese" },
  { id: "zh-Hans", label: "🇨🇳 简体中文", title: "Performers who stream in Simplified Chinese" },
  { id: "zh-Hant", label: "🇹🇼 繁體中文", title: "Performers who stream in Traditional Chinese" },
  { id: "ko", label: "🇰🇷 한국어", title: "Performers who stream in Korean" },
  { id: "en", label: "🌐 English", title: "Performers who stream in English" },
] as const;

/** The sort options for each tab. */
const SORTS: Record<
  ViewId,
  { id: string; label: string }[]
> = {
  live: [
    { id: "recent", label: "Newest" },
    { id: "viewers", label: "Most viewers" },
    { id: "title", label: "Title" },
  ],
  upcoming: [
    { id: "soon", label: "Soonest" },
    { id: "title", label: "Title" },
  ],
  songs: [
    { id: "recent", label: "Newest" },
    { id: "oldest", label: "Oldest" },
    { id: "views", label: "Most viewed" },
    { id: "duration", label: "Longest" },
    { id: "title", label: "Title" },
  ],
  channels: [
    { id: "subscribers", label: "Most followers" },
    { id: "name", label: "Name" },
    { id: "region", label: "Region" },
    { id: "recent", label: "Recently added" },
  ],
  subs: [
    { id: "name", label: "Name" },
    { id: "platform", label: "Platform" },
    { id: "tracked", label: "Tracked first" },
  ],
  saved: [
    { id: "recent", label: "Newest" },
    { id: "oldest", label: "Oldest" },
    { id: "title", label: "Title" },
  ],
};

const AFFILIATION_FILTERS = [
  { id: "all", label: "Any affiliation", title: "Every performer" },
  {
    id: "independent",
    label: "🎪 Independent",
    title: "Solo performers with no agency behind them",
  },
  {
    id: "group",
    label: "🏢 Agency",
    title: "Performers signed to a business group — 企業勢",
  },
  {
    id: "community",
    label: "👥 Community",
    title: "Performers in a fan circle rather than a company — 社團勢",
  },
] as const;

const SINGING_FILTERS = [
  { id: "all", label: "Any content", title: "Every performer" },
  {
    id: "singing",
    label: "🎤 Singing",
    title: "Performers who publish covers, MVs, original songs or live singing",
  },
  {
    id: "not-singing",
    label: "Not singing",
    title: "Performers whose content is not singing",
  },
] as const;

const GENDERS = [
  { id: "all", label: "Any gender" },
  { id: "female", label: "♀ Female" },
  { id: "male", label: "♂ Male" },
] as const;

const visibleLive = computed(() =>
  sortItems(filterItems(live.value, {
    kind: state.scope,
    region: state.region,
    categories: state.categories,
    gender: state.gender,
    ai: state.ai,
    affiliation: state.affiliation,
    language: state.language,
    limit: 300,
  }), state.sort.live),
);

const visibleUpcoming = computed(() =>
  sortItems(filterItems(upcoming.value, {
    kind: state.scope,
    region: state.region,
    gender: state.gender,
    ai: state.ai,
    affiliation: state.affiliation,
    language: state.language,
    limit: 300,
  }), state.sort.upcoming),
);

const visibleSongs = computed(() =>
  sortItems(
    filterItems(
      allItems.value.filter((i) =>
        ["cover", "mv", "original", "performance"].includes(i.category),
      ),
      {
        kind: state.scope,
        region: state.region,
        categories: state.categories,
        acoustic: state.acousticOnly,
        gender: state.gender,
        ai: state.ai,
        affiliation: state.affiliation,
        language: state.language,
        limit: 400,
      },
    ),
    state.sort.songs,
  ),
);

const visibleChannels = computed(() => {
  const channels = filterChannels(summaries.value, {
    kind: state.scope,
    region: state.region,
    gender: state.gender,
    ai: state.ai,
    affiliation: state.affiliation,
    language: state.language,
    singing: state.singing,
    oac: state.oac,
    text: state.query.trim() || undefined,
    limit: 400,
  });

  /**
   * Subscribed / not subscribed. Only meaningful once an account is linked,
   * and matched through the same id-or-name rule the subscriptions use, so a
   * YouTube subscription of a channel catalogued under its Twitch id is
   * still recognised as "subscribed".
   */
  const filtered =
    !hasAnyAccount.value || state.channelSubs === "all"
      ? channels
      : channels.filter((channel) =>
          state.channelSubs === "subscribed"
            ? subscribedChannelIds.value.has(channel.id)
            : !subscribedChannelIds.value.has(channel.id),
        );

  return sortChannels(filtered, state.sort.channels);
});

const linkedProviders = computed(() =>
  AUTH_PROVIDERS.filter((provider) => (state.accounts[provider.id] ?? []).length > 0),
);

const hasAnyAccount = computed(() => allAccounts().length > 0);

/** The account popover. */
const showAccountMenu = ref(false);

/**
 * Whether the page is served by the local dev server.
 *
 * Production is static: nothing can write to `data/`. The Suggest and Import
 * controls therefore probe the dataset API once and fall back to a
 * downloadable file when it is absent.
 */
const datasetApi = ref<"unknown" | "available" | "unavailable">("unknown");
/** The permission gate for writing subscriptions into the dataset. */
const syncConsent = ref(false);
const syncing = ref(false);
const syncState = ref<{
  done: number;
  total: number;
  added: number;
  failed: number;
} | null>(null);
/** The “Export from YouTube” instructions. */
const showSubsExport = ref(false);
const subsScriptCopied = ref(false);

/** Short random id for a newly linked account. */
function randomId(): string {
  return Math.random().toString(36).slice(2, 10);
}

const visibleSubscriptions = computed(() =>
  allSubscriptions().filter((sub) => {
    if (state.scope !== "both" && sub.kind !== state.scope) return false;
    if (state.region !== "all" && sub.region && sub.region !== state.region) {
      return false;
    }
    if (state.subsTracked === "tracked" && !sub.known) return false;
    if (state.subsTracked === "untracked" && sub.known) return false;
    if (state.subsTracked === "suggested" && !isSubSuggested(sub)) return false;
    return true;
  }),
);

const subscriptionCounts = computed(() => {
  const all = allSubscriptions();
  return {
    all: all.length,
    tracked: all.filter((s) => s.known).length,
    untracked: all.filter((s) => !s.known).length,
    suggested: all.filter((s) => isSubSuggested(s)).length,
  };
});

/** Every subscription the dataset does not have yet. */
const untrackedSubscriptions = computed(() =>
  allSubscriptions().filter((sub) => !sub.known),
);

/** How many channels sit on the suggestion list right now. */
const suggestedCount = computed(() => state.suggested.length);

function isSubSuggested(sub: Subscription): boolean {
  return isSuggested(sub.provider, sub.channelId);
}

/**
 * The dataset channels the linked accounts follow.
 *
 * A subscription carries the platform's own channel id, while the dataset may
 * key the same performer by another platform's id, so the name is also
 * matched — the same rule `linkProvider` uses to mark a subscription as
 * `known`. Both an exact id and a name match count.
 */
const subscribedChannelIds = computed(() => {
  const ids = new Set<string>();
  const byName = new Map<string, string>();
  for (const summary of summaries.value) {
    byName.set(normalizeForMatch(summary.name), summary.id);
  }
  for (const sub of allSubscriptions()) {
    if (sub.channelId) ids.add(sub.channelId);
    const named = byName.get(normalizeForMatch(sub.title));
    if (named) ids.add(named);
  }
  return ids;
});

/**
 * The saved channels.
 *
 * A bookmark can name a channel that is not in the **currently loaded**
 * region: the shards are downloaded per region, so a `cn` channel saved
 * while browsing `jp` would resolve to nothing. Those records are fetched
 * once and kept in their own cache, which the region watcher cannot replace.
 */
const savedChannelCache = ref(new Map<string, ChannelSummary>());

const savedChannels = computed<ChannelSummary[]>(() => {
  const out: ChannelSummary[] = [];
  for (const entry of state.saved) {
    if (entry.kind !== "channel") continue;
    const channel =
      summaryById.value.get(entry.id) ?? savedChannelCache.value.get(entry.id);
    if (!channel) continue;
    if (state.scope !== "both" && channel.kind !== state.scope) continue;
    out.push(channel);
  }
  return sortChannels(out, state.sort.saved);
});

const visibleSaved = computed(() => {
  const items: Item[] = [];
  for (const entry of state.saved) {
    if (entry.kind !== "item") continue;
    const found = allItems.value.find((i) => i.id === entry.id);
    if (found) items.push(found);
  }
  return sortItems(
    state.scope === "both"
      ? items
      : items.filter((item) => item.channelKind === state.scope),
    state.sort.saved,
  );
});

/**
 * Loads the saved channels that the current region has not downloaded.
 *
 * It is a no-op when the region filter is `all` — that is the default, and
 * the set is already in memory.
 */
async function loadSavedChannels(): Promise<void> {
  const ids = state.saved
    .filter((entry) => entry.kind === "channel")
    .map((entry) => entry.id);
  const missing = ids.filter(
    (id) =>
      !summaryById.value.has(id) && !savedChannelCache.value.has(id),
  );
  if (!missing.length) return;
  const all = await loadSummaries("all");
  const next = new Map(savedChannelCache.value);
  for (const summary of all) {
    if (missing.includes(summary.id)) next.set(summary.id, summary);
  }
  savedChannelCache.value = next;
}

/* -------------------------------------------------------------------------- */
/* Search                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Reloads the channel data when the region filter changes.
 *
 * The channel datasets are sharded by region, so only the selected region is
 * downloaded — which keeps a 14,000-performer roster cheap to browse.
 */
watch(
  () => state.region,
  async (region) => {
    const regions = region === "all" ? "all" : [region];
    const [s, c] = await Promise.all([
      loadSummaries(regions),
      loadAllChannels(regions),
    ]);
    summaries.value = s;
    channels.value = c;
  },
);

/**
 * The Saved tab may name a channel from a region that is not loaded, so the
 * bookmarks are resolved whenever the tab is opened or a bookmark changes.
 */
watch(
  () => [state.view, state.saved.length],
  () => {
    if (state.view === "saved") void loadSavedChannels();
  },
  { immediate: true },
);

let searchTimer: number | undefined;

watch(
  () => [state.query, state.scope, state.region],
  () => {
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(runSearch, 180);
  },
);

async function runSearch(): Promise<void> {
  const query = state.query.trim();
  if (!query) {
    searchHits.value = [];
    return;
  }
  searching.value = true;
  try {
    const hits = await search(query, {
      kind: state.scope,
      region: state.region,
      limit: 120,
    });
    searchHits.value = hits.map((h) => h.entry);
  } catch (err) {
    console.error(err);
  } finally {
    searching.value = false;
  }
}

/* -------------------------------------------------------------------------- */
/* Actions                                                                    */
/* -------------------------------------------------------------------------- */

const VIEWS: { id: ViewId; label: string; short: string }[] = [
  { id: "live", label: "Live now", short: "Live" },
  { id: "upcoming", label: "Upcoming", short: "Upcoming" },
  { id: "songs", label: "Songs", short: "Songs" },
  { id: "channels", label: "Channels", short: "Channels" },
  { id: "subs", label: "My subscriptions", short: "Subs" },
  { id: "saved", label: "Saved", short: "Saved" },
];

function selectScope(scope: Scope): void {
  setScope(scope);
}

/**
 * Toggles a content category. Several can be active at once — "MVs" and
 * "Covers" together is a query people actually want.
 */
/** Sets the sort order of a view. */
function setSort(view: ViewId, order: string): void {
  (state.sort as Record<string, string>)[view] = order;
}

function toggleCategory(id: string): void {
  const index = state.categories.indexOf(id as never);
  if (index >= 0) state.categories.splice(index, 1);
  else state.categories.push(id as never);
}

function openChannel(
  channel: Channel | ChannelSummary | null | undefined,
  badgeOverride = false,
): void {
  if (!channel) return;
  const full = channelById.value.get(channel.id);
  drawerChannel.value = full ?? (channel as Channel);
  drawerBadgeOverride.value = badgeOverride;
  drawerItem.value = null;
}

function openItem(item: Item): void {
  drawerItem.value = item;
  drawerChannel.value = channelById.value.get(item.channelId) ?? null;
  drawerBadgeOverride.value = false;
}

/** Whether a subscription's channel is in the local dataset. */
function knownSubscription(sub: Subscription): ChannelSummary | null {
  return (
    summaryById.value.get(sub.channelId) ??
    summaryByName.value.get(normalizeForMatch(sub.title)) ??
    null
  );
}

/**
 * Opens a subscription card.
 *
 * A tracked channel has a full `ChannelDrawer`; an untracked one has only the
 * subscription feed's four fields, so its YouTube details are fetched on this
 * click and shown in a small modal.
 */
function openSubscription(sub: Subscription): void {
  const known = knownSubscription(sub);
  if (known) {
    openChannel(known, hasOfficialArtistBadge(sub));
    return;
  }

  activeSub.value = sub;
  activeSubDetail.value = state.youtubeDetails[sub.channelId] ?? null;
  subDetailError.value = "";
  subDetailLoading.value = false;
  void loadSubDetail(sub);
}

/** Fetches (or refreshes) the currently open untracked subscription. */
async function loadSubDetail(
  sub: Subscription,
  force = false,
): Promise<void> {
  /** Invalidate any request that was open before this card. */
  const request = ++subDetailRequest;
  const cached = state.youtubeDetails[sub.channelId];
  if (!force && cached) {
    activeSubDetail.value = cached;
    subDetailError.value = "";
    subDetailLoading.value = false;
    return;
  }

  subDetailError.value = "";
  activeSubDetail.value = cached ?? activeSubDetail.value;

  if (datasetApi.value !== "available") {
    subDetailError.value =
      "Channel details need the local dev server (npm run dev). The static build can only show the subscription feed's fields.";
    return;
  }

  subDetailLoading.value = true;
  try {
    const detail = await fetchYouTubeChannel(sub.channelId, true);
    if (request !== subDetailRequest) return;
    setYouTubeDetail(detail);
    activeSubDetail.value = detail;
  } catch (error) {
    if (request !== subDetailRequest) return;
    subDetailError.value = (error as Error).message;
  } finally {
    if (request === subDetailRequest) subDetailLoading.value = false;
  }
}

function closeSubDetail(): void {
  subDetailRequest += 1;
  activeSub.value = null;
  activeSubDetail.value = null;
  subDetailLoading.value = false;
  subDetailError.value = "";
}

function retrySubDetail(): void {
  if (activeSub.value) void loadSubDetail(activeSub.value, true);
}

/* -------------------------------------------------------------------------- */
/* Official Artist sync                                                       */
/* -------------------------------------------------------------------------- */

/** Every unique YouTube channel id among the stored subscriptions. */
function youtubeSubscriptionIds(): string[] {
  const ids = new Set<string>();
  for (const sub of allSubscriptions()) {
    if (sub.provider !== "youtube") continue;
    if (!/^UC[\w-]{20,}$/.test(sub.channelId)) continue;
    ids.add(sub.channelId);
  }
  return [...ids];
}

/** The channels whose cached badge is missing or older than the TTL. */
function missingYouTubeBadgeIds(): string[] {
  const now = Date.now();
  return youtubeSubscriptionIds().filter((id) => {
    const cached = state.youtubeBadges[id];
    return (
      !cached ||
      typeof cached.checkedAt !== "number" ||
      !Number.isFinite(cached.checkedAt) ||
      now - cached.checkedAt > YOUTUBE_BADGE_TTL_MS
    );
  });
}

/** Starts the background sync after the subs view has settled. */
function scheduleBadgeSync(): void {
  if (badgeSync.running || badgeSync.stopped) return;
  if (datasetApi.value !== "available") return;
  if (state.view !== "subs") return;
  if (missingYouTubeBadgeIds().length === 0) return;

  if (badgeTimer) clearTimeout(badgeTimer);
  badgeTimer = setTimeout(() => {
    badgeTimer = null;
    if (state.view === "subs" && datasetApi.value === "available") {
      void startBadgeSync();
    }
  }, 1200);
}

/**
 * Reads the 🎵 badge for every subscription, two at a time.
 *
 * One `getChannel` per channel; the server limits itself to two in flight as
 * well. A 404 means the channel is gone and is recorded as "not an artist";
 * a 429 stops the sync rather than turning a rate limit into 4,800 failed
 * requests. A run that is stopped resumes from the uncached channels.
 */
async function startBadgeSync(): Promise<void> {
  if (badgeSync.running) return;
  if (datasetApi.value !== "available") {
    badgeSync.error = "Music badges need the local dev server (npm run dev).";
    return;
  }

  const ids = missingYouTubeBadgeIds();
  if (ids.length === 0) return;

  const runToken = ++badgeRunToken;
  badgeSync.running = true;
  badgeSync.stopped = false;
  badgeSync.done = 0;
  badgeSync.failed = 0;
  badgeSync.total = ids.length;
  badgeSync.error = "";
  badgeAbort = new AbortController();
  const signal = badgeAbort.signal;

  let next = 0;
  let consecutiveFailures = 0;
  /** Shared by both workers: one rate limit stops the whole run. */
  let stopAll = false;

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms));

  const worker = async (): Promise<void> => {
    while (!signal.aborted && !stopAll && next < ids.length) {
      const channelId = ids[next++];
      try {
        const res = await fetch("/api/youtube/channel", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({ id: channelId, detail: false }),
          signal,
        });

        if (res.status === 404) {
          setYouTubeBadge(channelId, false);
          consecutiveFailures = 0;
        } else if (res.status === 429) {
          badgeSync.error =
            "YouTube is rate-limiting the badge sync. It will resume from here next time.";
          stopAll = true;
        } else if (!res.ok) {
          badgeSync.failed += 1;
          consecutiveFailures += 1;
          if (consecutiveFailures >= 6) {
            badgeSync.error =
              "The YouTube bridge stopped answering. Check the dev server, then resume.";
            stopAll = true;
          }
        } else {
          const json = (await res.json()) as {
            ok?: unknown;
            officialArtist?: unknown;
          };
          if (json?.ok) {
            setYouTubeBadge(channelId, json.officialArtist === true);
            consecutiveFailures = 0;
          } else {
            badgeSync.failed += 1;
            consecutiveFailures += 1;
          }
        }
      } catch (error) {
        if (signal.aborted) break;
        badgeSync.failed += 1;
        consecutiveFailures += 1;
        if (consecutiveFailures >= 6) {
          badgeSync.error =
            "The YouTube bridge stopped answering. Check the dev server, then resume.";
          stopAll = true;
        }
      }

      badgeSync.done += 1;
      if (stopAll) break;
      /* A small gap is enough to keep a 4,800-channel run polite. */
      await sleep(120);
    }
  };

  try {
    await Promise.all([worker(), worker()]);
  } finally {
    if (runToken === badgeRunToken) {
      badgeSync.running = false;
      badgeAbort = null;
    }
  }

  if (signal.aborted || runToken !== badgeRunToken) return;
  if (badgeSync.error) {
    showToast("info", badgeSync.error, 12000);
  } else if (badgeSync.failed > 0) {
    showToast(
      "info",
      `${badgeSync.failed} channel(s) could not be checked; the rest are cached.`,
      8000,
    );
  }
}

function stopBadgeSync(): void {
  badgeRunToken += 1;
  badgeSync.stopped = true;
  badgeAbort?.abort();
  badgeAbort = null;
  badgeSync.running = false;
}

function resumeBadgeSync(): void {
  badgeSync.stopped = false;
  badgeSync.error = "";
  void startBadgeSync();
}

/**
 * The three card helpers. Each reads only its own channel's cache entry, so
 * one finished request re-renders one card rather than all 4,800.
 */
function hasOfficialArtistBadge(sub: Subscription): boolean {
  return (
    state.youtubeBadges[sub.channelId]?.officialArtist === true ||
    knownSubscription(sub)?.isOfficialArtist === true ||
    state.youtubeDetails[sub.channelId]?.officialArtist === true
  );
}

function subscriptionIsLive(sub: Subscription): boolean {
  const known = knownSubscription(sub);
  if (known) return liveByChannel.value.has(known.id);
  return Boolean(state.youtubeDetails[sub.channelId]?.live);
}

function subscriptionIsUpcoming(sub: Subscription): boolean {
  const known = knownSubscription(sub);
  if (known) return upcomingByChannel.value.has(known.id);
  return Boolean(state.youtubeDetails[sub.channelId]?.upcoming);
}

function subscriptionSongCount(sub: Subscription): number {
  const known = knownSubscription(sub);
  if (known) return songCountByChannel.value.get(known.id) ?? 0;
  return state.youtubeDetails[sub.channelId]?.releaseCount ?? 0;
}

watch(
  () => [state.view, datasetApi.value, allSubscriptions().length] as const,
  () => scheduleBadgeSync(),
  { immediate: true },
);

/**
 * Links a platform account and loads its subscriptions.
 *
 * Passing `existing` reconnects that account instead of adding a second one:
 * the id is preserved, so the stored list is replaced rather than duplicated.
 * A reconnect tries the silent Google path first and falls back to the consent
 * screen when the new scope has not been granted yet.
 *
 * The subscriptions are matched against the local dataset: an exact channel
 * id wins, otherwise the display name is compared — which is how a YouTube
 * subscription of a VTuber who also streams on Twitch gets recognised.
 */
async function linkProvider(
  provider: AuthProvider,
  existing?: LinkedAccount,
): Promise<void> {
  if (!provider.isConfigured()) {
    showToast("error", provider.unavailableReason() ?? "Not configured.", 6000);
    return;
  }

  state.subscriptionsLoading = true;
  if (provider.id === "youtube" && !existing) {
    showToast("info", "Opening Google sign-in — finish in the popup.", 15000);
  }
  try {
    /**
     * Reconnecting tries the silent path first: the scope is usually already
     * granted, so Google returns a fresh token without a consent screen. An
     * account linked before the full scope was added still needs the screen;
     * the silent attempt fails, and the retry asks for it.
     */
    let linked: ProviderAccount | null;
    try {
      linked = await provider.link(existing ? { prompt: "" } : undefined);
    } catch (error) {
      if (!existing) throw error;
      linked = await provider.link();
    }
    if (!linked) {
      showToast("info", "Linking cancelled.");
      return;
    }
    const account: LinkedAccount = existing
      ? { ...existing, ...linked, id: existing.id }
      : {
          ...linked,
          id: `${linked.provider}:${randomId()}`,
        };
    addAccount(account);

    const remote = await provider.subscriptions(account, (progress) => {
      state.subscriptionsProgress = progress;
    });
    const byName = new Map<string, ChannelSummary>();
    for (const summary of summaries.value) {
      byName.set(normalizeForMatch(summary.name), summary);
    }

    const mapped: Subscription[] = remote.map((entry) => {
      const exact = summaries.value.find((s) => s.id === entry.channelId);
      const match = exact ?? byName.get(normalizeForMatch(entry.name));
      return {
        provider: provider.id,
        channelId: entry.channelId,
        title: entry.name,
        handle: entry.handle,
        thumbnail: entry.thumbnail,
        description: entry.description,
        kind: match?.kind ?? "unknown",
        region: match?.region ?? null,
        known: !!match,
      };
    });

    setSubscriptions(subscriptionKey(provider.id, account.id), mapped);
    scheduleBadgeSync();

    /**
     * The subscriptions are the reason to link: show them. A successful
     * link that leaves the user on the page they started on looks like
     * nothing happened.
     */
    if (mapped.length > 0) state.view = "subs";

    if (mapped.length === 0) {
      showToast(
        "info",
        `${provider.label}: account ${existing ? "reconnected" : "linked"}, but it returned no subscriptions. ` +
          `Check that this account has subscriptions and, on a static build, that YouTube Data API v3 is enabled for the project.`,
        10000,
      );
    } else {
      /**
       * Google reports how many subscriptions the account has. If the API
       * hands back fewer, say so — a silently truncated list looks complete.
       */
      const total = state.subscriptionsProgress?.total ?? null;
      const truncated = total !== null && mapped.length < total;
      showToast(
        truncated ? "info" : "success",
        truncated
          ? `${provider.label}: ${mapped.length} of ${total} subscriptions returned — the YouTube Data API returns at most 1,000 items for a list, whatever the account holds. Use Linked accounts → Reconnect (full permission; the local dev server reads InnerTube's complete list) or “Export from YouTube” for the complete file.`
          : `${provider.label}: ${mapped.length} subscription(s) ${existing ? "reconnected" : "linked"}, ${mapped.filter((m) => m.known).length} already tracked.` +
              (total !== null ? ` (Google total: ${total})` : ""),
        truncated ? 14000 : 6000,
      );
    }
  } catch (err) {
    console.error("[auth] link failed", err);
    showToast(
      "error",
      `${provider.label}: ${(err as Error).message}`,
      12000,
    );
  } finally {
    state.subscriptionsLoading = false;
    state.subscriptionsProgress = null;
  }
}

function unlinkProvider(provider: AuthProvider, accountId: string): void {
  const account = (state.accounts[provider.id] ?? []).find(
    (a) => a.id === accountId,
  );
  if (account) provider.unlink(account as unknown as LinkedAccount);
  removeAccount(provider.id, accountId);
  showToast("info", `${provider.label} account unlinked.`);
}

async function reloadSubscriptions(): Promise<void> {
  state.subscriptionsLoading = true;
  try {
    for (const provider of linkedProviders.value) {
      const account = activeAccount(provider.id);
      if (!account) continue;
      try {
        const remote = await provider.subscriptions(
          account as unknown as LinkedAccount,
          (progress) => {
            state.subscriptionsProgress = progress;
          },
        );
        const byName = new Map<string, ChannelSummary>();
        for (const summary of summaries.value) {
          byName.set(normalizeForMatch(summary.name), summary);
        }
        setSubscriptions(
          subscriptionKey(provider.id, account.id),
          remote.map((entry) => {
            const exact = summaries.value.find((s) => s.id === entry.channelId);
            const match = exact ?? byName.get(normalizeForMatch(entry.name));
            return {
              provider: provider.id,
              channelId: entry.channelId,
              title: entry.name,
              handle: entry.handle,
              thumbnail: entry.thumbnail,
              description: entry.description,
              kind: match?.kind ?? "unknown",
              region: match?.region ?? null,
              known: !!match,
            };
          }),
        );
      } catch (err) {
        /**
         * Keeping the previous list is right, but swallowing the reason is
         * not: an expired token made "Refresh" do nothing at all.
         */
        console.error("[auth] refresh failed", err);
        showToast(
          "error",
          `${provider.label}: ${(err as Error).message}`,
          12000,
        );
      }
    }
  } finally {
    state.subscriptionsLoading = false;
    state.subscriptionsProgress = null;
    scheduleBadgeSync();
  }
}

/**
 * Imports a subscription list from a file.
 *
 * Refresh reads the complete list through InnerTube when the local dev server
 * is available. A static build has no bridge, so the Data API stops at about
 * 1,000 there. Three files carry the rest, and none needs OAuth: a Takeout
 * `subscriptions.csv`, the CSV the “Export from YouTube” script writes (it
 * pages the signed-in InnerTube continuation, so it is complete), and a
 * **PocketTube** backup (JSON). The rows are stored under the synthetic
 * account `takeout`, which a refresh never overwrites.
 */
async function importSubscriptions(file: File): Promise<void> {
  try {
    const entries = parseSubscriptionsFile(await file.text());
    if (entries.length === 0) {
      showToast(
        "error",
        "No channel ids found — use a Takeout CSV, a PocketTube backup JSON, or the CSV from “Export from YouTube”.",
        12000,
      );
      return;
    }
    /**
     * Index the dataset once. A PocketTube backup can hold thousands of
     * rows, and `find()` per row against 14k summaries is quadratic.
     */
    const byId = new Map<string, ChannelSummary>();
    const byName = new Map<string, ChannelSummary>();
    for (const summary of summaries.value) {
      byId.set(summary.id, summary);
      const key = normalizeForMatch(summary.name);
      if (!byName.has(key)) byName.set(key, summary);
    }
    const mapped: Subscription[] = entries.map((entry) => {
      const match =
        byId.get(entry.channelId) ??
        byName.get(normalizeForMatch(entry.title));
      return {
        provider: "youtube",
        channelId: entry.channelId,
        title: entry.title,
        handle: null,
        thumbnail: null,
        description: entry.url,
        kind: match?.kind ?? "unknown",
        region: match?.region ?? null,
        known: !!match,
      };
    });
    setSubscriptions(subscriptionKey("youtube", "takeout"), mapped);
    state.view = "subs";
    scheduleBadgeSync();
    showToast(
      "success",
      `YouTube: ${mapped.length} subscription(s) imported, ${mapped.filter((m) => m.known).length} already tracked.`,
      8000,
    );
  } catch (err) {
    console.error("[subscriptions] import failed", err);
    showToast("error", `Import failed: ${(err as Error).message}`, 10000);
  }
}

function onSubscriptionsFile(event: Event): void {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (file) void importSubscriptions(file);
}

/* -------------------------------------------------------------------------- */
/* Suggestions and dataset import                                             */
/* -------------------------------------------------------------------------- */

/** Resolves which capability this page has: the dev API or a static build. */
async function probeDatasetApi(): Promise<void> {
  try {
    const res = await fetch("/api/dataset/suggestions", {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) throw new Error(String(res.status));
    const json = await res.json();
    if (!json?.ok) throw new Error("no dataset API");
    datasetApi.value = "available";
    /**
     * The file on disk is the source of truth; the browser's copy is merged
     * with it so a suggestion added in another session is still shown.
     */
    const keys = (json.suggestions ?? []).map(
      (entry: { platform: string; id: string }) =>
        `${entry.platform}:${entry.id}`,
    );
    if (keys.length > 0) markSuggested(keys);
  } catch {
    datasetApi.value = "unavailable";
  }
}

/** A suggestion entry, in the shape `data/suggestions.json` stores. */
function suggestionEntry(sub: Subscription) {
  return {
    platform: sub.provider,
    id: sub.channelId,
    name: sub.title,
    url:
      sub.provider === "youtube"
        ? `https://www.youtube.com/channel/${sub.channelId}`
        : null,
    kind: sub.kind === "unknown" ? null : sub.kind,
    note: null,
    source: "subscription" as const,
  };
}

/**
 * Adds subscriptions to the suggestion list.
 *
 * The list is deliberately separate from the dataset: suggesting is instant
 * and needs no network, and the platform still decides the name when the
 * channel is imported. On the dev server the file is written immediately; on
 * a static build the entries are kept in the browser and can be downloaded.
 */
async function suggestSubscriptions(subs: Subscription[]): Promise<void> {
  const unique = subs.filter(
    (sub) => sub.channelId && !isSubSuggested(sub),
  );
  if (unique.length === 0) {
    showToast("info", "Those are already on the suggestion list.", 4000);
    return;
  }

  const entries = unique.map(suggestionEntry);
  markSuggested(entries.map((entry) => `${entry.platform}:${entry.id}`));

  if (datasetApi.value === "available") {
    try {
      const res = await fetch("/api/dataset/suggestions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entries }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) {
        throw new Error(json.error ?? `HTTP ${res.status}`);
      }
      showToast(
        "success",
        `${json.added.length} channel(s) suggested · ${json.total} on the list.`,
        6000,
      );
    } catch (err) {
      showToast(
        "error",
        `The suggestion list could not be written: ${(err as Error).message}`,
        10000,
      );
    }
    return;
  }

  showToast(
    "info",
    `${entries.length} suggestion(s) saved in this browser. Download suggestions.json and commit it to data/.`,
    9000,
  );
}

function suggestAllUntracked(): void {
  const subs = untrackedSubscriptions.value.filter(
    (sub) => !isSubSuggested(sub),
  );
  void suggestSubscriptions(subs);
}

/**
 * Removes `platform:id` keys from the suggestion list.
 *
 * The browser copy is cleared first so the button responds instantly, then
 * the file is rewritten through the dev server. Two failure modes matter:
 *
 *  - **No dataset API** (a static build): there is no file to write. The
 *    removed keys stay in `localStorage`, and the download button exports
 *    what is left.
 *  - **The write fails** while the API *is* there: the file still lists the
 *    channel, so the keys are put back — otherwise the UI says "removed" and
 *    the next probe brings them straight back.
 */
async function unsuggestKeys(keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  clearSuggested(keys);

  try {
    const res = await fetch("/api/dataset/suggestions/remove", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ keys }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (!json.ok) throw new Error(json.error ?? "the server refused");
    datasetApi.value = "available";
    showToast(
      "info",
      json.removed > 0
        ? `${json.removed} suggestion(s) removed from data/suggestions.json.`
        : "Those suggestions were already gone.",
      5000,
    );
  } catch (err) {
    if (datasetApi.value === "available") {
      markSuggested(keys);
      showToast(
        "error",
        `data/suggestions.json could not be updated: ${(err as Error).message}`,
        12000,
      );
      return;
    }
    showToast(
      "info",
      `${keys.length} suggestion(s) removed from this browser.`,
      5000,
    );
  }
}

function unsuggestSubscriptions(subs: Subscription[]): void {
  void unsuggestKeys(
    subs.map((sub) => suggestedKey(sub.provider, sub.channelId)),
  );
}

/** Empties the whole queue — useful after a bulk "Suggest all". */
function clearAllSuggestions(): void {
  void unsuggestKeys([...state.suggested]);
}

/** Copies the “Export from YouTube” script for the DevTools console. */
async function copySubsScript(): Promise<void> {
  try {
    await navigator.clipboard.writeText(SUBS_EXPORT_SCRIPT);
    subsScriptCopied.value = true;
    setTimeout(() => (subsScriptCopied.value = false), 2000);
  } catch {
    showToast(
      "info",
      "Select the script in the box and copy it manually.",
      6000,
    );
  }
}

/**
 * Writes the suggested channels into `data/` through the dev server.
 *
 * The server resolves each id with InnerTube, classifies it exactly as a sync
 * would, and writes the shard. The list is processed in batches so the UI can
 * show progress and a long import can be resumed.
 *
 * **Permission is explicit.** A subscription list is private, and importing
 * it publishes third-party channel records; the checkbox is required by the
 * UI and re-checked by the server.
 */
async function syncSuggested(): Promise<void> {
  if (!syncConsent.value) {
    showToast(
      "info",
      "Tick the permission box first — only sync an account you own or have permission to use.",
      8000,
    );
    return;
  }
  if (datasetApi.value !== "available") {
    showToast(
      "info",
      "Writing into the dataset needs the local dev server: run `npm run dev` and open http://localhost:3000.",
      10000,
    );
    return;
  }

  const ids = state.suggested
    .filter((key) => key.startsWith("youtube:"))
    .map((key) => key.slice("youtube:".length))
    .filter((id) => /^UC[\w-]{20,}$/.test(id));

  if (ids.length === 0) {
    showToast(
      "info",
      "The suggestion list has no YouTube ids to import.",
      6000,
    );
    return;
  }

  syncing.value = true;
  syncState.value = { done: 0, total: ids.length, added: 0, failed: 0 };
  let offset = 0;
  const failedIds = new Set<string>();
  try {
    while (offset < ids.length) {
      const res = await fetch("/api/dataset/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ids,
          consent: true,
          offset,
          limit: 12,
          // The index is rebuilt once, when the last batch lands.
          rebuildIndex: offset + 12 >= ids.length,
        }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) {
        throw new Error(json.error ?? `HTTP ${res.status}`);
      }
      // A batch that looked at nothing cannot advance; retrying would spin.
      if (json.processed === 0 && json.nextOffset <= offset) {
        throw new Error(
          json.failed?.[0]?.reason ??
            "the server could not fetch any of the suggested channels",
        );
      }
      offset = json.nextOffset;
      for (const entry of json.failed as { id: string }[]) {
        failedIds.add(entry.id);
      }
      syncState.value = {
        done: offset,
        total: ids.length,
        added: (syncState.value?.added ?? 0) + json.added.length,
        failed: (syncState.value?.failed ?? 0) + json.failed.length,
      };
    }

    const added = syncState.value?.added ?? 0;
    const failed = syncState.value?.failed ?? 0;
    /**
     * An id that resolved — created now, already tracked, or refused by the
     * platform — leaves the list; a transport failure stays for a retry.
     */
    clearSuggested(
      ids
        .filter((id) => !failedIds.has(id))
        .map((id) => `youtube:${id}`),
    );
    showToast(
      failed > 0 ? "info" : "success",
      `${added} channel(s) added to the dataset` +
        (failed > 0 ? `, ${failed} could not be fetched` : "") +
        ".",
      10000,
    );
    if (added > 0) await reloadDataset();
  } catch (err) {
    console.error("[import] failed", err);
    showToast(
      "error",
      `Import failed: ${(err as Error).message}`,
      12000,
    );
  } finally {
    syncing.value = false;
    syncState.value = null;
  }
}

/**
 * The fallback for a static build: the suggestion list as a file the user can
 * drop into `data/` and commit.
 */
function downloadSuggestions(): void {
  const byKey = new Map(
    allSubscriptions().map((sub) => [
      suggestedKey(sub.provider, sub.channelId),
      sub,
    ]),
  );
  const suggestions = state.suggested
    .map((key) => byKey.get(key))
    .filter((sub): sub is Subscription => !!sub)
    .map((sub) => ({
      ...suggestionEntry(sub),
      addedAt: new Date().toISOString(),
    }));

  const blob = new Blob(
    [
      JSON.stringify(
        {
          schemaVersion: 1,
          generatedAt: new Date().toISOString(),
          suggestions,
        },
        null,
        2,
      ),
      "\n",
    ],
    { type: "application/json" },
  );
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = "suggestions.json";
  link.click();
  URL.revokeObjectURL(link.href);
  showToast(
    "info",
    "Saved suggestions.json — put it at data/suggestions.json and commit it.",
    9000,
  );
}

/* -------------------------------------------------------------------------- */
/* Boot                                                                       */
/* -------------------------------------------------------------------------- */

async function loadDataset(): Promise<void> {
  loading.value = true;
  try {
    const [m, s, c, l, u] = await Promise.all([
      loadManifest(),
      loadSummaries(),
      loadAllChannels(),
      loadLive(),
      loadUpcoming(),
    ]);
    manifest.value = m;
    summaries.value = s;
    channels.value = c;
    live.value = l;
    upcoming.value = u;

    // The full item set is large; it is only needed for the Songs view.
    allItems.value = await loadItems("all");

    if (hasAnyAccount.value) await reloadSubscriptions();
  } catch (err) {
    console.error(err);
    showToast("error", "Could not load the dataset.");
  } finally {
    loading.value = false;
  }
}

/** Re-reads `data/` after the import wrote new records into it. */
async function reloadDataset(): Promise<void> {
  resetDatasetCache();
  await loadDataset();
}

onMounted(async () => {
  initTheme();
  await probeDatasetApi();
  await loadDataset();
});
</script>

<template>
  <div
    class="min-h-screen bg-[#f6f5f1] text-neutral-900 transition-colors duration-200 dark:bg-neutral-950 dark:text-neutral-100"
  >
    <!-- ───────────────────────── Header ───────────────────────── -->
    <header
      class="sticky top-0 z-40 border-b border-black/8 bg-[#f6f5f1]/90 backdrop-blur-xl dark:border-white/10 dark:bg-neutral-950/90"
    >
      <div class="mx-auto max-w-[1600px] px-3 sm:px-5">
        <!-- Top row -->
        <div class="flex items-center gap-2 py-2.5 sm:gap-3 sm:py-3">
          <button
            type="button"
            class="flex shrink-0 items-center gap-2"
            @click="setView('live')"
          >
            <span
              class="grid h-8 w-8 place-items-center rounded-lg bg-gradient-to-br from-purple-500 to-pink-500 text-base font-black text-white shadow-sm"
              aria-hidden="true"
            >
              ♪
            </span>
            <span class="hidden text-lg font-bold tracking-tight sm:block">
              VSinger<span class="text-purple-500">&amp;</span>Singer
            </span>
          </button>

          <!-- Search -->
          <div class="relative min-w-0 flex-1">
            <input
              v-model="state.query"
              type="search"
              placeholder="Search channels, songs, covers, MVs…"
              class="w-full rounded-full border border-black/10 bg-white py-2 pr-9 pl-9 text-sm outline-none transition placeholder:text-neutral-400 focus:border-purple-400 focus:ring-2 focus:ring-purple-500/20 dark:border-white/12 dark:bg-neutral-900 dark:placeholder:text-neutral-500"
              aria-label="Search"
            />
            <svg
              class="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-neutral-400"
              viewBox="0 0 20 20"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              aria-hidden="true"
            >
              <circle cx="9" cy="9" r="6" />
              <path d="m14 14 4 4" stroke-linecap="round" />
            </svg>
            <span
              v-if="searching"
              class="absolute top-1/2 right-3 h-3.5 w-3.5 -translate-y-1/2 animate-spin rounded-full border-2 border-neutral-300 border-t-purple-500"
            />
          </div>

          <!-- Scope switch -->
          <div
            class="hidden shrink-0 items-center rounded-full border border-black/10 bg-white p-0.5 md:flex dark:border-white/12 dark:bg-neutral-900"
            role="group"
            aria-label="Artist scope"
          >
            <button
              v-for="option in (['virtual', 'real', 'both'] as Scope[])"
              :key="option"
              type="button"
              class="rounded-full px-3 py-1.5 text-xs font-semibold transition"
              :class="
                state.scope === option
                  ? 'bg-purple-600 text-white shadow-sm'
                  : 'text-neutral-500 hover:text-neutral-800 dark:text-neutral-400 dark:hover:text-neutral-100'
              "
              @click="selectScope(option)"
            >
              {{
                option === "virtual"
                  ? "Virtual"
                  : option === "real"
                    ? "Real"
                    : "Both"
              }}
            </button>
          </div>

          <!-- Theme -->
          <button
            type="button"
            class="grid h-9 w-9 shrink-0 place-items-center rounded-full border border-black/10 bg-white text-neutral-600 transition hover:bg-neutral-100 dark:border-white/12 dark:bg-neutral-900 dark:text-neutral-300 dark:hover:bg-neutral-800"
            :aria-label="state.theme === 'dark' ? 'Switch to light' : 'Switch to dark'"
            @click="toggleTheme"
          >
            <span v-if="state.theme === 'dark'" aria-hidden="true">☀</span>
            <span v-else aria-hidden="true">☾</span>
          </button>

          <!-- Account -->
          <div class="relative shrink-0">
            <button
              type="button"
              class="grid h-9 w-9 place-items-center overflow-hidden rounded-full border border-black/10 bg-white text-neutral-600 transition hover:bg-neutral-100 dark:border-white/12 dark:bg-neutral-900 dark:text-neutral-300 dark:hover:bg-neutral-800"
              title="Linked accounts"
              aria-label="Linked accounts"
              :aria-expanded="showAccountMenu"
              @click="showAccountMenu = !showAccountMenu"
            >
              <img
                v-if="activeAccount('youtube')?.picture"
                :src="activeAccount('youtube')!.picture!"
                alt="Your account"
                class="h-full w-full object-cover"
              />
              <span v-else-if="hasAnyAccount" aria-hidden="true">✓</span>
              <span v-else aria-hidden="true">👤</span>
            </button>

            <!-- Account menu -->
            <Transition
              enter-active-class="transition duration-150 ease-out"
              enter-from-class="scale-95 opacity-0"
              leave-active-class="transition duration-100 ease-in"
              leave-to-class="scale-95 opacity-0"
            >
              <div
                v-if="showAccountMenu"
                class="absolute top-11 right-0 z-50 w-72 overflow-hidden rounded-xl border border-black/10 bg-white shadow-xl dark:border-white/12 dark:bg-neutral-900"
              >
                <p
                  class="border-b border-black/8 px-3 py-2 text-[11px] font-bold tracking-wide text-neutral-500 uppercase dark:border-white/10"
                >
                  Linked accounts
                </p>

                <!-- Linked accounts, with switch + logout -->
                <div
                  v-for="provider in AUTH_PROVIDERS"
                  :key="provider.id"
                  class="border-b border-black/5 last:border-b-0 dark:border-white/5"
                >
                  <p
                    class="flex items-center gap-1.5 px-3 pt-2 pb-1 text-[10px] font-bold tracking-wide text-neutral-400 uppercase"
                  >
                    <span
                      class="inline-block h-2 w-2 rounded-full"
                      :style="{ backgroundColor: provider.color }"
                      aria-hidden="true"
                    />
                    {{ provider.label }}
                  </p>

                  <div
                    v-for="account in state.accounts[provider.id] ?? []"
                    :key="account.id"
                    class="flex items-center gap-2 px-3 py-1.5"
                  >
                    <button
                      type="button"
                      class="flex min-w-0 flex-1 items-center gap-2 text-left"
                      @click="
                        setActiveAccount(provider.id, account.id);
                        reloadSubscriptions();
                      "
                    >
                      <img
                        v-if="account.picture"
                        :src="account.picture"
                        alt=""
                        class="h-6 w-6 shrink-0 rounded-full object-cover"
                      />
                      <span
                        v-else
                        class="grid h-6 w-6 shrink-0 place-items-center rounded-full text-[10px] font-bold text-white"
                        :style="{ backgroundColor: provider.color }"
                        aria-hidden="true"
                      >
                        {{ (account.name ?? provider.label)[0] }}
                      </span>
                      <span class="min-w-0 flex-1">
                        <span class="block truncate text-xs font-semibold">
                          {{ account.name ?? provider.label }}
                        </span>
                        <span
                          v-if="
                            activeAccount(provider.id)?.id === account.id
                          "
                          class="block text-[10px] text-emerald-600 dark:text-emerald-400"
                        >
                          Active
                        </span>
                      </span>
                    </button>

                    <!-- Switch -->
                    <button
                      v-if="activeAccount(provider.id)?.id !== account.id"
                      type="button"
                      class="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold text-neutral-500 transition hover:bg-black/5 hover:text-neutral-800 dark:hover:bg-white/10 dark:hover:text-neutral-100"
                      title="Switch to this account"
                      @click="
                        setActiveAccount(provider.id, account.id);
                        reloadSubscriptions();
                      "
                    >
                      Switch
                    </button>

                    <!-- Reconnect (expired OAuth token) -->
                    <button
                      v-if="account.provider === 'youtube'"
                      type="button"
                      class="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold text-neutral-500 transition hover:bg-black/5 hover:text-neutral-800 dark:hover:bg-white/10 dark:hover:text-neutral-100"
                      title="Reconnect this account and refresh its token"
                      @click="
                        showAccountMenu = false;
                        linkProvider(provider, account);
                      "
                    >
                      Reconnect
                    </button>

                    <!-- Logout -->
                    <button
                      type="button"
                      class="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold text-red-500 transition hover:bg-red-500/10"
                      title="Sign out of this account"
                      @click="unlinkProvider(provider, account.id)"
                    >
                      Sign out
                    </button>
                  </div>

                  <!-- Link another -->
                  <button
                    type="button"
                    class="w-full px-3 py-2 text-left text-[11px] font-semibold text-neutral-500 transition hover:bg-black/5 hover:text-neutral-800 dark:hover:bg-white/10 dark:hover:text-neutral-100"
                    @click="linkProvider(provider)"
                  >
                    + Link another {{ provider.label }} account
                  </button>
                </div>

                <button
                  type="button"
                  class="w-full border-t border-black/8 px-3 py-2 text-left text-[11px] font-semibold text-neutral-500 transition hover:bg-black/5 hover:text-neutral-800 dark:border-white/10 dark:hover:bg-white/10 dark:hover:text-neutral-100"
                  @click="showAccountMenu = false"
                >
                  Close
                </button>
              </div>
            </Transition>
          </div>
        </div>

        <!-- View tabs -->
        <nav
          class="-mx-3 flex gap-1 overflow-x-auto px-3 pb-2 sm:-mx-5 sm:px-5"
          aria-label="Views"
        >
          <button
            v-for="view in VIEWS"
            :key="view.id"
            type="button"
            class="shrink-0 rounded-full px-3 py-1.5 text-xs font-semibold whitespace-nowrap transition"
            :class="
              state.view === view.id
                ? 'bg-neutral-900 text-white dark:bg-white dark:text-neutral-900'
                : 'text-neutral-500 hover:bg-black/5 hover:text-neutral-800 dark:text-neutral-400 dark:hover:bg-white/8 dark:hover:text-neutral-100'
            "
            @click="setView(view.id)"
          >
            {{ view.label }}
            <span
              v-if="view.id === 'live' && visibleLive.length"
              class="ml-1 rounded-full bg-red-500/15 px-1.5 text-[10px] font-bold text-red-500"
            >
              {{ visibleLive.length }}
            </span>
          </button>
        </nav>

        <!-- The sort control, for the current tab -->
        <div class="flex items-center justify-end gap-2 pb-2">
          <label class="flex items-center gap-1.5 text-[11px] font-semibold text-neutral-500">
            <span class="hidden sm:inline">Sort</span>
            <select
              :value="state.sort[state.view]"
              class="rounded-full border border-black/10 bg-white px-2.5 py-1 text-[11px] font-semibold outline-none dark:border-white/12 dark:bg-neutral-900"
              :aria-label="`Sort the ${state.view} view`"
              @change="setSort(state.view, ($event.target as HTMLSelectElement).value)"
            >
              <option
                v-for="option in SORTS[state.view]"
                :key="option.id"
                :value="option.id"
              >
                {{ option.label }}
              </option>
            </select>
          </label>
        </div>
      </div>
    </header>

    <!-- ───────────────────────── Filters ───────────────────────── -->
    <div
      class="sticky top-[104px] z-30 border-b border-black/6 bg-[#f6f5f1]/95 backdrop-blur-xl dark:border-white/8 dark:bg-neutral-950/95 sm:top-[112px]"
    >
      <div
        class="mx-auto flex max-w-[1600px] items-center gap-2 overflow-x-auto px-3 py-2 sm:px-5"
      >
        <!-- Region -->
        <label class="shrink-0">
          <span class="sr-only">Region</span>
          <select
            :value="state.region"
            class="rounded-full border border-black/10 bg-white px-3 py-1.5 text-xs font-semibold outline-none dark:border-white/12 dark:bg-neutral-900"
            @change="
              setRegion(($event.target as HTMLSelectElement).value as RegionCode | 'all')
            "
          >
            <option value="all">🌐 All regions</option>
            <option
              v-for="region in manifest?.regions ?? []"
              :key="region.code"
              :value="region.code"
            >
              {{ region.badge }} {{ region.label }} ({{ region.channels }})
            </option>
          </select>
        </label>

        <!-- Categories — multi-select, so MV + Covers can be combined -->
        <button
          v-if="state.categories.length"
          type="button"
          class="shrink-0 rounded-full border border-purple-500 bg-purple-500/12 px-3 py-1.5 text-xs font-semibold whitespace-nowrap text-purple-700 transition dark:text-purple-300"
          @click="state.categories.splice(0)"
        >
          Clear filters
        </button>
        <button
          v-for="category in CATEGORIES"
          :key="category.id"
          type="button"
          class="shrink-0 rounded-full border px-3 py-1.5 text-xs font-semibold whitespace-nowrap transition"
          :class="
            state.categories.includes(category.id)
              ? 'border-purple-500 bg-purple-500/12 text-purple-700 dark:text-purple-300'
              : 'border-black/10 bg-white text-neutral-500 hover:text-neutral-800 dark:border-white/12 dark:bg-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100'
          "
          :aria-pressed="state.categories.includes(category.id)"
          @click="toggleCategory(category.id)"
        >
          {{ category.label }}
          <span
            v-if="state.categories.includes(category.id)"
            class="ml-1 opacity-70"
            aria-hidden="true"
            >✓</span
          >
        </button>

        <!-- Acoustic / 弾き語り -->
        <button
          type="button"
          class="shrink-0 rounded-full border px-3 py-1.5 text-xs font-semibold whitespace-nowrap transition"
          :class="
            state.acousticOnly
              ? 'border-amber-500 bg-amber-500/15 text-amber-700 dark:text-amber-400'
              : 'border-black/10 bg-white text-neutral-500 hover:text-neutral-800 dark:border-white/12 dark:bg-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100'
          "
          :aria-pressed="state.acousticOnly"
          title="Singing while playing an instrument — 弾き語り / 彈唱 / acoustic"
          @click="state.acousticOnly = !state.acousticOnly"
        >
          🎸 Acoustic / 弾き語り
        </button>

        <!-- Gender -->
        <button
          v-for="option in GENDERS"
          :key="option.id"
          type="button"
          class="shrink-0 rounded-full border px-3 py-1.5 text-xs font-semibold whitespace-nowrap transition"
          :class="
            state.gender === option.id
              ? 'border-sky-500 bg-sky-500/15 text-sky-700 dark:text-sky-400'
              : 'border-black/10 bg-white text-neutral-500 hover:text-neutral-800 dark:border-white/12 dark:bg-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100'
          "
          :aria-pressed="state.gender === option.id"
          @click="state.gender = option.id"
        >
          {{ option.label }}
        </button>

        <!-- Independent vs. agency -->
        <button
          v-for="option in AFFILIATION_FILTERS"
          :key="option.id"
          type="button"
          class="shrink-0 rounded-full border px-3 py-1.5 text-xs font-semibold whitespace-nowrap transition"
          :class="
            state.affiliation === option.id
              ? 'border-indigo-500 bg-indigo-500/15 text-indigo-700 dark:text-indigo-400'
              : 'border-black/10 bg-white text-neutral-500 hover:text-neutral-800 dark:border-white/12 dark:bg-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100'
          "
          :aria-pressed="state.affiliation === option.id"
          :title="option.title"
          @click="state.affiliation = option.id"
        >
          {{ option.label }}
        </button>

        <!-- Languages -->
        <button
          v-for="option in LANGUAGES"
          :key="option.id"
          type="button"
          class="shrink-0 rounded-full border px-3 py-1.5 text-xs font-semibold whitespace-nowrap transition"
          :class="
            state.language === option.id
              ? 'border-teal-500 bg-teal-500/15 text-teal-700 dark:text-teal-400'
              : 'border-black/10 bg-white text-neutral-500 hover:text-neutral-800 dark:border-white/12 dark:bg-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100'
          "
          :aria-pressed="state.language === option.id"
          :title="option.title"
          @click="state.language = option.id"
        >
          {{ option.label }}
        </button>

        <!-- Singing content -->
        <button
          v-for="option in SINGING_FILTERS"
          :key="option.id"
          type="button"
          class="shrink-0 rounded-full border px-3 py-1.5 text-xs font-semibold whitespace-nowrap transition"
          :class="
            state.singing === option.id
              ? 'border-rose-500 bg-rose-500/15 text-rose-700 dark:text-rose-400'
              : 'border-black/10 bg-white text-neutral-500 hover:text-neutral-800 dark:border-white/12 dark:bg-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100'
          "
          :aria-pressed="state.singing === option.id"
          :title="option.title"
          @click="state.singing = option.id"
        >
          {{ option.label }}
        </button>

        <!-- AI -->
        <button
          type="button"
          class="shrink-0 rounded-full border px-3 py-1.5 text-xs font-semibold whitespace-nowrap transition"
          :class="
            state.ai === 'ai'
              ? 'border-fuchsia-500 bg-fuchsia-500/15 text-fuchsia-700 dark:text-fuchsia-400'
              : 'border-black/10 bg-white text-neutral-500 hover:text-neutral-800 dark:border-white/12 dark:bg-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100'
          "
          :aria-pressed="state.ai === 'ai'"
          title="Show only AI-generated performers (AI VTuber, AI singer)"
          @click="state.ai = state.ai === 'ai' ? 'all' : 'ai'"
        >
          🤖 AI performers
        </button>

        <!-- Official Artist Channel (the 🎵 badge) -->
        <button
          type="button"
          class="shrink-0 rounded-full border px-3 py-1.5 text-xs font-semibold whitespace-nowrap transition"
          :class="
            state.oac === 'oac'
              ? 'border-violet-500 bg-violet-500/15 text-violet-700 dark:text-violet-400'
              : 'border-black/10 bg-white text-neutral-500 hover:text-neutral-800 dark:border-white/12 dark:bg-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100'
          "
          :aria-pressed="state.oac === 'oac'"
          title="Only channels with YouTube's 🎵 Official Artist Channel badge — releases managed through YouTube Music"
          @click="state.oac = state.oac === 'oac' ? 'all' : 'oac'"
        >
          🎵 Official artist
        </button>

        <!-- Scope switch (mobile) -->
        <div
          class="ml-auto flex shrink-0 items-center rounded-full border border-black/10 bg-white p-0.5 md:hidden dark:border-white/12 dark:bg-neutral-900"
          role="group"
          aria-label="Artist scope"
        >
          <button
            v-for="option in (['virtual', 'real', 'both'] as Scope[])"
            :key="option"
            type="button"
            class="rounded-full px-2.5 py-1 text-[11px] font-semibold transition"
            :class="
              state.scope === option
                ? 'bg-purple-600 text-white'
                : 'text-neutral-500'
            "
            @click="selectScope(option)"
          >
            {{
              option === "virtual"
                ? "Virtual"
                : option === "real"
                  ? "Real"
                  : "Both"
            }}
          </button>
        </div>
      </div>
    </div>

    <!-- ───────────────────────── Content ───────────────────────── -->
    <main class="mx-auto max-w-[1600px] px-3 pt-4 pb-24 sm:px-5 sm:pb-8">
      <!-- Loading -->
      <div v-if="loading" class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
        <div
          v-for="n in 12"
          :key="n"
          class="aspect-[3/4] animate-pulse rounded-xl bg-black/5 dark:bg-white/5"
        />
      </div>

      <!-- Search results -->
      <section v-else-if="state.query.trim()" aria-label="Search results">
        <h2 class="mb-3 text-sm font-semibold text-neutral-500">
          {{ searchHits.length }} result{{ searchHits.length === 1 ? "" : "s" }} for
          “{{ state.query }}”
        </h2>
        <div
          v-if="searchHits.length"
          class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6"
        >
          <article
            v-for="hit in searchHits"
            :key="`${hit.k}:${hit.id}`"
            class="group overflow-hidden rounded-xl border border-black/8 bg-white shadow-sm transition hover:shadow-md dark:border-white/10 dark:bg-neutral-900"
          >
            <a
              :href="
                hit.k === 'c'
                  ? `https://www.youtube.com/channel/${hit.id}`
                  : `https://www.youtube.com/watch?v=${hit.id}`
              "
              target="_blank"
              rel="noopener noreferrer"
              class="block aspect-video w-full overflow-hidden bg-neutral-200 dark:bg-neutral-800"
            >
              <img
                :src="hit.th ?? ''"
                :alt="hit.n"
                loading="lazy"
                decoding="async"
                class="h-full w-full object-cover transition duration-300 group-hover:scale-[1.03]"
              />
            </a>
            <div class="space-y-1 p-2.5">
              <h3 class="line-clamp-2 text-xs leading-snug font-semibold">
                {{ hit.n }}
              </h3>
              <p v-if="hit.cn && hit.k === 'i'" class="truncate text-[11px] text-neutral-500">
                {{ hit.cn }}
              </p>
              <div class="flex flex-wrap items-center gap-1">
                <span
                  class="rounded px-1.5 py-0.5 text-[10px] font-semibold text-white"
                  :class="hit.g === 'virtual' ? 'bg-purple-600' : 'bg-emerald-600'"
                >
                  {{ hit.g === "virtual" ? "Virtual" : "Real" }}
                </span>
                <span
                  class="rounded bg-black/5 px-1.5 py-0.5 text-[10px] font-semibold text-neutral-600 dark:bg-white/10 dark:text-neutral-300"
                >
                  {{ hit.r.toUpperCase() }}
                </span>
                <span
                  v-if="hit.c"
                  class="rounded bg-black/5 px-1.5 py-0.5 text-[10px] font-semibold text-neutral-600 dark:bg-white/10 dark:text-neutral-300"
                >
                  {{ hit.c }}
                </span>
              </div>
            </div>
          </article>
        </div>
        <p v-else class="py-16 text-center text-sm text-neutral-500">
          No matches. Try a different spelling, or switch the scope to
          <strong>Both</strong>.
        </p>
      </section>

      <!-- Live -->
      <section v-else-if="state.view === 'live'" aria-label="Live now">
        <div class="mb-3 flex items-baseline justify-between">
          <h2 class="text-lg font-bold">
            Live now
            <span class="ml-1 text-sm font-normal text-neutral-500">
              {{ visibleLive.length }}
            </span>
          </h2>
          <span class="text-xs text-neutral-500">refreshes every 6 hours</span>
        </div>
        <div
          v-if="visibleLive.length"
          class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5"
        >
          <LiveCard
            v-for="item in visibleLive"
            :key="item.id"
            :item="item"
            :channel="summaryById.get(item.channelId) ?? null"
            live
            @open="openItem"
          />
        </div>
        <p v-else class="py-16 text-center text-sm text-neutral-500">
          No live streams right now for this filter. Check the
          <strong>Upcoming</strong> tab.
        </p>
      </section>

      <!-- Upcoming -->
      <section v-else-if="state.view === 'upcoming'" aria-label="Upcoming">
        <h2 class="mb-3 text-lg font-bold">
          Upcoming
          <span class="ml-1 text-sm font-normal text-neutral-500">
            {{ visibleUpcoming.length }}
          </span>
        </h2>
        <div
          v-if="visibleUpcoming.length"
          class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5"
        >
          <LiveCard
            v-for="item in visibleUpcoming"
            :key="item.id"
            :item="item"
            :channel="summaryById.get(item.channelId) ?? null"
            @open="openItem"
          />
        </div>
        <p v-else class="py-16 text-center text-sm text-neutral-500">
          Nothing scheduled.
        </p>
      </section>

      <!-- Songs -->
      <section v-else-if="state.view === 'songs'" aria-label="Songs">
        <h2 class="mb-3 text-lg font-bold">
          Songs &amp; covers
          <span class="ml-1 text-sm font-normal text-neutral-500">
            {{ visibleSongs.length }}
          </span>
        </h2>
        <div
          v-if="visibleSongs.length"
          class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5"
        >
          <LiveCard
            v-for="item in visibleSongs"
            :key="item.id"
            :item="item"
            :channel="summaryById.get(item.channelId) ?? null"
            @open="openItem"
          />
        </div>
        <p v-else class="py-16 text-center text-sm text-neutral-500">
          No songs for this filter yet.
        </p>
      </section>

      <!-- Channels -->
      <section v-else-if="state.view === 'channels'" aria-label="Channels">
        <div class="mb-3 flex flex-wrap items-center justify-between gap-3">
          <h2 class="text-lg font-bold">
            Channels
            <span class="ml-1 text-sm font-normal text-neutral-500">
              {{ visibleChannels.length }}
            </span>
          </h2>
          <!-- Subscribed / not subscribed, once an account is linked -->
          <div
            v-if="hasAnyAccount"
            class="flex shrink-0 items-center rounded-full border border-black/10 bg-white p-0.5 dark:border-white/12 dark:bg-neutral-900"
            role="group"
            aria-label="Subscription filter"
          >
            <button
              v-for="option in CHANNEL_SUB_FILTERS"
              :key="option.id"
              type="button"
              class="rounded-full px-2.5 py-1 text-[11px] font-semibold whitespace-nowrap transition"
              :class="
                state.channelSubs === option.id
                  ? 'bg-purple-600 text-white'
                  : 'text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-100'
              "
              @click="state.channelSubs = option.id"
            >
              {{ option.label }}
            </button>
          </div>
        </div>
        <div
          class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6"
        >
          <ChannelCard
            v-for="channel in visibleChannels"
            :key="channel.id"
            :channel="channel"
            @open="openChannel"
          />
        </div>
      </section>

      <!-- Subscriptions -->
      <section v-else-if="state.view === 'subs'" aria-label="My subscriptions">
        <div class="mb-3 flex items-baseline justify-between gap-3">
          <h2 class="text-lg font-bold">
            My subscriptions
            <span class="ml-1 text-sm font-normal text-neutral-500">
              {{ visibleSubscriptions.length }}
            </span>
            <span
              v-if="state.subscriptionsProgress"
              class="ml-2 text-xs font-normal text-neutral-500"
            >
              loading {{ state.subscriptionsProgress.loaded
              }}<template v-if="state.subscriptionsProgress.total">
                / {{ state.subscriptionsProgress.total }}</template
              >…
            </span>
          </h2>
          <div class="flex items-center gap-2">
            <!-- Tracked / untracked filter -->
            <div
              class="flex shrink-0 items-center rounded-full border border-black/10 bg-white p-0.5 dark:border-white/12 dark:bg-neutral-900"
              role="group"
              aria-label="Subscription status"
            >
              <button
                v-for="option in SUB_FILTERS"
                :key="option.id"
                type="button"
                class="rounded-full px-2.5 py-1 text-[11px] font-semibold whitespace-nowrap transition"
                :class="
                  state.subsTracked === option.id
                    ? 'bg-purple-600 text-white'
                    : 'text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-100'
                "
                @click="state.subsTracked = option.id"
              >
                {{ option.label }}
                <span class="opacity-70">{{
                  subscriptionCounts[option.countKey]
                }}</span>
              </button>
            </div>

            <label
              class="shrink-0 cursor-pointer rounded-full border border-black/10 bg-white px-3 py-1.5 text-xs font-semibold dark:border-white/12 dark:bg-neutral-900"
              title="Import a Takeout subscriptions.csv, a PocketTube backup, or the CSV from Export from YouTube"
            >
              Import CSV / JSON
              <input
                type="file"
                accept=".csv,.json,text/csv,application/json"
                class="hidden"
                @change="onSubscriptionsFile"
              />
            </label>

            <button
              type="button"
              class="shrink-0 rounded-full border border-black/10 bg-white px-3 py-1.5 text-xs font-semibold dark:border-white/12 dark:bg-neutral-900"
              title="Read your subscriptions straight from the signed-in YouTube page — no Takeout queue"
              @click="showSubsExport = true"
            >
              Export from YouTube
            </button>

            <button
              v-if="hasAnyAccount"
              type="button"
              class="shrink-0 rounded-full border border-black/10 bg-white px-3 py-1.5 text-xs font-semibold disabled:opacity-40 dark:border-white/12 dark:bg-neutral-900"
              :disabled="state.subscriptionsLoading"
              @click="reloadSubscriptions"
            >
              Refresh
            </button>
          </div>
        </div>

        <!-- Suggest / import -->
        <div
          v-if="hasAnyAccount && subscriptionCounts.all > 0"
          class="mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-black/8 bg-white p-2 text-xs shadow-sm dark:border-white/10 dark:bg-neutral-900"
        >
          <span class="font-semibold">
            {{ subscriptionCounts.untracked }} not tracked
          </span>
          <button
            type="button"
            class="rounded-full border border-purple-500/40 px-2.5 py-1 text-[11px] font-semibold text-purple-700 transition hover:bg-purple-500/10 disabled:opacity-40 dark:text-purple-300"
            :disabled="untrackedSubscriptions.length === 0 || syncing"
            title="Add every untracked subscription to the suggestion list"
            @click="suggestAllUntracked"
          >
            ＋ Suggest all
          </button>
          <span
            v-if="suggestedCount > 0"
            class="flex items-center gap-1 text-neutral-500"
          >
            {{ suggestedCount }} suggested
            <button
              type="button"
              class="rounded-full px-1.5 py-0.5 text-[10px] font-semibold text-neutral-500 underline-offset-2 hover:text-red-600 hover:underline"
              title="Remove every channel from the suggestion list"
              @click="clearAllSuggestions"
            >
              clear
            </button>
          </span>

          <span
            class="mx-1 hidden h-4 w-px bg-black/10 sm:block dark:bg-white/10"
          ></span>

          <label
            class="flex cursor-pointer items-center gap-1.5 text-neutral-600 dark:text-neutral-300"
            title="Importing a subscription list publishes third-party channel records — only do it for an account you own or are allowed to use"
          >
            <input
              v-model="syncConsent"
              type="checkbox"
              class="h-3.5 w-3.5 accent-purple-600"
            />
            I own this account or have permission
          </label>
          <button
            type="button"
            class="rounded-full bg-purple-600 px-2.5 py-1 text-[11px] font-semibold text-white transition hover:opacity-90 disabled:opacity-40"
            :disabled="
              !syncConsent ||
              syncing ||
              suggestedCount === 0 ||
              datasetApi !== 'available'
            "
            :title="
              datasetApi === 'available'
                ? 'Fetch each suggested channel and write it into data/'
                : 'Needs the local dev server (npm run dev)'
            "
            @click="syncSuggested"
          >
            {{ syncing ? "Adding…" : `Add ${suggestedCount} to dataset` }}
          </button>
          <button
            v-if="datasetApi === 'unavailable'"
            type="button"
            class="rounded-full border border-black/10 px-2.5 py-1 text-[11px] font-semibold dark:border-white/12"
            title="The static build cannot write to data/ — download the list and commit it"
            @click="downloadSuggestions"
          >
            ⬇ suggestions.json
          </button>

          <span v-if="syncState" class="text-neutral-500">
            {{ syncState.done }}/{{ syncState.total }} ·
            {{ syncState.added }} added<template v-if="syncState.failed">
              · {{ syncState.failed }} failed</template
            >
          </span>
          <span
            v-else-if="datasetApi === 'unavailable'"
            class="basis-full text-[11px] leading-relaxed text-neutral-500"
          >
            Static build: suggestions are kept in this browser. Download them,
            commit <code>data/suggestions.json</code>, then import with the local
            dev server.
          </span>
        </div>

        <!-- Official Artist badge sync: background, one channel at a time -->
        <div
          v-if="
            hasAnyAccount &&
            subscriptionCounts.all > 0 &&
            (badgeSync.running || badgeSync.error || badgeSync.stopped)
          "
          class="mb-3 rounded-xl border border-black/8 bg-white p-2.5 text-xs shadow-sm dark:border-white/10 dark:bg-neutral-900"
          aria-live="polite"
        >
          <div class="flex flex-wrap items-center gap-2">
            <span class="font-semibold">🎵 Official Artist badges</span>
            <span v-if="badgeSync.running" class="text-neutral-500">
              {{ badgeSync.done }}/{{ badgeSync.total }}
            </span>
            <span v-else-if="badgeSync.error" class="text-amber-700 dark:text-amber-400">
              Paused
            </span>
            <span v-else class="text-neutral-500">
              stopped at {{ badgeSync.done }}/{{ badgeSync.total }}
            </span>
            <div
              class="h-1.5 min-w-24 flex-1 overflow-hidden rounded-full bg-black/8 dark:bg-white/10"
              role="progressbar"
              :aria-valuenow="badgeSync.done"
              :aria-valuemin="0"
              :aria-valuemax="badgeSync.total"
            >
              <div
                class="h-full rounded-full bg-purple-600 transition-all"
                :style="{
                  width:
                    (badgeSync.total
                      ? Math.round((badgeSync.done / badgeSync.total) * 100)
                      : 0) + '%',
                }"
              ></div>
            </div>
            <button
              v-if="badgeSync.running"
              type="button"
              class="rounded-full border border-black/10 px-2.5 py-1 text-[11px] font-semibold dark:border-white/12"
              @click="stopBadgeSync"
            >
              Stop
            </button>
            <button
              v-else
              type="button"
              class="rounded-full border border-purple-500/40 px-2.5 py-1 text-[11px] font-semibold text-purple-700 dark:text-purple-300"
              @click="resumeBadgeSync"
            >
              Resume
            </button>
          </div>
          <p
            v-if="badgeSync.error"
            class="mt-1 text-[11px] leading-relaxed text-amber-700 dark:text-amber-400"
          >
            {{ badgeSync.error }}
          </p>
          <p v-else class="mt-1 text-[11px] leading-relaxed text-neutral-500">
            Reading the 🎵 badge from each YouTube channel header. Results are
            cached for 30 days; the TV subscription feed does not carry it.
          </p>
        </div>

        <div
          v-if="!hasAnyAccount"
          class="mx-auto max-w-md rounded-xl border border-black/8 bg-white p-6 text-center shadow-sm dark:border-white/10 dark:bg-neutral-900"
        >
          <p class="text-sm font-semibold">Link your accounts</p>
          <p class="mt-2 text-xs text-neutral-500">
            See every VTuber and singer you subscribe to on YouTube, Twitch,
            Bilibili, Niconico, VK, CHZZK and KICK, matched against the
            dataset. Your token stays in this browser.
          </p>
          <p class="mt-2 text-[11px] leading-relaxed text-neutral-500">
            YouTube asks for <span class="font-semibold">manage your account</span>
            access: InnerTube refuses the read-only scope when it reads a
            subscription list beyond 1,000. The token still stays in this
            browser; the local dev server only forwards it to YouTube.
          </p>
          <div class="mt-4 flex flex-wrap justify-center gap-2">
            <button
              v-for="provider in AUTH_PROVIDERS"
              :key="provider.id"
              type="button"
              class="rounded-full px-3 py-2 text-xs font-bold text-white transition hover:opacity-85 disabled:opacity-40"
              :style="{ backgroundColor: provider.color }"
              :title="provider.unavailableReason() ?? ''"
              :disabled="state.subscriptionsLoading"
              @click="linkProvider(provider)"
            >
              {{ provider.label }}
            </button>
          </div>
          <p
            v-if="state.subscriptionsLoading"
            class="mt-3 text-xs text-neutral-500"
          >
            Waiting for the sign-in window — finish signing in there, then come
            back to this tab.
          </p>
          <p class="mt-3 text-xs text-neutral-500">
            More than 1,000 subscriptions? With the local dev server, Refresh
            reads the complete list through InnerTube. A static build still
            stops at 1,000, so
            <button
              type="button"
              class="font-semibold underline"
              @click="showSubsExport = true"
            >
              Export from YouTube</button
            >
            remains the no-link path — it pages the signed-in session, so the
            page's 1,000-card limit does not apply — or import a
            <span class="font-semibold">PocketTube backup</span> (Backup →
            Export). <span class="font-semibold">Import CSV / JSON</span> accepts
            both, and neither waits for Takeout.
          </p>
        </div>

        <div
          v-else-if="visibleSubscriptions.length"
          class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6"
        >
          <div
            v-for="sub in visibleSubscriptions"
            :key="sub.channelId"
            v-memo="[
              sub,
              state.youtubeBadges[sub.channelId],
              state.youtubeDetails[sub.channelId],
              summaryById,
              summaryByName,
              liveByChannel,
              upcomingByChannel,
              songCountByChannel,
              state.suggested,
            ]"
            class="group flex flex-col overflow-hidden rounded-xl border border-black/8 bg-white shadow-sm transition hover:shadow-md dark:border-white/10 dark:bg-neutral-900"
          >
            <button
              type="button"
              class="flex flex-1 flex-col items-center gap-2 p-3 text-center"
              :title="
                knownSubscription(sub)
                  ? 'Open the channel'
                  : 'Load this channel’s YouTube details'
              "
              @click="openSubscription(sub)"
            >
              <img
                :src="sub.thumbnail ?? ''"
                :alt="sub.title"
                loading="lazy"
                class="h-16 w-16 rounded-full object-cover ring-2 ring-black/5 dark:ring-white/10"
              />
              <span class="line-clamp-2 text-xs leading-tight font-semibold">
                {{ sub.title
                }}<OfficialArtistBadge
                  v-if="hasOfficialArtistBadge(sub)"
                  size="xs"
                  class="ml-1"
                />
              </span>
              <span class="flex flex-wrap justify-center gap-1">
                <span
                  class="rounded px-1.5 py-0.5 text-[10px] font-semibold text-white"
                  :style="{
                    backgroundColor:
                      AUTH_PROVIDERS.find((p) => p.id === sub.provider)
                        ?.color ?? '#6b7280',
                  }"
                >
                  {{
                    AUTH_PROVIDERS.find((p) => p.id === sub.provider)?.label ??
                    sub.provider
                  }}
                </span>
                <span
                  class="rounded px-1.5 py-0.5 text-[10px] font-semibold"
                  :class="
                    sub.known
                      ? 'bg-purple-600/15 text-purple-700 dark:text-purple-300'
                      : 'bg-amber-500/15 text-amber-700 dark:text-amber-400'
                  "
                >
                  {{ sub.known ? "In dataset" : "Not tracked yet" }}
                </span>
                <span
                  v-if="subscriptionIsLive(sub)"
                  class="rounded bg-red-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-red-700 dark:text-red-400"
                  title="Streaming live on YouTube now"
                >
                  🔴 Live
                </span>
                <span
                  v-if="subscriptionIsUpcoming(sub)"
                  class="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700 dark:text-amber-400"
                  title="A scheduled stream or premiere is listed"
                >
                  📅 Upcoming
                </span>
                <span
                  v-if="subscriptionSongCount(sub) > 0"
                  class="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700 dark:text-emerald-400"
                  title="Songs and releases known for this channel"
                >
                  🎼 {{ subscriptionSongCount(sub) }}
                </span>
              </span>
            </button>

            <!-- Suggest an untracked channel; remove a suggested one -->
            <div
              v-if="!sub.known || isSubSuggested(sub)"
              class="px-2 pb-2"
            >
              <button
                v-if="!isSubSuggested(sub)"
                type="button"
                class="w-full rounded-full border border-purple-500/40 px-2 py-1 text-[10px] font-semibold text-purple-700 transition hover:bg-purple-500/10 disabled:opacity-40 dark:text-purple-300"
                :disabled="syncing"
                title="Add this channel to the suggestion list"
                @click.stop="suggestSubscriptions([sub])"
              >
                ＋ Suggest
              </button>
              <div v-else class="flex items-center gap-1">
                <span
                  class="flex-1 rounded-full bg-emerald-500/10 px-2 py-1 text-center text-[10px] font-semibold text-emerald-700 dark:text-emerald-400"
                >
                  Suggested ✓
                </span>
                <button
                  type="button"
                  class="rounded-full px-1.5 py-1 text-[10px] font-semibold text-neutral-400 transition hover:text-red-600"
                  title="Remove this channel from the suggestion list"
                  aria-label="Remove from the suggestion list"
                  @click.stop="unsuggestSubscriptions([sub])"
                >
                  ✕
                </button>
              </div>
            </div>
          </div>
        </div>

        <p v-else class="py-16 text-center text-sm text-neutral-500">
          No subscriptions match this filter.
        </p>
      </section>

      <!-- Saved -->
      <section v-else-if="state.view === 'saved'" aria-label="Saved">
        <h2 class="mb-3 text-lg font-bold">
          Saved
          <span class="ml-1 text-sm font-normal text-neutral-500">
            {{ savedChannels.length + visibleSaved.length }}
          </span>
        </h2>
        <template v-if="savedChannels.length || visibleSaved.length">
          <!-- Channels are the common case: the drawer's Save button -->
          <div
            v-if="savedChannels.length"
            class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6"
          >
            <ChannelCard
              v-for="channel in savedChannels"
              :key="channel.id"
              :channel="channel"
              @open="openChannel"
            />
          </div>
          <!-- Items (videos) are saved from the player view -->
          <div
            v-if="visibleSaved.length"
            class="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5"
          >
            <LiveCard
              v-for="item in visibleSaved"
              :key="item.id"
              :item="item"
              :channel="summaryById.get(item.channelId) ?? null"
              @open="openItem"
            />
          </div>
        </template>
        <p v-else class="py-16 text-center text-sm text-neutral-500">
          Nothing saved yet — open a channel and use “Save channel”.
        </p>
      </section>
    </main>

    <!-- ───────────────────────── Mobile nav ───────────────────────── -->
    <nav
      class="fixed inset-x-0 bottom-0 z-40 grid grid-cols-6 border-t border-black/8 bg-[#f6f5f1]/95 backdrop-blur-xl md:hidden dark:border-white/10 dark:bg-neutral-950/95"
      aria-label="Primary"
    >
      <button
        v-for="view in VIEWS"
        :key="view.id"
        type="button"
        class="flex flex-col items-center gap-0.5 py-2 text-[10px] font-semibold transition"
        :class="
          state.view === view.id
            ? 'text-purple-600 dark:text-purple-400'
            : 'text-neutral-500'
        "
        @click="setView(view.id)"
      >
        <span class="text-base leading-none" aria-hidden="true">
          {{
            view.id === "live"
              ? "🔴"
              : view.id === "upcoming"
                ? "📅"
                : view.id === "songs"
                  ? "🎵"
                  : view.id === "channels"
                    ? "👥"
                    : view.id === "subs"
                      ? "👤"
                      : "🔖"
          }}
        </span>
        {{ view.short }}
      </button>
    </nav>

    <!-- ───────────────────────── Drawer ───────────────────────── -->
    <ChannelDrawer
      :channel="drawerChannel"
      :item="drawerItem"
      :items="allItems"
      :summaries="summaries"
      :badge-override="drawerBadgeOverride"
      @close="
        drawerChannel = null;
        drawerItem = null;
      "
      @open-item="openItem"
      @open-channel="openChannel"
    />

    <!-- Untracked subscription: YouTube details fetched on open -->
    <SubscriptionDetail
      v-if="activeSub"
      :sub="activeSub"
      :detail="activeSubDetail"
      :loading="subDetailLoading"
      :error="subDetailError"
      @close="closeSubDetail"
      @retry="retrySubDetail"
    />

    <!-- ─────────────────── No-Takeout subscription export ─────────────────── -->
    <Transition
      enter-active-class="transition duration-200 ease-out"
      enter-from-class="opacity-0"
      leave-active-class="transition duration-150 ease-in"
      leave-to-class="opacity-0"
    >
      <div
        v-if="showSubsExport"
        class="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-3 sm:items-center"
        @click.self="showSubsExport = false"
      >
        <div
          class="max-h-[90vh] w-full max-w-2xl overflow-auto rounded-2xl border border-black/10 bg-white p-4 shadow-xl dark:border-white/10 dark:bg-neutral-900"
          role="dialog"
          aria-modal="true"
          aria-labelledby="subs-export-title"
        >
          <div class="flex items-start justify-between gap-3">
            <div>
              <p id="subs-export-title" class="text-sm font-bold">
                Export your subscriptions from YouTube
              </p>
              <p class="mt-1 text-xs leading-relaxed text-neutral-500">
                Your signed-in subscriptions page already knows the list. This
                script asks YouTube for it through the same signed request the
                page uses, page by page, so it reads <em>all</em> of it — the
                page's 1,000-card limit does not apply. It downloads the same
                CSV shape Takeout uses: no API key, no OAuth, no Takeout queue,
                and nothing is uploaded.
              </p>
            </div>
            <button
              type="button"
              class="shrink-0 rounded-full px-2 py-1 text-xs text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100"
              aria-label="Close"
              @click="showSubsExport = false"
            >
              ✕
            </button>
          </div>

          <ol
            class="mt-3 list-decimal space-y-1 pl-5 text-xs leading-relaxed text-neutral-600 dark:text-neutral-300"
          >
            <li>
              Open
              <a
                class="underline"
                href="https://www.youtube.com/feed/channels"
                target="_blank"
                rel="noopener"
                >youtube.com/feed/channels</a
              >
              while signed in.
            </li>
            <li>Open DevTools (⌥⌘I / F12) → Console.</li>
            <li>
              Paste the script below and press Enter. It pages the list (about
              50 requests for 5,000 channels; progress is logged in the console)
              and downloads <code>subscriptions.csv</code>. Leave the tab open
              until it finishes.
            </li>
            <li>
              Back here: <span class="font-semibold">Import CSV / JSON</span> →
              choose that file.
            </li>
          </ol>

          <p
            class="mt-3 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-2 text-[11px] leading-relaxed text-emerald-900 dark:text-emerald-200"
          >
            <span class="font-semibold">The whole list, not the first page.</span>
            The page renders at most 1,000 cards, but the script keeps asking
            YouTube's signed-in API for the next page until it ends. It reads
            the session's <code>SAPISID</code> cookie only to sign those
            requests to <code>youtube.com</code>; the cookie is never printed or
            sent anywhere else. If YouTube refuses the signed request, the script
            falls back to the rendered page and tells you it did.
          </p>

          <p class="mt-2 text-[11px] leading-relaxed text-neutral-500">
            If the console refuses the paste, type
            <code>allow pasting</code> and press Enter first. Everything runs in
            your own browser — the list is never uploaded.
          </p>

          <textarea
            readonly
            :value="SUBS_EXPORT_SCRIPT"
            spellcheck="false"
            class="mt-3 h-40 w-full resize-y rounded-lg border border-black/10 bg-neutral-50 p-2 font-mono text-[10px] leading-snug text-neutral-700 dark:border-white/10 dark:bg-neutral-950 dark:text-neutral-300"
          ></textarea>

          <div class="mt-3 flex flex-wrap justify-end gap-2">
            <button
              type="button"
              class="rounded-full border border-black/10 px-3 py-1.5 text-xs font-semibold dark:border-white/12"
              @click="showSubsExport = false"
            >
              Close
            </button>
            <button
              type="button"
              class="rounded-full bg-purple-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:opacity-90"
              @click="copySubsScript"
            >
              {{ subsScriptCopied ? "Copied ✓" : "Copy script" }}
            </button>
          </div>
        </div>
      </div>
    </Transition>

    <!-- ───────────────────────── Toast ───────────────────────── -->
    <Transition
      enter-active-class="transition duration-200 ease-out"
      enter-from-class="translate-y-2 opacity-0"
      leave-active-class="transition duration-150 ease-in"
      leave-to-class="translate-y-2 opacity-0"
    >
      <div
        v-if="state.toast"
        class="fixed bottom-20 left-1/2 z-50 -translate-x-1/2 rounded-full px-4 py-2 text-xs font-semibold shadow-lg md:bottom-6"
        :class="
          state.toast.type === 'error'
            ? 'bg-red-600 text-white'
            : state.toast.type === 'success'
              ? 'bg-emerald-600 text-white'
              : 'bg-neutral-900 text-white dark:bg-white dark:text-neutral-900'
        "
        role="status"
      >
        {{ state.toast.text }}
      </div>
    </Transition>
  </div>
</template>
