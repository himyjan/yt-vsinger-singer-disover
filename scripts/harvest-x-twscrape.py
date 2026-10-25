"""
Harvest X/Twitter through twscrape, using a cookie-based account.

X's GraphQL answers a logged-out request with `UserUnavailable` and rejects
`screenName` in favour of `userId`. twscrape handles both — it resolves the
login to an id with `UserByScreenName` and asks `UserTweets` with `userId`,
rotating accounts and honouring per-endpoint rate limits — so this is a thin
wrapper rather than a second implementation of X's protocol.

    uv run --no-project --python 3.13 --with "twscrape[curl]" \\
        python scripts/harvest-x-twscrape.py --login ElysianVT --limit 50

    # search instead of a timeline, which is what a discovery pass wants
    uv run --no-project --python 3.13 --with "twscrape[curl]" \\
        python scripts/harvest-x-twscrape.py --search "vtuber 歌ってみた" --limit 50

The account is added once and stays in `~/.cache/x-twscrape/accounts.db`
(override with `--db`). Cookies come from a file, never from the command line:

    auth_token=…; ct0=…
    # or
    twscrape add_cookie <name>   # paste the header when prompted

`TWS_HTTP_BACKEND=curl` is required for `user_by_id` — X's Cloudflare rejects
httpx on some operations. `TWS_TELEMETRY=0` disables twscrape's telemetry.

Exit codes: 0 on success, 2 when no cookie file was given, 3 when twscrape is
not installed, 4 when no account is active.
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

    twscrape expands `t.co` links into `links[].url`/`expandedUrl`, so a bio
    link or a YouTube upload link is readable without fetching the tweet page.
    """
    found: list[str] = []
    for link in getattr(tweet, "links", None) or []:
        url = getattr(link, "expandedUrl", None) or getattr(link, "url", None)
        if isinstance(url, str):
            found.extend(CHANNEL_RE.findall(url))
    text = getattr(tweet, "rawContent", "") or ""
    found.extend(CHANNEL_RE.findall(text))
    return sorted(set(found))


async def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    target = parser.add_mutually_exclusive_group(required=True)
    target.add_argument("--login", help="screen name whose timeline to read")
    target.add_argument("--search", help="search query")
    parser.add_argument("--limit", type=int, default=50)
    parser.add_argument("--cookies", help="file holding auth_token and ct0")
    parser.add_argument("--account", default="default", help="local name for the account")
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

    if args.login:
        user = await api.user_by_login(args.login)
        if user is None:
            print(f"@{args.login} is not readable: no such user, or it is protected", file=sys.stderr)
            return 1
        tweets = await gather(api.user_tweets(user.id, limit=args.limit))
        author = {"login": user.username, "id": user.id, "name": user.displayname}
    else:
        tweets = await gather(api.search(args.search, limit=args.limit))
        author = None

    out = {
        "query": {"login": args.login, "search": args.search, "author": author},
        "tweets": [
            {
                "id": tweet.id_str,
                "date": tweet.date.isoformat() if getattr(tweet, "date", None) else None,
                "user": getattr(getattr(tweet, "user", None), "username", None),
                "text": (getattr(tweet, "rawContent", "") or "")[:1000],
                "links": channel_links(tweet),
            }
            for tweet in tweets
        ],
    }
    out["links"] = sorted({link for t in out["tweets"] for link in t["links"]})
    print(json.dumps(out, ensure_ascii=False, indent=2))
    print(
        f"{len(out['tweets'])} tweet(s), {len(out['links'])} channel link(s)",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
