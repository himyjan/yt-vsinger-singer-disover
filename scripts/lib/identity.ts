/**
 * Identity registry and de-duplication.
 *
 * The same performer is described by many different sources, each using a
 * different identifier:
 *
 *   - YouTube      `UCxxxxxxxxxxxxx`
 *   - a handle     `@samekosaba`
 *   - a wiki page  `Sameko Saba`
 *   - an X handle  `@samekosaba`
 *   - a display name in Japanese (`さば`), English (`Sameko Saba`) or
 *     Chinese (`萨巴`)
 *
 * A naive "insert everything we find" approach produces duplicates the moment
 * two sources overlap. This module keeps a persistent registry of *identity
 * keys* and merges records that share a key.
 *
 * ## Key strength
 *
 * - **Strong keys** identify a performer on their own: a YouTube channel id,
 *   a handle, an X handle, a wiki page title.
 * - **Weak keys** are display names, which are ambiguous (two performers can
 *   share a name) and are spelled differently across sources. Weak-key
 *   matches are only merged when the edit distance is small *and* the records
 *   agree on region or share another strong key.
 */

import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, ensureDir, readJson, writeJson } from "./io";
import type { RegionCode } from "./types";

export const IDENTITY_SCHEMA_VERSION = 1;

export interface IdentityRecord {
  /** Canonical id. YouTube channel id when known, else `<platform>:<id>`. */
  id: string;
  /** Every display name this performer is known by. */
  names: string[];
  /** Every handle (without `@`), lower-cased. */
  handles: string[];
  /** Platform-specific handles, keyed by platform. */
  externals: Record<string, string[]>;
  /** Wiki page titles this performer has. */
  wikiPages: string[];
  /** Region, when known. */
  region: RegionCode | null;
  /** Agency / affiliation. */
  affiliation: string | null;
  /** ISO date of debut. */
  debutDate: string | null;
  /** ISO date of graduation / retirement. */
  graduateDate: string | null;
  /** Which sources contributed this record. */
  sources: string[];
  /** ISO timestamp of first sighting. */
  firstSeen: string;
  /** ISO timestamp of the last update. */
  updatedAt: string;
  /** 0..1 — how confident we are that this is a single performer. */
  confidence: number;
}

export interface IdentityFile {
  schemaVersion: number;
  updatedAt: string;
  records: IdentityRecord[];
}

export const identityPath = path.join(DATA_DIR, "identities.json");

/* -------------------------------------------------------------------------- */
/* Normalisation                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Normalises a display name for comparison.
 *
 * Removes decoration that differs between sources: whitespace, punctuation,
 * emoji, "Ch."/"Channel"/"公式" suffixes and common honorifics. The result is
 * used for the weak name key and for fuzzy matching.
 */
export function normalizeName(name: string): string {
  return name
    .normalize("NFKC")
    .toLowerCase()
    // Strip emoji and variation selectors.
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}]/gu, "")
    .replace(/[「」『』【】（）()\[\]{}<>《》"'`~!@#$%^&*_+=|;:,.<>?/\\-]/g, "")
    // Strip common channel decorations.
    .replace(/\b(ch|ch\.|channel|official|tv|vtubers?|live|streaming)\b/g, "")
    .replace(/(公式|まもなく|チャンネル)/g, "")
    .replace(/\s+/g, "")
    .trim();
}

/** Normalises a handle for comparison. */
export function normalizeHandle(handle: string): string {
  return handle
    .normalize("NFKC")
    .toLowerCase()
    .replace(/^@+/, "")
    .replace(/[^a-z0-9_\-.]/g, "")
    .trim();
}

/**
 * Bounded Levenshtein distance. Returns `max + 1` as soon as the distance is
 * known to exceed `max`, so large strings stay cheap to compare.
 */
export function editDistance(a: string, b: string, max = 2): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;

  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const value = Math.min(
        previous[j]! + 1,
        current[j - 1]! + 1,
        previous[j - 1]! + cost,
      );
      current.push(value);
      if (value < rowMin) rowMin = value;
    }
    if (rowMin > max) return max + 1;
    previous = current;
  }
  return previous[b.length]!;
}

/* -------------------------------------------------------------------------- */
/* Registry                                                                   */
/* -------------------------------------------------------------------------- */

export interface Candidate {
  /** Canonical id, when the source provides one. */
  id?: string;
  name?: string | null;
  handle?: string | null;
  region?: RegionCode | null;
  affiliation?: string | null;
  debutDate?: string | null;
  graduateDate?: string | null;
  /** Platform handles: `{ x: ["@handle"], bilibili: [...] }`. */
  externals?: Record<string, string[]>;
  /** Wiki page title. */
  wikiPage?: string | null;
  /** Which source produced this candidate. */
  source: string;
}

export type MergeOutcome =
  | { kind: "new"; record: IdentityRecord }
  | { kind: "updated"; record: IdentityRecord }
  | { kind: "merged"; record: IdentityRecord; mergedFrom: string[] };

export class IdentityRegistry {
  private records: IdentityRecord[] = [];
  /** Strong key → record index. */
  private strongIndex = new Map<string, number>();
  /** Normalised name → record indices. */
  private nameIndex = new Map<string, number[]>();

  constructor(file: IdentityFile | null = null) {
    if (file) this.load(file);
  }

  static loadFromDisk(filePath = identityPath): IdentityRegistry {
    const file = readJson<IdentityFile | null>(filePath, null);
    return new IdentityRegistry(file);
  }

  load(file: IdentityFile): void {
    this.records = file.records ?? [];
    this.reindex();
  }

  save(filePath = identityPath): void {
    ensureDir(path.dirname(filePath));
    writeJson(filePath, {
      schemaVersion: IDENTITY_SCHEMA_VERSION,
      updatedAt: new Date().toISOString(),
      records: this.records,
    } satisfies IdentityFile);
  }

  get all(): IdentityRecord[] {
    return this.records;
  }

  get size(): number {
    return this.records.length;
  }

  /* ---------------------------------------------------------------------- */
  /* Indexing                                                                 */
  /* ---------------------------------------------------------------------- */

  private reindex(): void {
    this.strongIndex.clear();
    this.nameIndex.clear();
    this.records.forEach((record, index) => {
      for (const key of strongKeysOf(record)) {
        if (!this.strongIndex.has(key)) this.strongIndex.set(key, index);
      }
      for (const name of record.names) {
        const key = normalizeName(name);
        if (!key) continue;
        const list = this.nameIndex.get(key) ?? [];
        list.push(index);
        this.nameIndex.set(key, list);
      }
    });
  }

  private indexRecord(record: IdentityRecord, index: number): void {
    for (const key of strongKeysOf(record)) {
      if (!this.strongIndex.has(key)) this.strongIndex.set(key, index);
    }
    for (const name of record.names) {
      const key = normalizeName(name);
      if (!key) continue;
      const list = this.nameIndex.get(key) ?? [];
      if (!list.includes(index)) list.push(index);
      this.nameIndex.set(key, list);
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Lookup                                                                   */
  /* ---------------------------------------------------------------------- */

  /** Finds a record by any strong key. */
  findByKey(key: string): IdentityRecord | undefined {
    const index = this.strongIndex.get(key);
    return index === undefined ? undefined : this.records[index];
  }

  /**
   * Finds records whose display name is a near-match.
   * Only names of comparable length are considered, which keeps the scan
   * cheap and avoids absurd matches.
   */
  findByName(name: string, region?: RegionCode | null): IdentityRecord[] {
    const key = normalizeName(name);
    if (!key) return [];

    const exact = this.nameIndex.get(key) ?? [];
    const out: IdentityRecord[] = [];
    for (const index of exact) {
      const record = this.records[index]!;
      if (region && record.region && record.region !== region) continue;
      out.push(record);
    }
    if (out.length) return out;

    // Fuzzy pass: only for short names, where the edit distance is meaningful.
    if (key.length < 12) {
      for (const [candidate, indices] of this.nameIndex) {
        if (Math.abs(candidate.length - key.length) > 2) continue;
        if (editDistance(candidate, key, 2) > 2) continue;
        for (const index of indices) {
          const record = this.records[index]!;
          if (region && record.region && record.region !== region) continue;
          out.push(record);
        }
      }
    }
    return out;
  }

  /* ---------------------------------------------------------------------- */
  /* Upsert                                                                   */
  /* ---------------------------------------------------------------------- */

  /**
   * Inserts a candidate, merging it with an existing record when the two
   * describe the same performer.
   */
  upsert(candidate: Candidate): MergeOutcome {
    const now = new Date().toISOString();
    const keys = strongKeysOfCandidate(candidate);

    // 1. Strong-key match.
    const matchedIndexes = new Set<number>();
    for (const key of keys) {
      const index = this.strongIndex.get(key);
      if (index !== undefined) matchedIndexes.add(index);
    }

    // 2. Weak name match, only when there is no strong match yet.
    if (matchedIndexes.size === 0 && candidate.name) {
      const nameMatches = this.findByName(candidate.name, candidate.region);
      for (const match of nameMatches) {
        const index = this.records.indexOf(match);
        if (index >= 0) matchedIndexes.add(index);
      }
    }

    if (matchedIndexes.size === 0) {
      const record = createRecord(candidate, now);
      this.records.push(record);
      this.indexRecord(record, this.records.length - 1);
      return { kind: "new", record };
    }

    // 3. Merge every matched record into the first one.
    const indexes = [...matchedIndexes].sort((a, b) => a - b);
    const primary = this.records[indexes[0]!]!;
    const mergedFrom: string[] = [];

    for (const index of indexes.slice(1)) {
      const other = this.records[index]!;
      mergeInto(primary, other);
      mergedFrom.push(other.id);
    }

    applyCandidate(primary, candidate, now);
    this.reindex();
    return {
      kind: mergedFrom.length ? "merged" : "updated",
      record: primary,
      mergedFrom,
    };
  }
}

/* -------------------------------------------------------------------------- */
/* Key helpers                                                                */
/* -------------------------------------------------------------------------- */

function strongKeysOf(record: IdentityRecord): string[] {
  const keys: string[] = [];
  if (record.id && !record.id.includes(":")) keys.push(`yt:${record.id}`);
  for (const handle of record.handles) {
    const h = normalizeHandle(handle);
    if (h) keys.push(`handle:${h}`);
  }
  for (const [platform, handles] of Object.entries(record.externals)) {
    for (const handle of handles) {
      const h = normalizeHandle(handle);
      if (h) keys.push(`${platform}:${h}`);
    }
  }
  for (const page of record.wikiPages) {
    const p = normalizeName(page);
    if (p) keys.push(`wiki:${p}`);
  }
  return keys;
}

function strongKeysOfCandidate(candidate: Candidate): string[] {
  const keys: string[] = [];
  if (candidate.id && !candidate.id.includes(":")) keys.push(`yt:${candidate.id}`);
  if (candidate.handle) {
    const h = normalizeHandle(candidate.handle);
    if (h) keys.push(`handle:${h}`);
  }
  for (const [platform, handles] of Object.entries(candidate.externals ?? {})) {
    for (const handle of handles) {
      const h = normalizeHandle(handle);
      if (h) keys.push(`${platform}:${h}`);
    }
  }
  if (candidate.wikiPage) {
    const p = normalizeName(candidate.wikiPage);
    if (p) keys.push(`wiki:${p}`);
  }
  return keys;
}

/* -------------------------------------------------------------------------- */
/* Record construction                                                        */
/* -------------------------------------------------------------------------- */

function createRecord(candidate: Candidate, now: string): IdentityRecord {
  const record: IdentityRecord = {
    id: candidate.id ?? `unknown:${now}-${Math.random().toString(36).slice(2, 8)}`,
    names: [],
    handles: [],
    externals: {},
    wikiPages: [],
    region: candidate.region ?? null,
    affiliation: candidate.affiliation ?? null,
    debutDate: candidate.debutDate ?? null,
    graduateDate: candidate.graduateDate ?? null,
    sources: [],
    firstSeen: now,
    updatedAt: now,
    confidence: 0.6,
  };
  applyCandidate(record, candidate, now);
  return record;
}

function applyCandidate(
  record: IdentityRecord,
  candidate: Candidate,
  now: string,
): void {
  if (candidate.name && !record.names.includes(candidate.name)) {
    record.names.push(candidate.name);
  }
  if (candidate.handle) {
    const h = normalizeHandle(candidate.handle);
    if (h && !record.handles.includes(h)) record.handles.push(h);
  }
  for (const [platform, handles] of Object.entries(candidate.externals ?? {})) {
    const list = record.externals[platform] ?? [];
    for (const handle of handles) {
      const h = normalizeHandle(handle);
      if (h && !list.includes(h)) list.push(h);
    }
    record.externals[platform] = list;
  }
  if (candidate.wikiPage && !record.wikiPages.includes(candidate.wikiPage)) {
    record.wikiPages.push(candidate.wikiPage);
  }
  if (candidate.region && !record.region) record.region = candidate.region;
  if (candidate.affiliation && !record.affiliation) {
    record.affiliation = candidate.affiliation;
  }
  if (candidate.debutDate && !record.debutDate) record.debutDate = candidate.debutDate;
  if (candidate.graduateDate && !record.graduateDate) {
    record.graduateDate = candidate.graduateDate;
  }
  if (!record.sources.includes(candidate.source)) {
    record.sources.push(candidate.source);
  }
  record.updatedAt = now;
  // More corroborating sources ⇒ higher confidence.
  record.confidence = Math.min(
    1,
    0.5 + record.sources.length * 0.12 + (record.handles.length ? 0.15 : 0),
  );
}

/** Merges `other` into `target`, unioning every multi-valued field. */
function mergeInto(target: IdentityRecord, other: IdentityRecord): void {
  for (const name of other.names) {
    if (!target.names.includes(name)) target.names.push(name);
  }
  for (const handle of other.handles) {
    if (!target.handles.includes(handle)) target.handles.push(handle);
  }
  for (const [platform, handles] of Object.entries(other.externals)) {
    const list = target.externals[platform] ?? [];
    for (const handle of handles) {
      if (!list.includes(handle)) list.push(handle);
    }
    target.externals[platform] = list;
  }
  for (const page of other.wikiPages) {
    if (!target.wikiPages.includes(page)) target.wikiPages.push(page);
  }
  for (const source of other.sources) {
    if (!target.sources.includes(source)) target.sources.push(source);
  }
  target.region ??= other.region;
  target.affiliation ??= other.affiliation;
  target.debutDate ??= other.debutDate;
  target.graduateDate ??= other.graduateDate;
  if (other.firstSeen < target.firstSeen) target.firstSeen = other.firstSeen;
  target.confidence = Math.max(target.confidence, other.confidence);
}
