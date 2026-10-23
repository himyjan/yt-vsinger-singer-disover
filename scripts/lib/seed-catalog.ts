import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./io";
import type {
  ArtistKind,
  ArtistRole,
  KnownPlatformId,
  RegionCode,
} from "./types";

export interface SeedPlatformIdentity {
  /** Profile URL; sync extracts the platform id and refreshes its profile. */
  url: string;
}

export interface SeedEntry {
  /** YouTube handle without `@`. Resolved at sync time. */
  handle?: string;
  /** Canonical channel id. Used when known. */
  channelId?: string;
  /** Profile URLs on supported platforms, keyed by platform id. */
  platformUrls?: Partial<Record<KnownPlatformId, SeedPlatformIdentity>>;
  /** Display name (only used as a fallback when the API is unavailable). */
  name: string;
  kind: ArtistKind;
  role: ArtistRole;
  region: RegionCode;
  /** Agency / group, e.g. `hololive`. */
  agency?: string | null;
  /** Whether the channel is known to publish singing content. */
  isSinging?: boolean;
  /** Free-text note surfaced in the UI. */
  note?: string;
}

const seedCatalogPath = path.join(ROOT, "data", "seed-catalog.json");
const roles = new Set<ArtistRole>([
  "vsinger",
  "vtuber",
  "singer",
  "musician",
  "producer",
  "composer",
  "unknown",
]);
const regions = new Set<RegionCode>([
  "jp",
  "cn",
  "tw",
  "hk",
  "kr",
  "en",
  "id",
  "my",
  "sea",
  "unknown",
]);
const platforms = new Set<KnownPlatformId>([
  "youtube",
  "twitch",
  "bilibili",
  "niconico",
  "vk",
  "chzzk",
  "kick",
  "soop",
  "ci.me",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSeedEntry(value: unknown): value is SeedEntry {
  if (!isRecord(value)) return false;
  if (
    typeof value.name !== "string" ||
    (value.kind !== "virtual" && value.kind !== "real") ||
    typeof value.role !== "string" ||
    !roles.has(value.role as ArtistRole) ||
    typeof value.region !== "string" ||
    !regions.has(value.region as RegionCode) ||
    (typeof value.handle !== "string" &&
      typeof value.channelId !== "string") ||
    (value.agency !== undefined &&
      value.agency !== null &&
      typeof value.agency !== "string") ||
    (value.isSinging !== undefined && typeof value.isSinging !== "boolean") ||
    (value.note !== undefined && typeof value.note !== "string")
  ) {
    return false;
  }

  if (value.platformUrls === undefined) return true;
  if (!isRecord(value.platformUrls)) return false;

  return Object.entries(value.platformUrls).every(
    ([platform, identity]) =>
      platforms.has(platform as KnownPlatformId) &&
      isRecord(identity) &&
      typeof identity.url === "string",
  );
}

const catalog: unknown = JSON.parse(
  fs.readFileSync(seedCatalogPath, "utf8"),
);
if (!Array.isArray(catalog)) {
  throw new Error(`Invalid seed catalog: expected an array at ${seedCatalogPath}`);
}

const seeds: SeedEntry[] = [];
for (const entry of catalog) {
  if (!isSeedEntry(entry)) {
    throw new Error(`Invalid seed entry in ${seedCatalogPath}`);
  }
  seeds.push(entry);
}

export const ALL_SEEDS: SeedEntry[] = seeds;
