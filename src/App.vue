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
import { computed, onMounted, ref, watch } from "vue";
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
  initTheme,
  removeAccount,
  setActiveAccount,
  setRegion,
  setScope,
  setSubscriptions,
  setView,
  state,
  subscriptionKey,
  toggleSaved,
  toggleTheme,
  showToast,
  type Scope,
  type Subscription,
  type ViewId,
} from "@/lib/store";
import {
  AUTH_PROVIDERS,
  normalizeForMatch,
  type AuthProvider,
} from "@/lib/auth";
import { channelLinks, itemUrl, platformMeta } from "@/lib/links";
import LiveCard from "@/components/LiveCard.vue";
import ChannelDrawer from "@/components/ChannelDrawer.vue";

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

const visibleChannels = computed(() =>
  sortChannels(
    filterChannels(summaries.value, {
      kind: state.scope,
      region: state.region,
      gender: state.gender,
      ai: state.ai,
      affiliation: state.affiliation,
      language: state.language,
      singing: state.singing,
      text: state.query.trim() || undefined,
      limit: 400,
    }),
    state.sort.channels,
  ),
);

const linkedProviders = computed(() =>
  AUTH_PROVIDERS.filter((provider) => (state.accounts[provider.id] ?? []).length > 0),
);

const hasAnyAccount = computed(() => allAccounts().length > 0);

/** The account popover. */
const showAccountMenu = ref(false);

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
    return true;
  }),
);

const subscriptionCounts = computed(() => {
  const all = allSubscriptions();
  return {
    all: all.length,
    tracked: all.filter((s) => s.known).length,
    untracked: all.filter((s) => !s.known).length,
  };
});

const visibleSaved = computed(() => {
  const items: Item[] = [];
  for (const entry of state.saved) {
    if (entry.kind !== "item") continue;
    const found = allItems.value.find((i) => i.id === entry.id);
    if (found) items.push(found);
  }
  return sortItems(
    filterItems(items, {
      kind: state.scope,
      region: state.region,
      gender: state.gender,
      ai: state.ai,
      affiliation: state.affiliation,
      language: state.language,
      limit: 200,
    }),
    state.sort.saved,
  );
});

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

function openChannel(channel: Channel | ChannelSummary | null | undefined): void {
  if (!channel) return;
  const full = channelById.value.get(channel.id);
  drawerChannel.value = full ?? (channel as Channel);
  drawerItem.value = null;
}

function openItem(item: Item): void {
  drawerItem.value = item;
  drawerChannel.value = channelById.value.get(item.channelId) ?? null;
}

/**
 * Links a platform account and loads its subscriptions.
 *
 * The subscriptions are matched against the local dataset: an exact channel
 * id wins, otherwise the display name is compared — which is how a YouTube
 * subscription of a VTuber who also streams on Twitch gets recognised.
 */
async function linkProvider(provider: AuthProvider): Promise<void> {
  if (!provider.isConfigured()) {
    showToast("error", provider.unavailableReason() ?? "Not configured.", 6000);
    return;
  }

  state.subscriptionsLoading = true;
  try {
    const linked = await provider.link();
    if (!linked) {
      showToast("info", "Linking cancelled.");
      return;
    }
    const account: LinkedAccount = {
      ...linked,
      id: `${linked.provider}:${randomId()}`,
    };
    addAccount(account);

    const remote = await provider.subscriptions(account);
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
    showToast(
      "success",
      `${provider.label}: ${mapped.length} subscription(s) linked, ${mapped.filter((m) => m.known).length} already tracked.`,
      6000,
    );
  } catch (err) {
    showToast(
      "error",
      `${provider.label}: ${(err as Error).message}`,
      6000,
    );
  } finally {
    state.subscriptionsLoading = false;
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
  for (const provider of linkedProviders.value) {
    const account = activeAccount(provider.id);
    if (!account) continue;
    try {
      const remote = await provider.subscriptions(account as unknown as LinkedAccount);
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
    } catch {
      /* keep the previous list */
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Boot                                                                       */
/* -------------------------------------------------------------------------- */

onMounted(async () => {
  initTheme();
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
        <h2 class="mb-3 text-lg font-bold">
          Channels
          <span class="ml-1 text-sm font-normal text-neutral-500">
            {{ visibleChannels.length }}
          </span>
        </h2>
        <div
          class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6"
        >
          <button
            v-for="channel in visibleChannels"
            :key="channel.id"
            type="button"
            class="group flex flex-col items-center gap-2 rounded-xl border border-black/8 bg-white p-3 text-center shadow-sm transition hover:shadow-md dark:border-white/10 dark:bg-neutral-900"
            @click="openChannel(channel)"
          >
            <img
              :src="channel.avatar ?? ''"
              :alt="channel.name"
              loading="lazy"
              class="h-16 w-16 rounded-full object-cover ring-2 ring-black/5 transition group-hover:ring-purple-400 dark:ring-white/10"
            />
            <span class="line-clamp-2 text-xs leading-tight font-semibold">
              {{ channel.name }}
            </span>
            <span class="text-[11px] text-neutral-500">
              {{ formatCount(channel.subscribers) }} subs
            </span>
            <span class="flex flex-wrap justify-center gap-1">
              <span
                class="rounded px-1.5 py-0.5 text-[10px] font-semibold text-white"
                :class="channel.kind === 'virtual' ? 'bg-purple-600' : 'bg-emerald-600'"
              >
                {{ channel.kind === "virtual" ? "Virtual" : "Real" }}
              </span>
              <span
                class="rounded bg-black/5 px-1.5 py-0.5 text-[10px] font-semibold text-neutral-600 dark:bg-white/10 dark:text-neutral-300"
              >
                {{ channel.region.toUpperCase() }}
              </span>
              <span
                v-if="channel.isSinging"
                class="rounded bg-rose-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-rose-600 dark:text-rose-400"
                title="Publishes covers, MVs, original songs or live singing"
              >
                🎤 Singing
              </span>
              <span
                v-if="channel.activity === 'graduated'"
                class="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-amber-600 dark:text-amber-400"
              >
                Graduated
              </span>
            </span>
          </button>
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

            <button
              v-if="hasAnyAccount"
              type="button"
              class="shrink-0 rounded-full border border-black/10 bg-white px-3 py-1.5 text-xs font-semibold dark:border-white/12 dark:bg-neutral-900"
              @click="reloadSubscriptions"
            >
              Refresh
            </button>
          </div>
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
          <div class="mt-4 flex flex-wrap justify-center gap-2">
            <button
              v-for="provider in AUTH_PROVIDERS"
              :key="provider.id"
              type="button"
              class="rounded-full px-3 py-2 text-xs font-bold text-white transition hover:opacity-85"
              :style="{ backgroundColor: provider.color }"
              :title="provider.unavailableReason() ?? ''"
              @click="linkProvider(provider)"
            >
              {{ provider.label }}
            </button>
          </div>
        </div>

        <div
          v-else-if="visibleSubscriptions.length"
          class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6"
        >
          <button
            v-for="sub in visibleSubscriptions"
            :key="sub.channelId"
            type="button"
            class="group flex flex-col items-center gap-2 rounded-xl border border-black/8 bg-white p-3 text-center shadow-sm transition hover:shadow-md dark:border-white/10 dark:bg-neutral-900"
            @click="openChannel(summaryById.get(sub.channelId) ?? null)"
          >
            <img
              :src="sub.thumbnail ?? ''"
              :alt="sub.title"
              loading="lazy"
              class="h-16 w-16 rounded-full object-cover ring-2 ring-black/5 dark:ring-white/10"
            />
            <span class="line-clamp-2 text-xs leading-tight font-semibold">
              {{ sub.title }}
            </span>
            <span class="flex flex-wrap justify-center gap-1">
              <span
                class="rounded px-1.5 py-0.5 text-[10px] font-semibold text-white"
                :style="{
                  backgroundColor:
                    AUTH_PROVIDERS.find((p) => p.id === sub.provider)?.color ??
                    '#6b7280',
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
            </span>
          </button>
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
            {{ visibleSaved.length }}
          </span>
        </h2>
        <div
          v-if="visibleSaved.length"
          class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5"
        >
          <LiveCard
            v-for="item in visibleSaved"
            :key="item.id"
            :item="item"
            :channel="summaryById.get(item.channelId) ?? null"
            @open="openItem"
          />
        </div>
        <p v-else class="py-16 text-center text-sm text-neutral-500">
          Nothing saved yet — use the bookmark button on any card.
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
      @close="
        drawerChannel = null;
        drawerItem = null;
      "
      @open-item="openItem"
      @open-channel="openChannel"
    />

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
