/**
 * Search engine shared by the index builder (Node) and the web app (browser).
 *
 * Keeping the tokenizer in one file guarantees that what the builder indexes
 * and what the browser queries are tokenised identically.
 *
 * ## Why an inverted index
 *
 * A linear scan over every entry costs O(n) per keystroke. With ~60k entries
 * and CJK text, that is visibly slow on mobile. Instead the dataset ships an
 * inverted index: a sorted token list plus, for each token, the list of entry
 * indices that contain it. A query becomes a handful of binary searches plus
 * an intersection of posting lists — microseconds.
 *
 * ## Why bigrams
 *
 * Japanese and Chinese do not delimit words with spaces, so whitespace
 * tokenisation would index an entire title as one giant token. Splitting CJK
 * runs into overlapping bigrams ("歌い手" → "歌い", "い手") makes substring
 * queries work without a dictionary segmenter.
 */

/* -------------------------------------------------------------------------- */
/* Tokenisation                                                                */
/* -------------------------------------------------------------------------- */

const CJK_RE =
  /[\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uAC00-\uD7AF\uFF66-\uFF9F]/;

/** Latin/digit runs. */
const WORD_RE = /[a-z0-9][a-z0-9'&._-]*/g;

/** Minimum token length kept in the index (shorter ones match too much). */
const MIN_TOKEN_LENGTH = 2;

/**
 * Splits text into index tokens.
 *
 * - Latin/digit runs become one token each.
 * - CJK runs become overlapping bigrams (and single characters for 1-char runs).
 * - Everything is NFKC-normalised and lower-cased first, so full-width and
 *   half-width forms collapse together.
 */
export function tokenize(text: string | null | undefined): string[] {
  if (!text) return [];
  const normalized = text.normalize("NFKC").toLowerCase();
  const tokens: string[] = [];

  // Latin / numeric words.
  for (const m of normalized.matchAll(WORD_RE)) {
    const w = m[0].replace(/[._-]+$/, "");
    if (w.length >= MIN_TOKEN_LENGTH) tokens.push(w);
  }

  // CJK runs → bigrams.
  let run = "";
  const flush = () => {
    if (!run) return;
    if (run.length === 1) {
      tokens.push(run);
    } else {
      for (let i = 0; i < run.length - 1; i++) tokens.push(run.slice(i, i + 2));
    }
    run = "";
  };
  for (const ch of normalized) {
    if (CJK_RE.test(ch)) run += ch;
    else flush();
  }
  flush();

  return tokens;
}

/** True when the string contains CJK characters. */
export function hasCjk(text: string | null | undefined): boolean {
  return !!text && CJK_RE.test(text);
}

/**
 * Normalises a user query into the token list used for lookup.
 *
 * Latin words are kept whole; CJK runs become bigrams too, so "歌い手" and
 * "歌" both work.
 */
export function queryTokens(query: string): string[] {
  return tokenize(query);
}

/* -------------------------------------------------------------------------- */
/* Search pack format                                                         */
/* -------------------------------------------------------------------------- */

/**
 * One region pack. Sharded by region so the browser only downloads the
 * regions the user is actually looking at.
 */
export interface SearchPack {
  schemaVersion: number;
  generatedAt: string;
  region: string;
  /** Number of entries in this pack. */
  count: number;
  /** Sorted, unique token list. Parallel to `postings`. */
  tokens: string[];
  /**
   * For each token, the (ascending) indices of the entries containing it.
   * Parallel to `tokens`.
   */
  postings: number[][];
  /** Inverse document frequency per token, parallel to `tokens`. */
  idf: number[];
  /** The entries themselves, in the order the postings refer to. */
  entries: SearchEntryRecord[];
}

/**
 * A compact, display-ready record. Kept deliberately small — every byte here
 * is downloaded by the browser.
 */
export interface SearchEntryRecord {
  /** `c` = channel, `i` = item. */
  k: "c" | "i";
  /** YouTube channel / video / playlist id. */
  id: string;
  /** Display title. */
  n: string;
  /** Artist kind. */
  g: "virtual" | "real";
  /** Region code. */
  r: string;
  /** Item category (items only). */
  c?: string;
  /** Epoch ms of the relevant timestamp. */
  ts: number;
  /** Owning channel id. */
  ch?: string;
  /** Channel name (items only). */
  cn?: string;
  /** Thumbnail URL — may be absent, in which case the UI shows initials. */
  th?: string | null;
  /** Song title for covers / MVs. */
  s?: string | null;
  /** Original artist for covers. */
  o?: string | null;
  /** Subscriber count (channels only). */
  sb?: number | null;
  /** Live status for items: `live` | `upcoming` | `past`. */
  st?: string;
  /** Duration in seconds. */
  d?: number | null;
  /** 1 when the item is "singing while playing an instrument". */
  ac?: 0 | 1;
  /** Gender of the performing channel. */
  gd?: string;
  /** 1 when the performer is AI-generated. */
  ai?: 0 | 1;
  /** Combined variant label, e.g. `female_vtuber`. */
  vr?: string;
}

/* -------------------------------------------------------------------------- */
/* Query engine (browser side)                                                */
/* -------------------------------------------------------------------------- */

/**
 * Finds the range of tokens in the sorted `tokens` array that start with
 * `prefix`. Uses binary search — O(log n), no allocation of the full token set.
 */
export function prefixRange(
  tokens: string[],
  prefix: string,
): { start: number; end: number } {
  let lo = 0;
  let hi = tokens.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (tokens[mid] < prefix) lo = mid + 1;
    else hi = mid;
  }
  const start = lo;
  hi = tokens.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (tokens[mid]!.startsWith(prefix)) lo = mid + 1;
    else hi = mid;
  }
  return { start, end: lo };
}

export interface SearchOptions {
  /** Maximum number of results to return. */
  limit?: number;
  /** Artist kind filter. */
  kind?: "virtual" | "real" | "both";
  /** Region filter. */
  region?: string | "all";
  /** Only return entries whose category is in this list. */
  categories?: string[];
  /** Only return entries with this live status. */
  status?: string[];
  /** Minimum relevance score required. */
  minScore?: number;
}

export interface SearchHit {
  entry: SearchEntryRecord;
  score: number;
}

/**
 * Runs a query against one or more region packs.
 *
 * Scoring: each matched query token contributes its IDF (rare tokens count
 * more), and the entry must match at least one token. Ties break on recency.
 */
export function searchPacks(
  packs: SearchPack[],
  query: string,
  options: SearchOptions = {},
): SearchHit[] {
  const limit = options.limit ?? 100;
  const kind = options.kind ?? "both";
  const region = options.region ?? "all";
  const qTokens = queryTokens(query);
  if (!qTokens.length) return [];

  /** entryKey → accumulated score. */
  const scores = new Map<string, number>();
  /** entryKey → entry record (across packs). */
  const records = new Map<string, SearchEntryRecord>();

  for (const pack of packs) {
    if (region !== "all" && pack.region !== region) continue;

    // For every query token, find all tokens with that prefix.
    for (const qt of qTokens) {
      const { start, end } = prefixRange(pack.tokens, qt);
      if (start >= end) continue;

      // Best matching token in the prefix range carries the highest IDF.
      let bestIdf = 0;
      const union = new Set<number>();
      for (let t = start; t < end; t++) {
        const idf = pack.idf[t] ?? 0;
        if (idf > bestIdf) bestIdf = idf;
        for (const idx of pack.postings[t] ?? []) union.add(idx);
      }
      if (!union.size || bestIdf <= 0) continue;

      for (const idx of union) {
        const entry = pack.entries[idx];
        if (!entry) continue;
        if (kind !== "both" && entry.g !== kind) continue;
        if (options.categories?.length && entry.c && !options.categories.includes(entry.c)) {
          continue;
        }
        if (options.status?.length && entry.st && !options.status.includes(entry.st)) {
          continue;
        }
        const key = `${entry.k}:${entry.id}`;
        const prev = scores.get(key) ?? 0;
        // Diminish repeated postings of the same entry for one token.
        scores.set(key, prev + bestIdf);
        records.set(key, entry);
      }
    }
  }

  const minScore = options.minScore ?? 0;
  const hits: SearchHit[] = [];
  for (const [key, score] of scores) {
    if (score <= minScore) continue;
    const entry = records.get(key)!;
    hits.push({ entry, score });
  }

  hits.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return b.entry.ts - a.entry.ts;
  });

  return hits.slice(0, limit);
}
