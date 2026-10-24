/**
 * Wikidata — authoritative verification.
 *
 * A computed confidence score is a guess. Wikidata is not: it is a curated
 * knowledge base where each claim carries a citation, and a match on the
 * YouTube channel id is a *fact* — either the record is the same performer or
 * it is not.
 *
 * The SPARQL endpoint answers everything in one query:
 *
 * | Property | Meaning |
 * | --- | --- |
 * | `P2397` | YouTube channel ID — the join key |
 * | `P463` | member of — **the agency** |
 * | `P21` | sex or gender |
 * | `P27` | country of citizenship — **the region** |
 * | `P571` | inception — **the debut date** |
 * | `P4047` | Twitch channel ID |
 * | `P2002` | Twitter / X handle |
 * | `P2003` | Instagram handle |
 * | `P856` | official website |
 *
 * And the Wikipedia extract is a real, sourced description of the performer.
 *
 * The endpoint is public and free. It asks for a descriptive `User-Agent`,
 * which this module sends.
 */

import type { Gender, RegionCode } from "./types";

const SPARQL = "https://query.wikidata.org/sparql";
const WIKIPEDIA_API = "https://en.wikipedia.org/w/api.php";

const USER_AGENT =
  "VSingerSingerTracker/1.0 (VTuber dataset verification; +https://github.com/)";

export interface WikidataIdentity {
  /** The Wikidata item id, e.g. `Q22128111`. */
  id: string;
  /** The English label. */
  label: string;
  /** The English description. */
  description: string | null;
  /** The YouTube channel id, when Wikidata has one. */
  youtubeChannelId: string | null;
  /** The agency the performer belongs to. */
  agency: string | null;
  /** The country of citizenship, as an English name. */
  country: string | null;
  /** The stated gender. */
  gender: Gender | null;
  /** The inception date, as `YYYY-MM-DD`. */
  inception: string | null;
  /** The external handles, keyed by platform. */
  externals: Record<string, string>;
  /** The Wikipedia extract — a real description of the performer. */
  descriptionText: string | null;
  /** The English Wikipedia article URL, when there is one. */
  article: string | null;
}

/** A match between a Wikidata item and a record in the dataset. */
export interface WikidataMatch {
  identity: WikidataIdentity;
  /**
   * How the match was made.
   *
   * `channel` — the YouTube channel id in Wikidata matches the record. That
   * is a certain match.
   * `name` — only the label matches, which is suggestive but not certain.
   */
  matchedBy: "channel" | "name";
}

/* -------------------------------------------------------------------------- */
/* SPARQL                                                                    */
/* -------------------------------------------------------------------------- */

interface SparqlBinding {
  item?: { value: string };
  itemLabel?: { value: string };
  itemDescription?: { value: string };
  agencyLabel?: { value: string };
  genderLabel?: { value: string };
  countryLabel?: { value: string };
  inception?: { value: string };
  youtube?: { value: string };
  twitch?: { value: string };
  twitter?: { value: string };
  instagram?: { value: string };
  website?: { value: string };
  article?: { value: string };
}

async function sparql(query: string): Promise<SparqlBinding[]> {
  try {
    const url = new URL(SPARQL);
    url.searchParams.set("query", query);
    url.searchParams.set("format", "json");
    const res = await fetch(url.toString(), {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/sparql-results+json",
      },
    });
    if (!res.ok) return [];
    const json = (await res.json()) as {
      results?: { bindings?: SparqlBinding[] };
    };
    return json.results?.bindings ?? [];
  } catch {
    return [];
  }
}

/** The optional properties every query selects. */
const SELECT_PROPERTIES = `
  OPTIONAL { ?item wdt:P463 ?agency }
  OPTIONAL { ?item wdt:P21 ?gender }
  OPTIONAL { ?item wdt:P27 ?country }
  OPTIONAL { ?item wdt:P571 ?inception }
  OPTIONAL { ?item wdt:P2397 ?youtube }
  OPTIONAL { ?item wdt:P4047 ?twitch }
  OPTIONAL { ?item wdt:P2002 ?twitter }
  OPTIONAL { ?item wdt:P2003 ?instagram }
  OPTIONAL { ?item wdt:P856 ?website }
  OPTIONAL { ?article schema:about ?item ; schema:isPartOf <https://en.wikipedia.org/> }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en,zh,ja". }
`;

/**
 * Looks a performer up by their YouTube channel id.
 *
 * This is the certain match: the id is the join key, so a hit *is* the same
 * performer.
 */
export async function lookupByChannelId(
  youtubeChannelId: string,
): Promise<WikidataMatch | null> {
  if (!youtubeChannelId) return null;

  const query = `
    SELECT ?item ?itemLabel ?itemDescription ?agency ?agencyLabel ?gender ?genderLabel
           ?country ?countryLabel ?inception ?youtube ?twitch ?twitter ?instagram
           ?website ?article
    WHERE {
      ?item wdt:P2397 "${youtubeChannelId.replace(/"/g, '\\"')}" .
      ${SELECT_PROPERTIES}
    }
    LIMIT 5
  `;

  const rows = await sparql(query);
  if (!rows.length) return null;

  const identity = toIdentity(rows[0]!);
  if (!identity) return null;
  return { identity, matchedBy: "channel" };
}

/**
 * Looks a performer up by name.
 *
 * A name match is only suggestive — two performers can share a name — so the
 * result is marked as such and the caller decides what to do with it.
 */
export async function lookupByName(
  name: string,
): Promise<WikidataMatch | null> {
  const cleaned = name.replace(/["\\]/g, " ").trim();
  if (!cleaned) return null;

  const query = `
    SELECT ?item ?itemLabel ?itemDescription ?agency ?agencyLabel ?gender ?genderLabel
           ?country ?countryLabel ?inception ?youtube ?twitch ?twitter ?instagram
           ?website ?article
    WHERE {
      ?item rdfs:label "${cleaned}"@en .
      ${SELECT_PROPERTIES}
    }
    LIMIT 5
  `;

  const rows = await sparql(query);
  if (!rows.length) return null;

  // Prefer a row that carries a YouTube channel id — that one is the
  // performer we are looking for.
  const withChannel = rows.find((r) => r.youtube?.value) ?? rows[0]!;
  const identity = toIdentity(withChannel);
  if (!identity) return null;

  return {
    identity,
    matchedBy: withChannel.youtube?.value ? "channel" : "name",
  };
}

/* -------------------------------------------------------------------------- */
/* Mapping                                                                    */
/* -------------------------------------------------------------------------- */

function toIdentity(row: SparqlBinding): WikidataIdentity | null {
  const id = row.item?.value?.split("/").pop();
  if (!id) return null;

  const externals: Record<string, string> = {};
  for (const [key, value] of [
    ["twitch", row.twitch?.value],
    ["x", row.twitter?.value],
    ["twitter", row.twitter?.value],
    ["instagram", row.instagram?.value],
    ["website", row.website?.value],
  ] as const) {
    if (value) externals[key] = value;
  }

  return {
    id,
    label: row.itemLabel?.value ?? id,
    description: row.itemDescription?.value ?? null,
    youtubeChannelId: row.youtube?.value ?? null,
    agency: row.agencyLabel?.value ?? null,
    country: row.countryLabel?.value ?? null,
    gender: genderFrom(row.genderLabel?.value ?? null),
    inception: toDate(row.inception?.value),
    externals,
    descriptionText: null,
    article: row.article?.value ?? null,
  };
}

/** Maps Wikidata's gender labels onto the project's. */
function genderFrom(value: string | null): Gender | null {
  if (!value) return null;
  const v = value.toLowerCase();
  if (v === "female") return "female";
  if (v === "male") return "male";
  return null;
}

/** Formats a SPARQL date value as `YYYY-MM-DD`. */
function toDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const m = /^([+-])(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!m) return null;
  // A negative year is BCE — not a debut date.
  if (m[1] === "-") return null;
  return `${m[2]}-${m[3]}-${m[4]}`;
}

/* -------------------------------------------------------------------------- */
/* Wikipedia — the REST API                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The Wikimedia REST API.
 *
 * `https://en.wikipedia.org/api/rest_v1/` is the modern, read-only API: one
 * request returns a clean summary, a short description, the infobox image and
 * the Wikidata item id — everything a verification needs.
 */
const REST = "https://en.wikipedia.org/api/rest_v1";

export interface WikipediaSummary {
  /** The article title. */
  title: string;
  /** The one-line description, e.g. "Australian VTuber and singer". */
  description: string | null;
  /** The lead paragraph. */
  extract: string | null;
  /** The Wikidata item id, when the article has one. */
  wikibaseItem: string | null;
  /** The infobox image — a good portrait for the channel avatar. */
  image: string | null;
  /** The canonical article URL. */
  url: string | null;
}

/**
 * The summary of a Wikipedia article.
 *
 * The `description` ("Australian VTuber and singer") and the `extract` are
 * written by humans and cited — which makes them a far better description
 * than anything a keyword heuristic can produce.
 */
export async function wikipediaSummary(
  article: string,
): Promise<WikipediaSummary | null> {
  // The SPARQL query returns the article URL; the API wants the title.
  const title = article.includes("/wiki/")
    ? decodeURIComponent(article.slice(article.lastIndexOf("/wiki/") + 6))
    : decodeURIComponent(article);
  if (!title) return null;

  try {
    const res = await fetch(
      `${REST}/page/summary/${encodeURIComponent(title.replace(/ /g, "_"))}`,
      {
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "application/json",
        },
      },
    );
    if (!res.ok) return null;
    const json = (await res.json()) as {
      title?: string;
      description?: string;
      extract?: string;
      wikibase_item?: string;
      originalimage?: { source?: string };
      thumbnail?: { source?: string };
      content_urls?: { desktop?: { page?: string } };
    };

    if (!json.title) return null;

    return {
      title: json.title,
      description: json.description ?? null,
      extract: json.extract ?? null,
      wikibaseItem: json.wikibase_item ?? null,
      // The original infobox image is much better than the small thumbnail.
      image: json.originalimage?.source ?? json.thumbnail?.source ?? null,
      url: json.content_urls?.desktop?.page ?? null,
    };
  } catch {
    return null;
  }
}

/**
 * Searches Wikipedia for a performer.
 *
 * Used when Wikidata has no item: the article's description and lead are
 * still a sourced description, and the summary's `wikibase_item` gives the
 * Wikidata id so the record can be linked to it.
 */
export async function wikipediaSearch(
  query: string,
  limit = 5,
): Promise<WikipediaSummary[]> {
  const cleaned = query.trim();
  if (!cleaned) return [];

  try {
    const url = new URL(`${REST}/search/page`);
    url.searchParams.set("q", cleaned);
    url.searchParams.set("limit", String(limit));
    const res = await fetch(url.toString(), {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    });
    if (!res.ok) return [];
    const json = (await res.json()) as {
      pages?: { key?: string; title?: string; description?: string }[];
    };

    const out: WikipediaSummary[] = [];
    for (const page of json.pages ?? []) {
      const title = page.key ?? page.title;
      if (!title) continue;
      const summary = await wikipediaSummary(title);
      if (summary) out.push(summary);
    }
    return out;
  } catch {
    return [];
  }
}

/** The URL of a Wikidata item, for the citation trail. */
export function wikidataUrl(id: string): string {
  return `https://www.wikidata.org/wiki/${id}`;
}

/** The URL of a Wikipedia article, for the citation trail. */
export function wikipediaUrl(title: string): string {
  return `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`;
}

/** The country names Wikidata reports, mapped to the project's regions. */
export const COUNTRY_TO_REGION: Record<string, RegionCode> = {
  japan: "jp",
  china: "cn",
  "people's republic of china": "cn",
  "republic of china": "tw",
  taiwan: "tw",
  "hong kong": "hk",
  "south korea": "kr",
  "korea": "kr",
  "united states": "en",
  "united kingdom": "en",
  indonesia: "id",
  malaysia: "my",
};

/* -------------------------------------------------------------------------- */
/* Name search — the cross-platform identities                               */
/* -------------------------------------------------------------------------- */

/** One Wikidata item, reduced to the identities the dataset can use. */
export interface WikidataLinkMatch {
  /** The item id, e.g. `Q22128111`. */
  id: string;
  /** The label in the performer's own language, when there is one. */
  label: string;
  /** Every label Wikidata holds in the languages that were asked for. */
  labels: string[];
  /** The one-line description, when Wikidata has one. */
  description: string | null;
  /** `P2397` — the YouTube channel id. */
  youtubeChannelId: string | null;
  /** `P4047` / `P2002` / `P2003` / `P856`, keyed by platform. */
  externals: Record<string, string>;
}

const ENTITY_LANGUAGES = ["ja", "zh", "en"] as const;

interface SearchEntity {
  id?: string;
  label?: string;
  description?: string;
}

/**
 * Searches Wikidata for a performer **by name**, in every language the
 * dataset is likely to know them by.
 *
 * `lookupByName()` above only matches an English label, which is the wrong
 * question for this catalogue: 「雫るる」 has no English label at all, and a
 * Chinese Bilibili performer is usually labelled in Chinese. The search API
 * asks for the item, and the entities API then answers with the identities —
 * the YouTube channel id, the Twitch login, the X handle.
 *
 * A name match is **suggestive, never certain** (two performers can share a
 * name), so the caller has to verify the answer before it writes it down.
 */
export async function searchByName(
  name: string,
  options: { languages?: readonly string[]; limit?: number } = {},
): Promise<WikidataLinkMatch[]> {
  const cleaned = name.replace(/["\\]/g, " ").trim();
  if (!cleaned || cleaned.length < 2) return [];
  const languages = options.languages ?? ENTITY_LANGUAGES;
  const limit = options.limit ?? 3;

  /** The item ids the search found, in the order the languages asked. */
  const ids: string[] = [];
  for (const language of languages) {
    try {
      const url = new URL("https://www.wikidata.org/w/api.php");
      url.searchParams.set("action", "wbsearchentities");
      url.searchParams.set("search", cleaned);
      url.searchParams.set("language", language);
      url.searchParams.set("uselang", language);
      url.searchParams.set("format", "json");
      url.searchParams.set("limit", String(limit));
      url.searchParams.set("origin", "*");
      const res = await fetch(url.toString(), {
        headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      });
      if (!res.ok) continue;
      const json = (await res.json()) as { search?: SearchEntity[] };
      for (const hit of json.search ?? []) {
        if (hit.id && !ids.includes(hit.id)) ids.push(hit.id);
      }
    } catch {
      /* an unreachable search is not a reason to fail the caller */
    }
    if (ids.length >= 10) break;
  }
  if (!ids.length) return [];

  try {
    const url = new URL("https://www.wikidata.org/w/api.php");
    url.searchParams.set("action", "wbgetentities");
    url.searchParams.set("ids", ids.slice(0, 10).join("|"));
    url.searchParams.set("props", "claims|labels|descriptions");
    url.searchParams.set("languages", ENTITY_LANGUAGES.join("|"));
    url.searchParams.set("format", "json");
    url.searchParams.set("redirects", "yes");
    const res = await fetch(url.toString(), {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    });
    if (!res.ok) return [];
    const json = (await res.json()) as {
      entities?: Record<string, WikidataEntity>;
    };
    const out: WikidataLinkMatch[] = [];
    for (const entity of Object.values(json.entities ?? {})) {
      const match = toLinkMatch(entity);
      if (match) out.push(match);
    }
    return out;
  } catch {
    return [];
  }
}

/** A Wikidata entity as the API returns it, reduced to what is read here. */
interface WikidataEntity {
  id?: string;
  labels?: Record<string, { value?: string }>;
  descriptions?: Record<string, { value?: string }>;
  claims?: Record<
    string,
    {
      mainsnak?: {
        datavalue?: { value?: unknown };
      };
    }[]
  >;
}

/** Reads the first string value of a claim, e.g. `P2397`. */
function claimString(entity: WikidataEntity, property: string): string | null {
  const value = entity.claims?.[property]?.[0]?.mainsnak?.datavalue?.value;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function toLinkMatch(entity: WikidataEntity): WikidataLinkMatch | null {
  const id = entity.id;
  if (!id) return null;

  const labels = ENTITY_LANGUAGES.map(
    (language) => entity.labels?.[language]?.value,
  ).filter((value): value is string => !!value?.trim());

  const description =
    entity.descriptions?.en?.value ??
    entity.descriptions?.ja?.value ??
    entity.descriptions?.zh?.value ??
    null;

  const externals: Record<string, string> = {};
  const twitch = claimString(entity, "P4047");
  const x = claimString(entity, "P2002");
  const instagram = claimString(entity, "P2003");
  const website = claimString(entity, "P856");
  if (twitch) externals.twitch = twitch;
  if (x) externals.twitter = x;
  if (instagram) externals.instagram = instagram;
  if (website) externals.website = website;

  const youtubeChannelId = claimString(entity, "P2397");

  // An item with no platform identity at all is not worth returning: the
  // caller is looking for a link, and there is none to give.
  if (!youtubeChannelId && !Object.keys(externals).length) return null;

  return {
    id,
    label: labels[0] ?? id,
    labels,
    description,
    youtubeChannelId,
    externals,
  };
}
