#!/usr/bin/env tsx

import fs from "node:fs";
import path from "node:path";
import {
  ANALYTICS_PENDING_PATH,
  type AnalyticsDay,
  type AnalyticsIndex,
  type AnalyticsObservation,
} from "./lib/analytics";
import { stableStringify } from "./lib/io";

function readJson<T>(file: string, fallback: T): T {
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}

function main(): void {
  const archivePath = process.argv[2];
  if (!archivePath) {
    throw new Error(
      "Usage: npm run data:analytics:append -- <archive-repository-path>",
    );
  }
  if (!fs.existsSync(ANALYTICS_PENDING_PATH)) {
    throw new Error(`No analytics export found at ${ANALYTICS_PENDING_PATH}`);
  }

  const pending = readJson<AnalyticsDay>(ANALYTICS_PENDING_PATH, {
    schemaVersion: 1,
    date: "",
    observations: [],
    content: [],
  });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(pending.date)) {
    throw new Error(`Invalid analytics date: ${pending.date}`);
  }

  const dataDir = path.join(archivePath, "data");
  const dailyDir = path.join(dataDir, "daily");
  fs.mkdirSync(dailyDir, { recursive: true });
  const dayPath = path.join(dailyDir, `${pending.date}.json`);
  const day = readJson<AnalyticsDay>(dayPath, {
    schemaVersion: 1,
    date: pending.date,
    observations: [],
  });
  const byIdentity = new Map<string, AnalyticsObservation>();
  for (const observation of day.observations) {
    byIdentity.set(`${observation.platform}:${observation.channelId}`, observation);
  }
  for (const observation of pending.observations) {
    const key = `${observation.platform}:${observation.channelId}`;
    const previous = byIdentity.get(key);
    byIdentity.set(key, {
      ...previous,
      ...observation,
      followers: observation.followers ?? previous?.followers,
      views: observation.views ?? previous?.views,
      videos: observation.videos ?? previous?.videos,
      liveViewers: observation.liveViewers ?? previous?.liveViewers,
      recentContentViews:
        observation.recentContentViews ?? previous?.recentContentViews,
    });
  }
  const observations = [...byIdentity.values()].sort(
    (a, b) =>
      a.platform.localeCompare(b.platform) ||
      a.channelName.localeCompare(b.channelName) ||
      a.channelId.localeCompare(b.channelId),
  );
  const nextDay: AnalyticsDay = {
    schemaVersion: 1,
    date: pending.date,
    observations,
    content: (() => {
      const contentById = new Map(
        (day.content ?? []).map((entry) => [
          `${entry.platform}:${entry.channelId}:${entry.url}`,
          entry,
        ]),
      );
      for (const entry of pending.content ?? []) {
        contentById.set(
          `${entry.platform}:${entry.channelId}:${entry.url}`,
          entry,
        );
      }
      return [...contentById.values()].sort(
        (a, b) =>
          b.views - a.views ||
          a.platform.localeCompare(b.platform) ||
          a.title.localeCompare(b.title),
      );
    })(),
  };
  fs.writeFileSync(dayPath, stableStringify(nextDay));

  const indexPath = path.join(dataDir, "index.json");
  const previous = readJson<AnalyticsIndex>(indexPath, {
    schemaVersion: 1,
    generatedAt: "",
    dates: [],
  });
  const index: AnalyticsIndex = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    dates: [...new Set([...previous.dates, pending.date])].sort(),
  };
  fs.writeFileSync(indexPath, stableStringify(index));
  console.log(
    `[analytics] ${pending.date}: ${observations.length} platform/channel observations`,
  );
}

main();
