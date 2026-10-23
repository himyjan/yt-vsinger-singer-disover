import type { ArtistKind, KnownPlatformId, RegionCode } from "@shared/lib/types";
import type { Scope } from "@/lib/store";

export interface AnalyticsObservation {
  date: string;
  sampledAt: string;
  channelId: string;
  channelName: string;
  kind: ArtistKind;
  region: RegionCode;
  platform: KnownPlatformId;
  followers?: number;
  views?: number;
  videos?: number;
  liveViewers?: number;
  recentContentViews?: number;
}

export interface AnalyticsContentObservation {
  platform: KnownPlatformId;
  channelId: string;
  channelName: string;
  kind: ArtistKind;
  region: RegionCode;
  title: string;
  url: string;
  publishedAt: string | null;
  views: number;
}

export interface AnalyticsDay {
  date: string;
  observations: AnalyticsObservation[];
  content?: AnalyticsContentObservation[];
}

export interface AnalyticsIndex {
  schemaVersion: 1;
  dates: string[];
}

export type AnalyticsMetric =
  | "followers"
  | "views"
  | "videos"
  | "recentContentViews"
  | "liveViewers";

const ARCHIVE_BASE =
  "https://raw.githubusercontent.com/himyjan/yt-vsinger-singer-disover-analytics/main/data";
const dayCache = new Map<string, Promise<AnalyticsDay | null>>();
let indexCache: Promise<AnalyticsIndex | null> | null = null;

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const response = await fetch(url, {
      headers: { Accept: "application/json" },
    });
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

export function loadAnalyticsIndex(): Promise<AnalyticsIndex | null> {
  indexCache ??= fetchJson<AnalyticsIndex>(`${ARCHIVE_BASE}/index.json`).then(
    (index) => {
      if (!index) indexCache = null;
      return index;
    },
  );
  return indexCache;
}

export async function detectAnalyticsArchive(): Promise<boolean> {
  const index = await loadAnalyticsIndex();
  return Boolean(
    index &&
      index.schemaVersion === 1 &&
      Array.isArray(index.dates) &&
      index.dates.length > 0,
  );
}

export function loadAnalyticsDay(date: string): Promise<AnalyticsDay | null> {
  let request = dayCache.get(date);
  if (!request) {
    request = fetchJson<AnalyticsDay>(`${ARCHIVE_BASE}/daily/${date}.json`).then(
      (day) => {
        if (!day) dayCache.delete(date);
        return day;
      },
    );
    dayCache.set(date, request);
  }
  return request;
}

export async function loadAnalyticsRange(
  days: 30 | 90 | 365,
  forceRefresh = false,
): Promise<AnalyticsDay[]> {
  if (forceRefresh) {
    indexCache = null;
    dayCache.clear();
  }
  const index = await loadAnalyticsIndex();
  if (!index) throw new Error("The analytics archive is not available.");
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - days + 1);
  const start = cutoff.toISOString().slice(0, 10);
  const dates = index.dates.filter((date) => date >= start);
  const results = await Promise.all(dates.map(loadAnalyticsDay));
  return results.filter((day): day is AnalyticsDay => day !== null);
}

export function filterAnalyticsDays(
  days: AnalyticsDay[],
  filters: {
    scope: Scope;
    region: RegionCode | "all";
    platform: string;
  },
): AnalyticsDay[] {
  return days.map((day) => ({
    ...day,
    observations: day.observations.filter((observation) => {
      if (filters.scope !== "both" && observation.kind !== filters.scope) return false;
      if (filters.region !== "all" && observation.region !== filters.region) return false;
      return filters.platform === "all" || observation.platform === filters.platform;
    }),
    content: (day.content ?? []).filter((item) => {
      if (filters.scope !== "both" && item.kind !== filters.scope) return false;
      if (filters.region !== "all" && item.region !== filters.region) return false;
      return filters.platform === "all" || item.platform === filters.platform;
    }),
  }));
}

export const ANALYTICS_METRICS: {
  id: AnalyticsMetric;
  label: string;
}[] = [
  { id: "followers", label: "Followers / subscribers" },
  { id: "views", label: "Lifetime channel views" },
  { id: "videos", label: "Published videos" },
  { id: "recentContentViews", label: "Average recent content views" },
  { id: "liveViewers", label: "Live viewers" },
];

export const ANALYTICS_PLATFORM_SUPPORT: Record<
  KnownPlatformId,
  Partial<Record<AnalyticsMetric, string>>
> = {
  youtube: {
    followers: "Public count when available",
    views: "Public channel statistics when exposed by InnerTube/API",
    videos: "Public channel statistics when exposed by InnerTube/API",
    recentContentViews: "Recent uploads when view counts are available",
    liveViewers: "Active live stream samples",
  },
  twitch: {
    followers: "Public follower count where Twitch exposes it",
    liveViewers: "Active live stream samples",
  },
  bilibili: {
    followers: "Public profile/relation count",
    videos: "Public profile archive count",
    recentContentViews: "Recent uploads when Bilibili allows profile access",
    liveViewers: "Active live stream samples",
  },
  niconico: {
    recentContentViews: "Recent video view counters",
  },
  vk: {
    followers: "Requires VK access token",
    videos: "Requires VK access token",
    recentContentViews: "Recent video views (requires VK access token)",
  },
  chzzk: {
    followers: "Public channel follower count",
    liveViewers: "Active live stream samples",
  },
  kick: {
    followers: "Public channel follower count",
    liveViewers: "Active live stream samples",
  },
  soop: {
    liveViewers: "Public live-feed samples; no offline profile metric",
  },
  "ci.me": {
    followers: "Requires CI.ME application credentials",
  },
};

export function metricValue(
  observation: AnalyticsObservation,
  metric: AnalyticsMetric,
): number | undefined {
  return observation[metric];
}

export function formatMetric(value: number, metric: AnalyticsMetric): string {
  if (metric === "liveViewers") return `${Math.round(value).toLocaleString()} live`;
  return Math.round(value).toLocaleString();
}
