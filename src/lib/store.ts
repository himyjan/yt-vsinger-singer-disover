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
  ArtistKind,
  Gender,
  ItemCategory,
  RegionCode,
} from "@shared/lib/types";

export type Scope = "virtual" | "real" | "both";
export type ViewId =
  | "live"
  | "upcoming"
  | "songs"
  | "channels"
  | "subs"
  | "saved";

export type Theme = "light" | "dark";

const THEME_KEY = "vst.theme";
const SCOPE_KEY = "vst.scope";
const REGION_KEY = "vst.region";
const SAVED_KEY = "vst.saved";
const VIEW_KEY = "vst.view";
const ACCOUNT_KEY = "vst.accounts";
const ACTIVE_KEY = "vst.activeAccount";
const SUBS_KEY = "vst.subscriptions";

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
  /** AI filter: show AI performers, hide them, or show both. */
  ai: "all" as "ai" | "human" | "all",
  /**
   * Subscription filter: show every subscription, only the ones already in
   * the dataset, or only the ones that are not tracked yet.
   */
  subsTracked: "all" as "all" | "tracked" | "untracked",
  /** Active view. */
  view: readStorage<ViewId>(VIEW_KEY, "live"),
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
  /** True while a subscription list is loading. */
  subscriptionsLoading: false,
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
export function allSubscriptions(): Subscription[] {
  return Object.values(state.subscriptions).flat();
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
