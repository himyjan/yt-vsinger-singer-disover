/**
 * Classification confidence.
 *
 * The classifier is deterministic but not infallible, and a record can be
 * right about one field and wrong about another: a channel's region may come
 * from an authoritative roster while its gender is a guess, and vice versa.
 *
 * A single number cannot express that, so confidence is stored **per axis**.
 * The `overall` figure is the weakest axis, because one wrong field makes
 * the whole record wrong.
 *
 * | Axis | What it measures |
 * | --- | --- |
 * | `kind` | virtual or real — the split the whole dataset is built on |
 * | `region` | where the performer belongs |
 * | `role` | what they do — `unknown` means the sources do not say |
 * | `gender` | self-described, or not stated |
 * | `ai` | whether the performer is AI-generated |
 *
 * The values are deliberately coarse — a number that looks precise is a
 * number nobody trusts. `1` means a source stated it, `0` means the source
 * is silent, and the values in between mean it was inferred.
 */

import type {
  Activity,
  Affiliation,
  ArtistKind,
  ArtistRole,
  Gender,
  RegionCode,
  RegionSource,
} from "./types";

export interface ClassificationConfidence {
  /** How sure the virtual/real decision is. */
  kind: number;
  /** How sure the region is. */
  region: number;
  /** How sure the role is. */
  role: number;
  /** How sure the gender is. */
  gender: number;
  /** How sure the AI flag is. */
  ai: number;
  /**
   * The weakest of the axes that carry meaning.
   *
   * `role` and `gender` are allowed to be unknown without dragging the
   * record down — a channel with no stated gender is still a perfectly good
   * record. `kind` and `region` are not: a record with the wrong region is
   * in the wrong place.
   */
  overall: number;
}

/** The confidence of each region source. */
const REGION_SOURCE_CONFIDENCE: Record<RegionSource, number> = {
  override: 1,
  roster: 1,
  declared: 1,
  platform: 0.9,
  agency: 0.9,
  country: 0.85,
  script: 0.6,
  unknown: 0.1,
};

/** The confidence of each affiliation source. */
const AFFILIATION_CONFIDENCE: Record<Affiliation, number> = {
  group: 1,
  independent: 0.9,
  community: 0.8,
  unknown: 0.3,
};

/** The confidence of each activity status. */
const ACTIVITY_CONFIDENCE: Record<Activity, number> = {
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
  /** True when the record came from a source that states the kind outright. */
  kindDeclared: boolean;
}

export function computeConfidence(input: ConfidenceInput): ClassificationConfidence {
  if (input.curated) {
    return { kind: 1, region: 1, role: 1, gender: 1, ai: 1, overall: 1 };
  }

  const kind = input.kindDeclared ? 1 : 0.6;
  const region = REGION_SOURCE_CONFIDENCE[input.regionSource] ?? 0.3;
  const role = input.role === "unknown" ? 0.3 : 0.85;
  const gender = input.gender === "unknown" ? 0.2 : 0.9;
  const ai = input.isAi ? 0.9 : 0.5;

  // The affiliation and the activity are recorded for reference but do not
  // decide the overall figure — they are secondary facets of a record.
  void AFFILIATION_CONFIDENCE[input.affiliation];
  void ACTIVITY_CONFIDENCE[input.activity];

  const overall = Math.min(kind, region);

  return { kind, region, role, gender, ai, overall };
}

/** A short, human-readable summary of a confidence record. */
export function describeConfidence(confidence: ClassificationConfidence): string {
  if (confidence.overall >= 0.99) return "curated";
  const weak: string[] = [];
  if (confidence.kind < 0.7) weak.push("kind");
  if (confidence.region < 0.7) weak.push("region");
  if (confidence.role < 0.5) weak.push("role");
  if (confidence.gender < 0.5) weak.push("gender");
  if (confidence.ai < 0.5) weak.push("ai");
  return weak.length ? `uncertain: ${weak.join(", ")}` : "confident";
}
