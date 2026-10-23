/**
 * Reactive application state.
 *
 * A plain reactive object is used instead of a store library — the app has
 * one shared piece of state and a dependency-free implementation keeps the
 * GitHub Pages bundle small.
 *
 * Every filter in the app honours the three global scopes:
 *   `virtual` — VTuber / VSinger performers only
 *   `real`    — real human singers / producers only
 *   `both`    — everything
 *
 * The scope is applied in `dataset.ts` at query time, so a new view never has
 * to remember to filter — the scope switch works everywhere by construction.
 */

import { reactive, computed, watch } from "vue";
import type {
  Affiliation,
  ArtistKind,
  Gender,
  ItemCategory,
  RegionCode,
} from "@shared/lib/types";
import type { YouTubeChannelDetail } from "./youtube-detail";

export type Scope = "virtual" | "real" | "both";
export type ViewId =
  | "live"
  | "upcoming"
  | "songs"
  | "analytics"
  | "channels"
  | "subs"
  | "saved";

export type Theme = "light" | "dark";

const THEME_KEY = "vst.theme";
const SCOPE_KEY = "vst.scope";
const REGION_KEY = "vst.region";
const PLATFORM_KEY = "vst.platform";
const SAVED_KEY = "vst.saved";
const VIEW_KEY = "vst.view";
const ACCOUNT_KEY = "vst.accounts";
const ACTIVE_KEY = "vst.activeAccount";
const SUBS_KEY = "vst.subscriptions";
const SUGGESTED_KEY = "vst.suggested";
const BADGES_KEY = "vst.youtubeBadges";
const DETAILS_KEY = "vst.youtubeDetails";

function initialView(): ViewId {
  const view = readStorage<ViewId>(VIEW_KEY, "live");
  return view === "analytics" ? "live" : view;
}

/**
 * How long a cached 🎵 result is trusted.
 *
 * The badge is a fact about the channel, not a live state: it rarely changes,
 * and re-checking 4,800 channels every visit would be abusive. Thirty days is
 * long enough to make the sync a one-off and short enough to pick up an artist
 * who joins YouTube Music later.
 */
export const YOUTUBE_BADGE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** One cached Official Artist check. */
export interface YouTubeBadgeEntry {
  officialArtist: boolean;
  checkedAt: number;
}

export interface SavedEntry {
  id: string;
  kind: "channel" | "item";
  title: string;
  thumbnail: string | null;
  channelName?: string;
  savedAt: number;
}

export interface LinkedAccount {
  /** Stable id for this linked account, unique across providers. */
  id: string;
  /** Which platform this account belongs to. */
  provider: string;
  /** Display name of the linked account. */
  name: string | null;
  /** Profile image of the linked account. */
  picture: string | null;
  /** OAuth access token (kept in localStorage only). */
  token: string;
  /** ISO expiry timestamp, or `null` when it does not expire. */
  expiresAt: number | null;
  /** Extra provider-specific state. */
  extra?: Record<string, string>;
}

function readStorage<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeStorage(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private browsing / quota — ignore */
  }
}

/**
 * Reads the suggestion queue.
 *
 * The stored value has changed shape across builds — a `platform:id` array
 * now, a keyed object before — and a leftover object would make
 * `includes`/`filter` throw on every click. Normalizing on read means an old
 * `localStorage` cannot break the Suggest / Remove buttons.
 */
function readSuggestedKeys(): string[] {
  const raw = readStorage<unknown>(SUGGESTED_KEY, []);
  if (Array.isArray(raw)) {
    return raw.filter((key): key is string => typeof key === "string");
  }
  if (raw && typeof raw === "object") {
    return Object.keys(raw as Record<string, unknown>).filter(
      (key) => Boolean((raw as Record<string, unknown>)[key]),
    );
  }
  return [];
}

const initialTheme: Theme = (() => {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    if (stored === "dark" || stored === "light") return stored;
    return window.matchMedia?.("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  } catch {
    return "light";
  }
})();

export const state = reactive({
  /** Global artist scope. */
  scope: readStorage<Scope>(SCOPE_KEY, "both"),
  /** Active region filter, or `all`. */
  region: readStorage<RegionCode | "all">(REGION_KEY, "all"),
  /** Active platform filter, or `all`. */
  platform: readStorage<string | "all">(PLATFORM_KEY, "all"),
  /**
   * Active content-category filters.
   *
   * An array rather than a single value so several categories can be
   * combined — "MVs and covers" is a query people actually want, and a
   * single-select dropdown cannot express it.
   */
  categories: [] as ItemCategory[],
  /** Only show uploads that are singing while playing an instrument. */
  acousticOnly: false,
  /** Gender filter. */
  gender: "all" as Gender | "all",
  /** A language filter — the performers who stream in it. */
  language: "all" as string | "all",
  /** Only the channels that publish singing content. */
  singing: "all" as "all" | "singing" | "not-singing",
  /**
   * The sort order of each view.
   *
   * Every tab sorts — the live tab by how long the stream has been running,
   * the songs tab by when they were published, the channels tab by followers.
   */
  sort: {
    live: "recent" as "recent" | "viewers" | "subscribers" | "title",
    upcoming: "soon" as "soon" | "title" | "subscribers",
    songs: "recent" as "recent" | "oldest" | "title" | "views" | "duration",
    channels: "subscribers" as "subscribers" | "name" | "recent" | "region",
    subs: "name" as "name" | "platform" | "tracked",
    saved: "recent" as "recent" | "oldest" | "title",
  },
  /**
   * Business filter: independent performers, agency performers, or both.
   * `unknown` means the sources do not say.
   */
  affiliation: "all" as Affiliation | "all",
  /** AI filter: show AI performers, hide them, or show both. */
  ai: "all" as "ai" | "human" | "all",
  /** Official Artist Channel filter: the 🎵 badge only. */
  oac: "all" as "all" | "oac",
  /**
   * Subscription filter: show every subscription, only the ones already in
   * the dataset, or only the ones that are not tracked yet.
   */
  subsTracked: "all" as "all" | "tracked" | "untracked" | "suggested",
  /**
   * Subscription filter for the **channels** view: every channel, only the
   * ones the linked accounts follow, or only the ones they do not — the
   * discovery direction.
   */
  channelSubs: "all" as "all" | "subscribed" | "not-subscribed",
  /** Active view. */
  view: initialView(),
  /** Current search query. */
  query: "",
  /** Theme. */
  theme: initialTheme as Theme,
  /** Saved (bookmarked) channels and items. */
  saved: readStorage<SavedEntry[]>(SAVED_KEY, []),
  /**
   * Every linked account, keyed by platform.
   *
   * A platform can hold several accounts at once (a user may follow two
   * Twitch accounts, or sign into YouTube with more than one Google
   * profile), so each entry is a list.
   */
  accounts: readStorage<Record<string, LinkedAccount[]>>(ACCOUNT_KEY, {}),
  /**
   * The active account per platform. Everything else is kept but inactive —
   * switching is instant and does not require re-authenticating.
   */
  activeAccount: readStorage<Record<string, string | null>>(
    ACTIVE_KEY,
    {},
  ),
  /** Subscriptions, keyed by `<provider>:<accountId>`. */
  subscriptions: readStorage<Record<string, Subscription[]>>(
    SUBS_KEY,
    {},
  ),
  /**
   * The 🎵 Official Artist result per YouTube channel.
   *
   * Kept beside the subscriptions, not inside them: a Refresh replaces the
   * list, and the badge must survive that. The key is the immutable `UC…` id.
   */
  youtubeBadges: readStorage<Record<string, YouTubeBadgeEntry>>(
    BADGES_KEY,
    {},
  ),
  /**
   * The last detailed YouTube snapshot per channel, written only when a
   * subscription card is opened. The list is pruned on write so opening a few
   * hundred channels cannot fill localStorage.
   */
  youtubeDetails: readStorage<Record<string, YouTubeChannelDetail>>(
    DETAILS_KEY,
    {},
  ),
  /**
   * `platform:id` keys already suggested for the dataset.
   *
   * The list itself lives in `data/suggestions.json` on disk, written by the
   * dev server; this is the browser's copy so a suggestion stays ticked
   * across reloads even when the API is not reachable.
   */
  suggested: readSuggestedKeys(),
  /** True while a subscription list is loading. */
  subscriptionsLoading: false,
  /**
   * Progress of a paginated subscription fetch while it runs: how many pages
   * have arrived and what Google says the account has in total.
   */
  subscriptionsProgress: null as { loaded: number; total: number | null } | null,
  /** Error message shown in a toast. */
  toast: null as { type: "info" | "error" | "success"; text: string } | null,
});

export interface Subscription {
  /** Which platform the subscription came from. */
  provider: string;
  channelId: string;
  title: string;
  handle: string | null;
  thumbnail: string | null;
  description: string | null;
  /** `virtual` | `real` | `unknown` — inferred from the local dataset. */
  kind: ArtistKind | "unknown";
  /** The region of the channel in the local dataset, if known. */
  region: RegionCode | null;
  /** Whether the channel exists in the local dataset. */
  known: boolean;
}

/* -------------------------------------------------------------------------- */
/* Derived state                                                              */
/* -------------------------------------------------------------------------- */

/** The artist kind implied by the current scope, or `null` for "both". */
export const scopeKind = computed<ArtistKind | null>(() =>
  state.scope === "both" ? null : state.scope,
);

/* -------------------------------------------------------------------------- */
/* Actions                                                                    */
/* -------------------------------------------------------------------------- */

export function setScope(scope: Scope): void {
  state.scope = scope;
  writeStorage(SCOPE_KEY, scope);
}

export function setRegion(region: RegionCode | "all"): void {
  state.region = region;
  writeStorage(REGION_KEY, region);
}

export function setPlatform(platform: string | "all"): void {
  state.platform = platform;
  writeStorage(PLATFORM_KEY, platform);
}

export function setView(view: ViewId): void {
  state.view = view;
  writeStorage(VIEW_KEY, view);
}

export function toggleTheme(): void {
  state.theme = state.theme === "dark" ? "light" : "dark";
  try {
    localStorage.setItem(THEME_KEY, state.theme);
  } catch {
    /* ignore */
  }
  document.documentElement.classList.toggle("dark", state.theme === "dark");
}

export function isSaved(id: string): boolean {
  return state.saved.some((entry) => entry.id === id);
}

export function toggleSaved(entry: Omit<SavedEntry, "savedAt">): void {
  const index = state.saved.findIndex((s) => s.id === entry.id);
  if (index >= 0) {
    state.saved.splice(index, 1);
  } else {
    state.saved.unshift({ ...entry, savedAt: Date.now() });
  }
  writeStorage(SAVED_KEY, state.saved);
}

/** Adds (or replaces) a linked account and makes it the active one. */
export function addAccount(account: LinkedAccount): void {
  const list = state.accounts[account.provider] ?? [];
  const index = list.findIndex((a) => a.id === account.id);
  if (index >= 0) list.splice(index, 1, account);
  else list.push(account);
  state.accounts[account.provider] = list;
  state.activeAccount[account.provider] = account.id;
  writeStorage(ACCOUNT_KEY, state.accounts);
  writeStorage(ACTIVE_KEY, state.activeAccount);
}

/** Removes a linked account and its subscriptions. */
export function removeAccount(provider: string, accountId: string): void {
  const list = state.accounts[provider] ?? [];
  const index = list.findIndex((a) => a.id === accountId);
  if (index >= 0) list.splice(index, 1);
  if (list.length === 0) delete state.accounts[provider];
  else state.accounts[provider] = list;

  if (state.activeAccount[provider] === accountId) {
    state.activeAccount[provider] = list[0]?.id ?? null;
  }
  delete state.subscriptions[subscriptionKey(provider, accountId)];

  writeStorage(ACCOUNT_KEY, state.accounts);
  writeStorage(ACTIVE_KEY, state.activeAccount);
  writeStorage(SUBS_KEY, state.subscriptions);
}

/** Switches the active account for a platform. */
export function setActiveAccount(provider: string, accountId: string): void {
  state.activeAccount[provider] = accountId;
  writeStorage(ACTIVE_KEY, state.activeAccount);
}

/** The active account for a platform, if any. */
export function activeAccount(provider: string): LinkedAccount | null {
  const id = state.activeAccount[provider];
  if (!id) return null;
  return (state.accounts[provider] ?? []).find((a) => a.id === id) ?? null;
}

/** The key under which a platform account's subscriptions are stored. */
export function subscriptionKey(provider: string, accountId: string): string {
  return `${provider}:${accountId}`;
}

export function setSubscriptions(
  key: string,
  subscriptions: Subscription[],
): void {
  state.subscriptions[key] = subscriptions;
  writeStorage(SUBS_KEY, state.subscriptions);
}

/** Every subscription from every linked account, flattened. */
/**
 * Every stored subscription, once.
 *
 * A channel can be in two lists at the same time — the API's copy under the
 * linked account and an imported PocketTube/Takeout row under `takeout` — and
 * flattening both would draw the card twice. The entry that knows the channel
 * (the API/profile one, `known: true`) wins; the order of first appearance is
 * kept.
 */
export function allSubscriptions(): Subscription[] {
  const merged = new Map<string, Subscription>();
  for (const sub of Object.values(state.subscriptions).flat()) {
    const key = `${sub.provider}:${sub.channelId}`;
    const existing = merged.get(key);
    if (!existing || (!existing.known && sub.known)) merged.set(key, sub);
  }
  return [...merged.values()];
}

/* -------------------------------------------------------------------------- */
/* YouTube badges and detailed snapshots                                      */
/* -------------------------------------------------------------------------- */

let badgeWriteTimer: ReturnType<typeof setTimeout> | null = null;

/** The badge sync writes thousands of entries; batch the localStorage write. */
function persistBadgesSoon(): void {
  if (badgeWriteTimer) return;
  badgeWriteTimer = setTimeout(() => {
    badgeWriteTimer = null;
    writeStorage(BADGES_KEY, state.youtubeBadges);
  }, 1200);
}

/** Records one official-artist check. */
export function setYouTubeBadge(
  channelId: string,
  officialArtist: boolean,
): void {
  state.youtubeBadges[channelId] = {
    officialArtist,
    checkedAt: Date.now(),
  };
  persistBadgesSoon();
}

/**
 * Remembers one opened channel's live/upcoming/releases snapshot.
 *
 * Old entries are pruned by fetch time; the detail cache is a convenience,
 * not the source of truth, so losing old ones is harmless.
 */
export function setYouTubeDetail(detail: YouTubeChannelDetail): void {
  state.youtubeDetails[detail.id] = detail;
  const entries = Object.entries(state.youtubeDetails)
    .sort((a, b) => b[1].fetchedAt - a[1].fetchedAt)
    .slice(0, 200);
  state.youtubeDetails = Object.fromEntries(entries) as Record<
    string,
    YouTubeChannelDetail
  >;
  writeStorage(DETAILS_KEY, state.youtubeDetails);
}

/* -------------------------------------------------------------------------- */
/* Suggestions                                                                */
/* -------------------------------------------------------------------------- */

/** `<platform>:<channelId>` — the same key `data/suggestions.json` uses. */
export function suggestedKey(provider: string, channelId: string): string {
  return `${provider}:${channelId}`;
}

export function isSuggested(provider: string, channelId: string): boolean {
  return state.suggested.includes(suggestedKey(provider, channelId));
}

export function markSuggested(keys: string[]): void {
  if (keys.length === 0) return;
  const set = new Set(state.suggested);
  for (const key of keys) set.add(key);
  state.suggested = [...set];
  writeStorage(SUGGESTED_KEY, state.suggested);
}

export function clearSuggested(keys: string[]): void {
  if (keys.length === 0) return;
  const drop = new Set(keys);
  state.suggested = state.suggested.filter((key) => !drop.has(key));
  writeStorage(SUGGESTED_KEY, state.suggested);
}

/** Every linked account, flattened. */
export function allAccounts(): LinkedAccount[] {
  return Object.values(state.accounts).flat();
}

export function showToast(
  type: "info" | "error" | "success",
  text: string,
  duration = 4000,
): void {
  state.toast = { type, text };
  window.setTimeout(() => {
    if (state.toast?.text === text) state.toast = null;
  }, duration);
}

/* -------------------------------------------------------------------------- */
/* Bootstrapping                                                              */
/* -------------------------------------------------------------------------- */

/** Applies the persisted theme to the document. Called once at startup. */
export function initTheme(): void {
  document.documentElement.classList.toggle("dark", state.theme === "dark");
}

watch(
  () => state.theme,
  (theme) => {
    document.documentElement.classList.toggle("dark", theme === "dark");
  },
);
