import fs from "node:fs";
import path from "node:path";
import { CACHE_DIR, ensureDir, stableStringify } from "./io";
import type { ArtistKind, KnownPlatformId, RegionCode } from "./types";

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
  schemaVersion: 1;
  date: string;
  observations: AnalyticsObservation[];
  content?: AnalyticsContentObservation[];
}

export interface AnalyticsIndex {
  schemaVersion: 1;
  generatedAt: string;
  dates: string[];
}

export const ANALYTICS_PENDING_PATH = path.join(
  CACHE_DIR,
  "analytics-pending.json",
);

export function analyticsDate(value = new Date()): string {
  return value.toISOString().slice(0, 10);
}

export function clearPendingAnalytics(): void {
  fs.rmSync(ANALYTICS_PENDING_PATH, { force: true });
}

export function writePendingAnalytics(
  observations: AnalyticsObservation[],
  content: AnalyticsContentObservation[],
  sampledAt = new Date(),
): void {
  ensureDir(path.dirname(ANALYTICS_PENDING_PATH));
  fs.writeFileSync(
    ANALYTICS_PENDING_PATH,
    stableStringify({
      schemaVersion: 1,
      date: analyticsDate(sampledAt),
      sampledAt: sampledAt.toISOString(),
      observations,
      content,
    }),
  );
}
