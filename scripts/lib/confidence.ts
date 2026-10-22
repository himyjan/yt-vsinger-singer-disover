/**
 * Classification confidence.
 *
 * A confidence score says how much **evidence the classifier had** — it is
 * an estimate, not a measurement. It is useful for one thing: ordering the
 * verification queue, because the record that is least supported is the one
 * worth looking up.
 *
 * It is deliberately **not** written into the published dataset. A computed
 * number in the data reads as a fact, and a fact is what `verification` is
 * for: what was looked up, by what, and what was found.
 *
 * The per-axis shape is in `scripts/lib/types.ts` (`ClassificationConfidence`).
 */

import type {
  Activity,
  Affiliation,
  ArtistKind,
  ArtistRole,
  ClassificationConfidence,
  Gender,
  RegionCode,
  RegionSource,
} from "./types";

/** How much each region source is worth. */
export const REGION_SOURCE_CONFIDENCE: Record<RegionSource, number> = {
  override: 1,
  roster: 1,
  declared: 1,
  platform: 0.9,
  agency: 0.9,
  country: 0.85,
  script: 0.6,
  unknown: 0.1,
};

/** How much each affiliation source is worth. */
export const AFFILIATION_CONFIDENCE: Record<Affiliation, number> = {
  group: 1,
  independent: 0.9,
  community: 0.8,
  unknown: 0.3,
};

/** How much each activity status is worth. */
export const ACTIVITY_CONFIDENCE: Record<Activity, number> = {
  active: 0.9,
  preparing: 0.9,
  graduated: 0.9,
  unknown: 0.3,
};

export interface ConfidenceInput {
  kind: ArtistKind;
  role: ArtistRole;
  region: RegionCode;
  regionSource: RegionSource;
  gender: Gender;
  isAi: boolean;
  affiliation: Affiliation;
  activity: Activity;
  /** True when a human curated the record. */
  curated: boolean;
  /** True when the source states the kind outright. */
  kindDeclared: boolean;
  /** The number of marker hits that decided the kind. */
  kindHits: number;
}

/**
 * Computes the confidence of each axis.
 *
 * The region and the kind drive the overall figure, because a record with the
 * wrong region is in the wrong place and a record with the wrong kind is in
 * the wrong dataset. The role, the gender and the AI flag are recorded but do
 * not: an unstated gender does not make a record useless.
 */
export function computeConfidence(
  input: ConfidenceInput,
): ClassificationConfidence {
  if (input.curated) {
    return { kind: 1, region: 1, role: 1, gender: 1, ai: 1, overall: 1 };
  }

  const kind = input.kindDeclared
    ? 1
    : input.kindHits >= 3
      ? 0.9
      : input.kindHits > 0
        ? 0.6
        : 0.3;

  const confidence: ClassificationConfidence = {
    kind,
    region: REGION_SOURCE_CONFIDENCE[input.regionSource] ?? 0.3,
    role: input.role === "unknown" ? 0.3 : 0.85,
    gender: input.gender === "unknown" ? 0.2 : 0.9,
    ai: input.isAi ? 0.9 : 0.5,
    overall: 0,
  };

  confidence.overall = Math.min(confidence.kind, confidence.region);
  return confidence;
}

/**
 * Merges two confidence records.
 *
 * The stronger value wins per axis, so a curated field is never downgraded
 * by an inferred one.
 */
export function mergeConfidence(
  a: ClassificationConfidence | undefined | null,
  b: ClassificationConfidence | undefined | null,
): ClassificationConfidence {
  const left = a ?? { kind: 0, region: 0, role: 0, gender: 0, ai: 0, overall: 0 };
  const right = b ?? { kind: 0, region: 0, role: 0, gender: 0, ai: 0, overall: 0 };
  const merged: ClassificationConfidence = {
    kind: Math.max(left.kind, right.kind),
    region: Math.max(left.region, right.region),
    role: Math.max(left.role, right.role),
    gender: Math.max(left.gender, right.gender),
    ai: Math.max(left.ai, right.ai),
    overall: 0,
  };
  merged.overall = Math.min(merged.kind, merged.region);
  return merged;
}

/**
 * A short, human-readable summary of a confidence record.
 *
 * The weakest axis is what matters — a record with the wrong region is in the
 * wrong place — so the summary names the uncertain fields.
 */
export function describeConfidence(
  confidence: ClassificationConfidence,
): string {
  if (confidence.overall >= 0.99) return "curated";
  const weak: string[] = [];
  if (confidence.kind < 0.7) weak.push("kind");
  if (confidence.region < 0.7) weak.push("region");
  if (confidence.role < 0.5) weak.push("role");
  if (confidence.gender < 0.5) weak.push("gender");
  if (confidence.ai < 0.5) weak.push("ai");
  return weak.length ? `uncertain: ${weak.join(", ")}` : "confident";
}
