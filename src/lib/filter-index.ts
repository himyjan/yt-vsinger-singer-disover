/**
 * The channel filter's per-record index.
 *
 * `filterChannels()` used to do its work inside the predicate: build a
 * lowercase haystack from three fields, allocate `Object.keys(externals)`,
 * rebuild the language list and run `matchesPlatform()` twice — for **every**
 * record, on **every** keystroke. The catalogue is 72,698 channels, so a
 * one-letter query cost ~17 ms before the first match was even considered, and
 * the result was thrown away when the next letter arrived.
 *
 * Nothing in that work depends on the query. A record is immutable once it is
 * loaded, so the answer is computed once and kept beside it, in a `WeakMap`
 * keyed by the summary itself: no extra field on the record, no id table to
 * invalidate, and an entry is collected with the record it describes.
 *
 * The filter itself then reads scalars and `Set.has()` — no allocation per
 * record, no `toLowerCase()` per record — which is what turns the pass into a
 * walk over the array.
 *
 * The scope switch is still enforced here and only here (`kind`): every view
 * funnels through `filterChannels()` in `dataset.ts`, which delegates to this
 * module. Do not add a per-view `kind` check.
 */

import type { ChannelSummary } from "@shared/lib/types";
import { toLanguageList } from "@shared/lib/regions";

import { platformFilterKey } from "./links";

/** Everything the filter asks about a channel, computed once. */
export interface ChannelFacets {
  /** `name + handle + agency`, lowercased — the text filter's haystack. */
  text: string;
  /** Every platform key the channel carries, grouped as the filter groups them. */
  platforms: Set<string>;
  /** The channel's languages, as `toLanguageList()` reads them. */
  languages: Set<string>;
  /** Declared tags, trimmed and lowercased. */
  tags: Set<string>;
  /** The agency, trimmed and lowercased. */
  agency: string;
}

const facets = new WeakMap<ChannelSummary, ChannelFacets>();

/** The facets of one channel, computed on first use and then reused. */
export function facetsOf(channel: ChannelSummary): ChannelFacets {
  const cached = facets.get(channel);
  if (cached) return cached;

  const platforms = new Set<string>();
  for (const link of channel.links ?? []) platforms.add(platformFilterKey(link.p));
  for (const key of Object.keys(channel.externals ?? {})) {
    platforms.add(platformFilterKey(key));
  }

  const computed: ChannelFacets = {
    text: `${channel.name} ${channel.handle ?? ""} ${channel.agency ?? ""}`.toLowerCase(),
    platforms,
    languages: new Set(toLanguageList(channel.languages)),
    tags: new Set((channel.tags ?? []).map((value) => value.trim().toLowerCase())),
    agency: (channel.agency ?? "").trim().toLowerCase(),
  };
  facets.set(channel, computed);
  return computed;
}

/**
 * The channel half of `ItemQuery`.
 *
 * Declared structurally rather than imported so this module does not depend on
 * the loader — `dataset.ts` owns the query type and re-exports the function.
 */
export interface ChannelQuery {
  kind?: "virtual" | "real" | "both";
  region?: string | "all";
  platform?: string | "all";
  gender?: string | "all";
  ai?: "ai" | "human" | "all";
  affiliation?: string | "all";
  /** An exact agency, e.g. `Hololive EN`. */
  agency?: string;
  /** An exact declared tag. */
  tag?: string;
  language?: string | "all";
  singing?: "all" | "singing" | "not-singing";
  role?: string | "all";
  vtuberOnly?: "all" | "vtuber" | "vsinger";
  oac?: "all" | "oac";
  text?: string;
}

/**
 * Filters channel summaries.
 *
 * Checks are ordered cheapest-and-most-selective first: the scalar equality
 * tests, then the text needle (which usually rejects the whole catalogue),
 * then the `Set` lookups. The outcome is identical to the previous
 * per-record implementation — only the order and the per-record allocation
 * changed.
 */
export function filterChannelList(
  channels: ChannelSummary[],
  query: ChannelQuery,
): ChannelSummary[] {
  const kind = query.kind ?? "both";
  const region = query.region ?? "all";
  const platform = query.platform ?? "all";
  const gender = query.gender ?? "all";
  const ai = query.ai ?? "all";
  const affiliation = query.affiliation ?? "all";
  const agency = query.agency?.trim().toLowerCase() ?? "";
  const tag = query.tag?.trim().toLowerCase() ?? "";
  const language = query.language ?? "all";
  const singing = query.singing ?? "all";
  const role = query.role ?? "all";
  const vtuberOnly = query.vtuberOnly ?? "all";
  const oac = query.oac ?? "all";
  const text = query.text?.trim().toLowerCase() ?? "";

  /**
   * The filter's own platform key, resolved once.
   *
   * `matchesPlatform()` compares two `platformFilterKey()` results, so the
   * facet set can be tested directly — and the grouping of `web:<n>`, `x` and
   * the YouTube link kinds stays exactly where it is defined, in `links.ts`.
   */
  const platformKey = platform === "all" ? "" : platformFilterKey(platform);

  /**
   * Whether any filter reads the facets at all.
   *
   * The common case — open the tab, pick a region, switch the scope — uses
   * none of them, and a `WeakMap` lookup per record is not free: 72,698 of
   * them cost more than the scalar pass they are attached to. So the facets
   * are fetched only when a query needs one.
   */
  const needsFacets =
    text !== "" || agency !== "" || tag !== "" || language !== "all" || platformKey !== "";

  const out: ChannelSummary[] = [];
  for (const channel of channels) {
    if (kind !== "both" && channel.kind !== kind) continue;
    if (region !== "all" && channel.region !== region) continue;
    if (gender !== "all" && channel.gender !== gender) continue;
    if (ai === "ai" && !channel.isAi) continue;
    if (ai === "human" && channel.isAi) continue;
    if (affiliation !== "all" && channel.affiliation !== affiliation) continue;
    if (singing === "singing" && !channel.isSinging) continue;
    if (singing === "not-singing" && channel.isSinging) continue;
    if (role === "producer") {
      if (channel.role !== "producer" && channel.role !== "composer") continue;
    } else if (role !== "all" && channel.role !== role) continue;
    /**
     * The two halves the dataset is about. A VSinger is `role = vsinger`
     * **or** published singing: the subscription groups set the flag, and the
     * classifier can read a singer's role as `vtuber` when the description
     * never says 歌勢.
     */
    if (vtuberOnly === "vsinger" && !(channel.role === "vsinger" || channel.isSinging)) {
      continue;
    }
    if (
      vtuberOnly === "vtuber" &&
      (channel.kind !== "virtual" ||
        channel.role === "vsinger" ||
        channel.isSinging)
    ) {
      continue;
    }
    if (oac === "oac" && !channel.isOfficialArtist) continue;

    if (needsFacets) {
      const facet = facetsOf(channel);
      if (text && !facet.text.includes(text)) continue;
      if (agency && facet.agency !== agency) continue;
      if (tag && !facet.tags.has(tag)) continue;
      if (language !== "all" && !facet.languages.has(language)) continue;
      if (platformKey && !facet.platforms.has(platformKey)) continue;
    }

    out.push(channel);
  }
  return out;
}
