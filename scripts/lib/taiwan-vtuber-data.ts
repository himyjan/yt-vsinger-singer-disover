/**
 * Taiwan VTuber Tracking Data — authoritative region and lifecycle metadata.
 *
 * Source: https://taiwanvtuberdata.github.io/
 * API:    https://api-taiwanvtuberdata.nh60211.workers.dev/api/v2/
 *
 * The project publishes a curated roster of several thousand Chinese-language
 * VTubers with:
 *
 *   - the YouTube channel id,
 *   - the subscriber count, using the same `{tag:"has"|"hidden"|"no"}` union
 *     this project adopted,
 *   - the Twitch id,
 *   - the nationality (TW / HK / MY),
 *   - the debut date and the activity status (active / graduate / preparing).
 *
 * This is **authoritative region data** for a large slice of the Chinese
 * VTuber scene — exactly the axis that keyword heuristics get wrong, because
 * 「煜翔」 and 「皮卡族」 are Chinese names written in characters shared with
 * Japanese.
 *
 * The API is free, public and needs no key.
 */

import type { Activity, CountRef, RegionCode } from "./types";

const API = "https://api-taiwanvtuberdata.nh60211.workers.dev/api/v2";

/** The nationalities the API publishes, mapped to our region codes. */
const REGION_BY_NATIONALITY: Record<string, RegionCode> = {
  TW: "tw",
  HK: "hk",
  MY: "my",
  MO: "tw",
};

export interface TrackedVTuber {
  /** The YouTube channel id. */
  youtubeId: string;
  /** Display name. */
  name: string;
  /** Alternative names — the track list records aliases the JSON API drops. */
  aliases: string[];
  /** Region. */
  region: RegionCode;
  /** `active` | `preparing` | `graduated` | `unknown`. */
  activity: Activity;
  /** ISO date of debut. */
  debutDate: string | null;
  /** ISO date of graduation / retirement. */
  graduateDate: string | null;
  /** Subscriber count, with the hidden/unknown distinction. */
  subscribers: CountRef;
  /** Twitch numeric user id. */
  twitchId: string | null;
  /**
   * The Twitch **login** — the name in the URL.
   *
   * The track list stores the numeric id in one column and the login in
   * another. The **id** is the stable identifier and the only one that is
   * needed: Twitch's own API resolves an id to the current login, which
   * matters because channels get renamed — 樞木黎月 is `kururugi_reitsuki` on
   * Twitch, but the list still says `kururugiliyue_0413`.
   *
   * So this is a **fallback**, used only when the API cannot be reached.
   */
  twitchLogin: string | null;
  /** Profile image. */
  avatar: string | null;
  /** Agency / group. */
  group: string | null;
  /**
   * True when the track list lists the performer with **no** group.
   *
   * The track list has a `Group Name` column, and a performer who is a solo
   * act simply has it empty. That is a positive statement — "no group" —
   * not an absence of information, so it is recorded separately from
   * `group === null`.
   */
  isIndependent: boolean;
}

interface ApiVTuber {
  id?: string;
  name?: string;
  nationality?: string | null;
  activity?: string | null;
  debutDate?: string | null;
  graduateDate?: string | null;
  imgUrl?: string | null;
  group?: string | null;
  YouTube?: {
    id?: string | null;
    subscriber?: { tag?: string; count?: number };
  };
  Twitch?: { id?: string | null };
}

/** Converts the API's activity string to our enum. */
function toActivity(value: string | null | undefined): Activity {
  switch ((value ?? "").toLowerCase()) {
    case "active":
      return "active";
    case "preparing":
      return "preparing";
    case "graduate":
    case "graduated":
      return "graduated";
    default:
      return "unknown";
  }
}

/** Converts the API's subscriber union to ours — the shapes are identical. */
function toCountRef(
  subscriber: { tag?: string; count?: number } | undefined,
): CountRef {
  if (!subscriber) return { tag: "hidden" };
  if (subscriber.tag === "has" && typeof subscriber.count === "number") {
    return { tag: "has", count: subscriber.count };
  }
  if (subscriber.tag === "no") return { tag: "no" };
  return { tag: "hidden" };
}

/**
 * Fetches one nationality's roster.
 * Returns an empty array when the endpoint is unreachable.
 */
async function fetchNationality(
  nationality: string,
): Promise<TrackedVTuber[]> {
  try {
    const res = await fetch(`${API}/${nationality}/vtubers/all.json`, {
      headers: {
        Accept: "application/json",
        "User-Agent": "VSingerSingerTracker/1.0",
      },
    });
    if (!res.ok) return [];
    const json = (await res.json()) as { VTubers?: ApiVTuber[] };
    const list = json.VTubers ?? [];

    const out: TrackedVTuber[] = [];
    for (const entry of list) {
      const youtubeId = entry.YouTube?.id;
      if (!youtubeId) continue;
      out.push({
        youtubeId,
        name: entry.name ?? "Unknown",
        aliases: [],
        region: REGION_BY_NATIONALITY[nationality] ?? "unknown",
        activity: toActivity(entry.activity),
        debutDate: entry.debutDate ?? null,
        graduateDate: entry.graduateDate ?? null,
        subscribers: toCountRef(entry.YouTube?.subscriber),
        twitchId: entry.Twitch?.id ?? null,
        // The JSON API's `Twitch.id` is already the login.
        twitchLogin: entry.Twitch?.id ?? null,
        avatar: entry.imgUrl ?? null,
        group: entry.group ?? null,
        // The JSON API does not distinguish "no group" from "not listed".
        isIndependent: false,
      });
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Fetches every published nationality and indexes them by YouTube channel id.
 *
 * The result maps `UC…` → the tracked record, ready to be merged into the
 * dataset.
 */
export async function fetchTrackedVtubers(): Promise<
  Map<string, TrackedVTuber>
> {
  const nationalities = ["TW", "HK", "MY"];
  const results = await Promise.all(
    nationalities.map((n) => fetchNationality(n)),
  );

  const map = new Map<string, TrackedVTuber>();
  for (const list of results) {
    for (const entry of list) {
      // The first nationality wins, so TW is not overwritten by a duplicate
      // HK entry.
      if (!map.has(entry.youtubeId)) map.set(entry.youtubeId, entry);
    }
  }

  // The track list carries fields the JSON API drops — alias names and
  // graduation dates — so it is merged on top.
  const trackList = await fetchTrackList();
  for (const entry of trackList) {
    const existing = map.get(entry.youtubeId);
    if (!existing) {
      map.set(entry.youtubeId, entry);
      continue;
    }
    if (entry.aliases.length) existing.aliases = entry.aliases;
    existing.graduateDate = entry.graduateDate ?? existing.graduateDate;
    existing.debutDate = entry.debutDate ?? existing.debutDate;
    existing.twitchId = entry.twitchId ?? existing.twitchId;
    existing.twitchLogin = entry.twitchLogin ?? existing.twitchLogin;
    existing.group = entry.group ?? existing.group;
    // The track list is the only source that states "no group" positively.
    existing.isIndependent = entry.isIndependent;
    if (entry.activity !== "unknown") existing.activity = entry.activity;
  }

  return map;
}

/* -------------------------------------------------------------------------- */
/* The track list                                                             */
/* -------------------------------------------------------------------------- */

const TRACK_LIST_URL =
  "https://raw.githubusercontent.com/TaiwanVtuberData/TaiwanVtuberTrackingData/master/DATA/TW_VTUBER_TRACK_LIST.csv";

/**
 * Parses one CSV line, honouring double-quoted fields.
 */
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === ",") {
      out.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  out.push(current);
  return out.map((v) => v.trim());
}

/** Converts `2018-12-26` or `2018/12/26` to an ISO date. */
function toIsoDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/.exec(value.trim());
  if (!m) return null;
  return `${m[1]}-${m[2]!.padStart(2, "0")}-${m[3]!.padStart(2, "0")}`;
}

/**
 * Fetches the CSV track list.
 *
 * ```csv
 * ID,Display Name,Alias Names,Youtube Channel ID,Twitch Channel ID,
 * Twitch Channel Name,Debut Date,Graduation Date,Activity,Group Name,Nationality
 * ```
 *
 * Rows starting with `##` are section markers and are skipped.
 */
export async function fetchTrackList(): Promise<TrackedVTuber[]> {
  try {
    const res = await fetch(TRACK_LIST_URL, {
      headers: { "User-Agent": "VSingerSingerTracker/1.0" },
    });
    if (!res.ok) return [];
    const text = await res.text();

    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    if (!lines.length) return [];

    const header = parseCsvLine(lines[0]!);
    const col = (name: string) =>
      header.findIndex((h) => h.toLowerCase() === name.toLowerCase());

    const c = {
      name: col("display name"),
      alias: col("alias names"),
      youtube: col("youtube channel id"),
      twitch: col("twitch channel id"),
      twitchName: col("twitch channel name"),
      debut: col("debut date"),
      graduate: col("graduation date"),
      activity: col("activity"),
      group: col("group name"),
      nationality: col("nationality"),
    };
    if (c.youtube < 0) return [];

    const out: TrackedVTuber[] = [];
    for (const line of lines.slice(1)) {
      if (line.startsWith("##")) continue;
      const cells = parseCsvLine(line);
      const youtubeId = cells[c.youtube];
      if (!youtubeId || !youtubeId.startsWith("UC")) continue;

      const nationality = (c.nationality >= 0 ? cells[c.nationality] : "") ?? "";
      const activity = (c.activity >= 0 ? cells[c.activity] : "") ?? "";

      out.push({
        youtubeId,
        name: (c.name >= 0 ? cells[c.name] : "") || youtubeId,
        aliases:
          c.alias >= 0 && cells[c.alias]
            ? cells[c.alias]!.split(/[,、]/).map((s) => s.trim()).filter(Boolean)
            : [],
        region: REGION_BY_NATIONALITY[nationality.toUpperCase()] ?? "unknown",
        activity: toActivity(
          activity.toLowerCase() === "graduated" ? "graduate" : activity,
        ),
        debutDate: c.debut >= 0 ? toIsoDate(cells[c.debut]) : null,
        graduateDate: c.graduate >= 0 ? toIsoDate(cells[c.graduate]) : null,
        subscribers: { tag: "hidden" },
        twitchId: c.twitch >= 0 && cells[c.twitch] ? cells[c.twitch]! : null,
        // The "Twitch Channel Name" column is the login, not a display name.
        twitchLogin:
          c.twitchName >= 0 && cells[c.twitchName] ? cells[c.twitchName]! : null,
        avatar: null,
        group: c.group >= 0 ? cells[c.group] || null : null,
        // An empty group column means the track list says they are solo.
        isIndependent: !cells[c.group],
      });
    }
    return out;
  } catch {
    return [];
  }
}
