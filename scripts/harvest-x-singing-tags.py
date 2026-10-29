"""
Harvest VTuber singing-event hashtags from X, for the YouTube discovery pass.

VTuber singing events (歌枠リレー) are announced on X with an event-specific
hashtag — `#ななし夏休み歌枠リレー`, `#ぶいのね歌枠リレー`, `#BtH歌枠リレー` —
and the participants post their YouTube streams under that tag. The tag list
is therefore a **seed list for YouTube search**: searching YouTube for each tag
finds the participants' channels, which the sync's virtual-and-singing gate
then admits.

Three sources, in order of usefulness:

  1. **@shimesaba_krm** — 歌枠リレーカレンダー, a Japanese community account that
     tracks almost every upcoming and past VTuber singing relay. Its pinned
     Lit.Link points at a Google Sheet whose tag column is the canonical list.
  2. **Search `"歌枠リレー" "タイムテーブル"`** — event organisers post the
     timetable image with the event's own hashtag printed on it.
  3. **Search `#歌枠リレー募集`** — streamers recruiting for a themed singing
     event, listing the event name and planned hashtag.

    uv run --no-project --python 3.13 --with "twscrape[curl]" \\
        python scripts/harvest-x-singing-tags.py

    # a wider pass, and a longer look at the calendar account
    ... --limit 200 --calendar-limit 100

    # print just the tags, one per line
    ... --tags-only

Output: `lists/singing-events.json`, which `scripts/sync.ts` reads and turns
into YouTube video searches. Exit codes: 0 on success, 3 when twscrape is not
installed, 4 when no account is in the pool.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import pathlib
import re
import sys
from collections import Counter

try:
    from twscrape import API, gather
except ImportError:  # pragma: no cover - the CI path does not use X
    print(
        'twscrape is not installed: uv run --no-project --python 3.13 '
        '--with "twscrape[curl]" python <script>',
        file=sys.stderr,
    )
    raise SystemExit(3)

# The account that tracks VTuber singing relays.
CALENDAR_ACCOUNT = "shimesaba_krm"

# Queries that surface event announcements and recruitment posts.
SEARCHES = [
    '"歌枠リレー" "タイムテーブル"',
    "#歌枠リレー募集",
    "歌枠リレー 参加者募集",
    '"歌枠リレー" "開催"',
]

# A hashtag that names a singing event. The tag itself is the evidence: the
# video search will find the participants' streams, and the tag's presence in
# a title is what admits the channel.
SINGING_EVENT_TAG = re.compile(
    r"歌枠|歌回|歌ってみた|歌配信|歌枠リレー|歌リレー|カラオケ|karaoke|singing|song",
    re.IGNORECASE,
)

HASHTAG = re.compile(r"#([^\s#@「」【】\[\]()（）,.!?！？、。:：;；\"'“”]+)")


def tags_of(text: str) -> list[str]:
    """Every hashtag in the text, without the leading `#`."""
    return [m.group(1) for m in HASHTAG.finditer(text or "")]


def tweet_text(tweet) -> str:
    return getattr(tweet, "rawContent", "") or ""


async def collect(api: API, query: str, limit: int) -> list[dict]:
    tweets = await gather(api.search(query, limit=limit))
    return [
        {
            "id": t.id_str,
            "date": t.date.isoformat() if getattr(t, "date", None) else None,
            "user": getattr(getattr(t, "user", None), "username", None),
            "text": tweet_text(t)[:1000],
            "tags": tags_of(tweet_text(t)),
        }
        for t in tweets
    ]


async def calendar_tweets(api: API, limit: int) -> list[dict]:
    user = await api.user_by_login(CALENDAR_ACCOUNT)
    if user is None:
        return []
    tweets = await gather(api.user_tweets(user.id, limit=limit))
    return [
        {
            "id": t.id_str,
            "date": t.date.isoformat() if getattr(t, "date", None) else None,
            "user": CALENDAR_ACCOUNT,
            "text": tweet_text(t)[:1000],
            "tags": tags_of(tweet_text(t)),
        }
        for t in tweets
    ]


async def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--limit", type=int, default=100, help="tweets per search")
    parser.add_argument(
        "--calendar-limit",
        type=int,
        default=60,
        help=f"tweets from @{CALENDAR_ACCOUNT}",
    )
    parser.add_argument("--tags-only", action="store_true")
    parser.add_argument(
        "--out",
        default="lists/singing-events.json",
        help="snapshot path (default lists/singing-events.json)",
    )
    parser.add_argument(
        "--db",
        default=str(pathlib.Path.home() / ".cache/x-twscrape/accounts.db"),
        help="twscrape account database",
    )
    args = parser.parse_args()

    os.environ.setdefault("TWS_HTTP_BACKEND", "curl")
    os.environ.setdefault("TWS_TELEMETRY", "0")

    api = API(args.db)
    if not await api.pool.accounts_info():
        print(
            "no account in the pool: add cookies once with harvest-x-twscrape.py --cookies <file>",
            file=sys.stderr,
        )
        return 4

    tweets: list[dict] = []
    for query in SEARCHES:
        try:
            tweets.extend(await collect(api, query, args.limit))
        except Exception as error:  # noqa: BLE001 - a broken query must not stop the pass
            print(f"warn: search {query!r} failed: {error}", file=sys.stderr)
    try:
        tweets.extend(await calendar_tweets(api, args.calendar_limit))
    except Exception as error:  # noqa: BLE001
        print(f"warn: @{CALENDAR_ACCOUNT} failed: {error}", file=sys.stderr)

    # Count every hashtag, keep the ones that name a singing event, and rank
    # by how often the community uses them.
    counts: Counter[str] = Counter()
    first_seen: dict[str, str | None] = {}
    for tweet in tweets:
        for tag in tweet["tags"]:
            if not SINGING_EVENT_TAG.search(tag):
                continue
            counts[tag] += 1
            first_seen.setdefault(tag, tweet["date"])

    tags = [
        {"tag": tag, "count": count, "firstSeen": first_seen.get(tag)}
        for tag, count in counts.most_common()
    ]

    if args.tags_only:
        for entry in tags:
            print("#" + entry["tag"])
        return 0

    # Merge with existing unified file so previously harvested entries are kept
    # and new tags are added without duplicating.
    existing_entries: dict[str, dict] = {}
    try:
        existing = json.loads(pathlib.Path(args.out).read_text(encoding="utf-8"))
        for entry in existing.get("entries", []):
            existing_entries[entry["name"]] = entry
    except Exception:
        existing_entries = {}

    now_iso = __import__("datetime").datetime.now(
        __import__("datetime").timezone.utc
    ).isoformat()

    for tag, count in counts.most_common():
        if tag in existing_entries:
            entry = existing_entries[tag]
            # Keep the higher count and the earlier firstSeen.
            if count > (entry.get("count") or 0):
                entry["count"] = count
            if entry.get("firstSeen") is None:
                entry["firstSeen"] = now_iso
            if "x" not in entry.get("sources", []):
                entry.setdefault("sources", []).append("x")
        else:
            existing_entries[tag] = {
                "name": tag,
                "month": None,
                "count": count,
                "firstSeen": now_iso,
                "sources": ["x"],
            }

    merged_entries = sorted(
        existing_entries.values(),
        key=lambda e: -(e.get("count") or 0),
    )

    sources = sorted(
        {s for e in merged_entries for s in (e.get("sources") or [])},
    )

    out = {
        "generatedAt": now_iso,
        "sources": sources,
        "entries": merged_entries,
    }
    path = pathlib.Path(args.out)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    print(
        f"{len(tweets)} tweet(s) → {len(merged_entries)} unique singing-event entries → {path}",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
