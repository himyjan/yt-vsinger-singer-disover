"""
Harvest an X community's members and the channel links in their bios.

The "VTubers!" community (`1497343732827312128`, 38,719 members) is full of
performers introducing themselves, and an X profile is where a VTuber puts
their YouTube and Twitch accounts — `descriptionLinks` and the website field.

    uv run --no-project --python 3.13 --with "twscrape[curl]" \\
        python scripts/harvest-x-community.py --community 1497343732827312128 \\
        --limit 200 --profiles 60 --cookies cookies.txt

It writes `.cache/x-community.json`; turning that into suggestions is
`npx tsx .cache/x-community-to-suggestions.ts`, because resolving a YouTube
`@handle` to its `UC…` id is the pipeline's job (InnerTube), not this
script's.

Why twscrape: a community timeline is a separate GraphQL operation
(`CommunityTweetsTimeline`) and X answers a logged-out request with
`UserUnavailable`. twscrape carries the operation ids, the per-account rate
limits and the cookie session.

`TWS_HTTP_BACKEND=curl` is required for some reads (Cloudflare rejects httpx)
and `TWS_TELEMETRY=0` turns its telemetry off.

Exit codes: 0 on success, 2 when the cookie file is missing, 3 when twscrape
is not installed, 4 when no account is active, 5 when the community is
unreadable.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import pathlib
import re
import sys

try:
    from twscrape import API, gather
except ImportError:  # pragma: no cover - the CI path does not use X
    print(
        'twscrape is not installed: uv run --no-project --python 3.13 '
        '--with "twscrape[curl]" python <script>',
        file=sys.stderr,
    )
    raise SystemExit(3)

CHANNEL_RE = re.compile(
    r"https?://(?:www\.)?"
    r"(?:youtube\.com/(?:@[\w.\-]+|channel/UC[\w-]{20,}|c/[\w.\-]+|user/[\w.\-]+)"
    r"|youtu\.be/[\w-]{11}"
    r"|twitch\.tv/[\w]+)",
    re.IGNORECASE,
)
# A video or a post is not a channel; only profile-shaped URLs are kept.
VIDEO_RE = re.compile(r"(?:youtu\.be/|/watch\?v=|/shorts/|/status/|/i/communities/)", re.IGNORECASE)


def cookie_header(path: pathlib.Path) -> str:
    text = path.read_text(encoding="utf-8").strip()
    if text.startswith("["):
        pairs = {c["name"]: c["value"] for c in json.loads(text) if "name" in c}
        return "; ".join(f"{k}={v}" for k, v in pairs.items())
    return text


def profile_links(user) -> list[str]:
    """Channel links from a profile: its link list, its website, its bio."""
    found: list[str] = []
    for link in getattr(user, "descriptionLinks", None) or []:
        url = getattr(link, "url", None) or getattr(link, "expandedUrl", None)
        if isinstance(url, str):
            found.append(url)
    for attr in ("url", "website"):
        value = getattr(user, attr, None)
        if isinstance(value, str) and value:
            found.append(value)
    bio = getattr(user, "rawDescription", "") or ""
    found.extend(CHANNEL_RE.findall(bio))
    out: list[str] = []
    for url in found:
        if VIDEO_RE.search(url):
            continue
        out.extend(CHANNEL_RE.findall(url))
    return sorted(set(out))


async def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--community", default="1497343732827312128")
    parser.add_argument("--limit", type=int, default=200, help="community tweets to read")
    parser.add_argument("--profiles", type=int, default=60, help="author profiles to read")
    parser.add_argument("--cookies", help="file holding auth_token and ct0")
    parser.add_argument("--db", default=str(pathlib.Path.home() / ".cache/x-twscrape/accounts.db"))
    parser.add_argument("--out", default=".cache/x-community.json")
    parser.add_argument(
        "--state",
        default=".cache/x-community-state.json",
        help="resume file: profiles already read, so a run continues where the last one stopped",
    )
    parser.add_argument(
        "--reset",
        action="store_true",
        help="ignore the resume file and start over",
    )
    args = parser.parse_args()

    os.environ.setdefault("TWS_HTTP_BACKEND", "curl")
    os.environ.setdefault("TWS_TELEMETRY", "0")
    pathlib.Path(args.db).parent.mkdir(parents=True, exist_ok=True)

    api = API(args.db)
    if args.cookies:
        path = pathlib.Path(args.cookies)
        if not path.is_file():
            print(f"{path} is missing", file=sys.stderr)
            return 2
        await api.pool.add_account_cookies("default", cookie_header(path))
    elif not await api.pool.accounts_info():
        print("no account in the pool: pass --cookies once", file=sys.stderr)
        return 4

    info = await api.community_info(int(args.community))
    if info is None:
        print(f"community {args.community} is unreadable", file=sys.stderr)
        return 5
    print(f"community {info.name!r}, {info.memberCount} members", file=sys.stderr)

    tweets = await gather(api.community_tweets(int(args.community), limit=args.limit))
    authors: dict[str, dict] = {}
    for tweet in tweets:
        user = getattr(tweet, "user", None)
        login = getattr(user, "username", None)
        if not login or login in authors:
            continue
        authors[login] = {
            "login": login,
            "name": getattr(user, "displayname", None),
            "followers": getattr(user, "followersCount", None),
            "links": [],
        }
    print(f"{len(tweets)} tweets from {len(authors)} authors", file=sys.stderr)

    # --- resume ----------------------------------------------------------
    # A profile read costs one `UserByScreenName`, and X allows ~50 of those
    # per 15 minutes per account. A run that died at #30 must continue at #31,
    # not at #1, or the budget is spent re-reading people already known.
    state_path = pathlib.Path(args.state)
    done: dict[str, dict] = {}
    if args.reset and state_path.is_file():
        state_path.unlink()
        print("resume file cleared (--reset)", file=sys.stderr)
    if state_path.is_file():
        done = json.loads(state_path.read_text(encoding="utf-8")).get("profiles", {})
        print(f"resume: {len(done)} profile(s) already read", file=sys.stderr)
    for login, row in authors.items():
        known_row = done.get(login)
        if known_row and "error" not in known_row:
            row.update(known_row)
    pending = [login for login in authors if login not in done]

    budget = args.profiles
    checked = 0
    for login in pending:
        if checked >= budget:
            print(f"budget reached ({budget}); {len(pending) - checked} left for the next run", file=sys.stderr)
            break
        try:
            user = await api.user_by_login(login)
        except Exception as exc:  # noqa: BLE001 - a rate limit must not stop the run
            print(f"stopped after {checked} profiles: {str(exc)[:160]}", file=sys.stderr)
            break
        checked += 1
        if user is None:
            done[login] = {"error": "unreadable"}
            authors[login]["note"] = "profile unreadable (protected or missing)"
        else:
            done[login] = {
                "name": getattr(user, "displayname", None),
                "followers": getattr(user, "followersCount", None),
                "links": profile_links(user),
                "protected": bool(getattr(user, "protected", False)),
            }
            authors[login].update(done[login])
        state_path.parent.mkdir(parents=True, exist_ok=True)
        state_path.write_text(json.dumps({"profiles": done}, ensure_ascii=False, indent=2), encoding="utf-8")

    with_links = {k: v for k, v in authors.items() if v.get("links")}
    print(
        f"{len(with_links)} of {len(done)} profiles carry a channel link · "
        f"{len(pending) - checked} still queued",
        file=sys.stderr,
    )

    out = {
        "community": {
            "id": str(getattr(info, "id", args.community)),
            "name": getattr(info, "name", None),
            "members": getattr(info, "memberCount", None),
        },
        "tweets_read": len(tweets),
        "profiles_read": checked,
        "authors": authors,
    }
    pathlib.Path(args.out).write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"wrote {args.out}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
