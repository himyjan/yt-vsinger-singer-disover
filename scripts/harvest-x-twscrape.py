"""
Harvest X/Twitter through twscrape, using a cookie-based account.

X's GraphQL answers a logged-out request with `UserUnavailable`, rejects
`screenName` in favour of `userId`, and hides the **community** timeline
(`x.com/i/communities/<id>`) behind a completely separate operation. twscrape
implements all three — it resolves a login with `UserByScreenName`, asks
`UserTweets` with `userId`, and reads `CommunityTweetsTimeline` — and it holds
the per-account rate limits and rotates accounts, so this is a thin wrapper
rather than a second implementation of X's protocol.

    uv run --no-project --python 3.13 --with "twscrape[curl]" \\
        python scripts/harvest-x-twscrape.py --login ElysianVT --limit 50

    # a community's posts — the "VTubers!" community is 38,719 members
    uv run --no-project --python 3.13 --with "twscrape[curl]" \\
        python scripts/harvest-x-twscrape.py --community 1497343732827312128 --limit 100

    # search, which is what a discovery pass wants
    ... --search "vtuber 歌ってみた" --limit 50

`--links-only` prints just the channel links, one per line, for piping. The
account is added once and stays in `~/.cache/x-twscrape/accounts.db` (override
with `--db`). Cookies come from a file, never from the command line:

    auth_token=…; ct0=…

`TWS_HTTP_BACKEND=curl` is required for `user_by_id` — Cloudflare rejects
httpx on some operations. `TWS_TELEMETRY=0` disables twscrape's telemetry.

Exit codes: 0 on success, 2 when no cookie file was given, 3 when twscrape is
not installed, 4 when no account is active, 5 when a community is unreadable.
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
    r"|twitch\.tv/[\w]+"
    r"|lit\.link/[\w.\-/]+"
    r"|space\.bilibili\.com/\d+"
    r"|bilibili\.com/[\w.\-/]+)",
    re.IGNORECASE,
)


def cookie_header(path: pathlib.Path) -> str:
    text = path.read_text(encoding="utf-8").strip()
    if text.startswith("["):
        pairs = {c["name"]: c["value"] for c in json.loads(text) if "name" in c}
        return "; ".join(f"{k}={v}" for k, v in pairs.items())
    return text


def channel_links(tweet) -> list[str]:
    """Every channel link the tweet itself carries.

    twscrape expands `t.co` links into `links[].expandedUrl`, so a bio link or
    a YouTube upload link is readable without fetching the tweet page.
    """
    found: list[str] = []
    for link in getattr(tweet, "links", None) or []:
        url = getattr(link, "expandedUrl", None) or getattr(link, "url", None)
        if isinstance(url, str):
            found.extend(CHANNEL_RE.findall(url))
    text = getattr(tweet, "rawContent", "") or ""
    found.extend(CHANNEL_RE.findall(text))
    return sorted(set(found))


def tweet_row(tweet) -> dict:
    user = getattr(tweet, "user", None)
    return {
        "id": tweet.id_str,
        "date": tweet.date.isoformat() if getattr(tweet, "date", None) else None,
        "user": getattr(user, "username", None),
        "name": getattr(user, "displayname", None),
        "followers": getattr(user, "followersCount", None),
        "text": (getattr(tweet, "rawContent", "") or "")[:1000],
        "links": channel_links(tweet),
    }


async def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    target = parser.add_mutually_exclusive_group(required=True)
    target.add_argument("--login", help="screen name whose timeline to read")
    target.add_argument("--search", help="search query")
    target.add_argument("--community", help="community id, e.g. 1497343732827312128")
    parser.add_argument("--limit", type=int, default=50)
    parser.add_argument("--cookies", help="file holding auth_token and ct0")
    parser.add_argument("--account", default="default", help="local name for the account")
    parser.add_argument("--links-only", action="store_true")
    parser.add_argument(
        "--db",
        default=str(pathlib.Path.home() / ".cache/x-twscrape/accounts.db"),
        help="account database (cookies live here, not in the repository)",
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
        await api.pool.add_account_cookies(args.account, cookie_header(path))
    elif not await api.pool.accounts_info():
        print("no account in the pool: pass --cookies once", file=sys.stderr)
        return 4

    info = None
    if args.login:
        user = await api.user_by_login(args.login)
        if user is None:
            print(f"@{args.login} is not readable: no such user, or it is protected", file=sys.stderr)
            return 1
        tweets = await gather(api.user_tweets(user.id, limit=args.limit))
    elif args.community:
        info = await api.community_info(int(args.community))
        if info is None:
            print(f"community {args.community} is unreadable", file=sys.stderr)
            return 5
        tweets = await gather(api.community_tweets(int(args.community), limit=args.limit))
    else:
        tweets = await gather(api.search(args.search, limit=args.limit))

    rows = [tweet_row(tweet) for tweet in tweets]
    if args.links_only:
        for link in sorted({link for row in rows for link in row["links"]}):
            print(link)
        return 0

    out = {
        "query": {
            "login": args.login,
            "search": args.search,
            "community": args.community,
            "community_name": getattr(info, "name", None) if info else None,
            "community_members": getattr(info, "memberCount", None) if info else None,
        },
        "tweets": rows,
        "links": sorted({link for row in rows for link in row["links"]}),
    }
    print(json.dumps(out, ensure_ascii=False, indent=2))
    names = sorted({row["user"] for row in rows if row["user"]})
    print(
        f"{len(rows)} tweet(s) from {len(names)} account(s), {len(out['links'])} channel link(s)",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
