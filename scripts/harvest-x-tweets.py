"""
Harvest X.com tweets through the GraphQL endpoint — no browser, no API v2 key.

X's public bearer token is the same for every web session; the session is the
`auth_token` / `ct0` cookie pair, and `ct0` is also the `x-csrf-token` header.
That is all this file needs, so there is no dependency on a scraping library
and nothing to install beyond `requests`:

    uv run --no-project --python 3.13 --with requests \\
        python scripts/harvest-x-tweets.py --username marou_miraiya

Multiple accounts:

    python scripts/harvest-x-tweets.py --username a,b,c --limit 100

The output is JSON on stdout: each tweet's id, time, text, and every YouTube /
Twitch / lit.link / Bilibili link it names. `--links-only` prints just the
links, one per line, for piping.

The GraphQL operation id (`UserTweets`) is X's build artefact and changes
whenever they ship: a `404` here means the id is stale, not that the account
is gone. Pass the current one with `--query-id` (DevTools → Network →
`UserTweets`); the default comes from nitter's `consts.nim`.

What X answers without a session is worth knowing, because it is easy to
misread as "the account is private":

  | Request | Answer |
  | --- | --- |
  | no `authorization` at all | `400` · `Bad Authentication data` (215) |
  | public bearer, no cookies | `200` · `{"result":{"__typename":"UserUnavailable"}}` |
  | `auth_token` / `ct0` present but dead | `401` · `Could not authenticate you` (32) |
  | live session | the timeline |

So `UserUnavailable` is the logged-out answer, not a missing account.

A community timeline (`x.com/i/communities/<id>`) is **not** this endpoint —
it has its own operation, and without a session it is not readable at all.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time

try:
    import requests
except ImportError:  # pragma: no cover - the CI path does not need it
    print(
        "requests is not installed: "
        "uv run --no-project --python 3.13 --with requests python <script>",
        file=sys.stderr,
    )
    raise SystemExit(3)

# The public web bearer token, identical for every logged-out session. Without
# a session it is accepted (a bad one is "code 215 Bad Authentication data"),
# and the answer is still `UserUnavailable`: X needs the cookies, not the key.
BEARER = (
    "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA"
)
# From nitter's consts.nim (the operation ids X ships to the web client). They
# change with a release; a 404 / "Query not found" means this one is stale.
USER_TWEETS_QUERY_ID = "SXVCYB8XHSS25nzIljNtZA"

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

FEATURES = {
    "rweb_tipjar_web_tipjar_consumption_enabled": True,
    "responsive_web_graphql_exclude_directive_enabled": True,
    "verified_phone_label_enabled": False,
    "creator_subscriptions_tweet_preview_api_enabled": True,
    "responsive_web_graphql_timeline_v2_enabled": True,
    "responsive_web_graphql_mashup_hints_enabled": True,
    "articles_preview_enabled": True,
    "tweetypie_unmention_optimization_enabled": True,
    "responsive_web_edit_tweet_api_enabled": True,
    "graphql_is_translatable_rweb_tweet_is_translatable_enabled": True,
    "view_counts_everywhere_api_enabled": True,
    "longform_notetaking_opts": False,
    "responsive_web_enhance_cards_enabled": False,
}


def load_cookies(path: str) -> dict[str, str]:
    """Read the cookie file: Cookie-Editor's list, or a plain name → value map."""
    with open(path, encoding="utf-8") as handle:
        raw = json.load(handle)
    if isinstance(raw, dict):
        return {str(k): str(v) for k, v in raw.items()}
    return {c["name"]: c["value"] for c in raw if "name" in c and "value" in c}


def headers(cookies: dict[str, str], query_id: str) -> dict[str, str]:
    csrf = cookies.get("ct0", "")
    if not cookies.get("auth_token") or not csrf:
        raise SystemExit(
            "auth_token and ct0 are both required: log in to x.com, then export "
            "those two cookies (plus twid and _mb_tk) to the cookie file."
        )
    return {
        "authorization": f"Bearer {BEARER}",
        "x-csrf-token": csrf,
        "x-twitter-auth-type": "OAuth2Session",
        "x-twitter-active-user": "yes",
        "x-twitter-client-language": "en",
        "content-type": "application/json",
        "accept": "*/*",
        "referer": "https://x.com/",
        "origin": "https://x.com",
        "user-agent": (
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
        ),
        # Only used to label the operation; the URL carries the id.
        "path": f"/graphql/{query_id}/UserTweets",
    }


def walk(node, out: list[dict]) -> None:
    """Collect every Tweet result in a timeline, whatever the nesting."""
    if isinstance(node, dict):
        if node.get("__typename") == "Tweet" and node.get("rest_id"):
            out.append(node)
        for value in node.values():
            walk(value, out)
    elif isinstance(node, list):
        for value in node:
            walk(value, out)


def unavailable(payload: dict) -> bool:
    """True when X answered a placeholder instead of a timeline."""
    data = payload.get("data") or {}
    for holder in ("user", "user_result_by_screen_name"):
        result = (data.get(holder) or {}).get("result") or {}
        if result.get("__typename", "").endswith("Unavailable"):
            return True
    return not data.get("user") and not data.get("user_result_by_screen_name")


def tweet_text(tweet: dict) -> str:
    legacy = tweet.get("legacy") or {}
    text = legacy.get("full_text") or (tweet.get("details") or {}).get("full_text") or ""
    note = ((tweet.get("note_tweet") or {}).get("note_tweet_results") or {}).get("result") or {}
    return note.get("text") or text


def bottom_cursor(payload: dict) -> str | None:
    """The `cursor-bottom` entry closes the page; the top one rescans."""
    result: dict = {}
    data = payload.get("data") or {}
    for holder in ("user", "user_result_by_screen_name"):
        result = ((data.get(holder) or {}).get("result") or {}) or result
    for key in ("timeline_v2", "profile_timeline_v2"):
        timeline = (result.get(key) or {}).get("timeline") or {}
        for instruction in timeline.get("instructions", []):
            for entry in instruction.get("entries", []):
                if "cursor-bottom" not in str(entry.get("entryId", "")):
                    continue
                content = entry.get("content") or {}
                value = content.get("value") or (content.get("item") or {}).get("content", {}).get("value")
                if value:
                    return value
    return None


def fetch_page(
    session: requests.Session,
    screen_name: str,
    query_id: str,
    cursor: str | None,
) -> tuple[list[dict], str | None]:
    variables = {
        "screenName": screen_name,
        "count": 100,
        "cursor": cursor,
        "includePromotedContent": False,
        "withQuickPromoteEligibilityTweet": False,
        "withVoice": False,
        "withV2Timeline": True,
        # The variables are sent untrimmed, so every key the operation
        # declares has to be present or X answers an empty timeline.
        "withCommunity": False,
        "withArticlePlainText": False,
        "withArticleRichContentState": True,
    }
    response = session.get(
        f"https://api.x.com/graphql/{query_id}/UserTweets",
        params={
            "variables": json.dumps(variables, separators=(",", ":")),
            "features": json.dumps(FEATURES, separators=(",", ":")),
        },
        timeout=30,
    )
    if response.status_code != 200:
        hint = ""
        if response.status_code == 404:
            hint = " (the GraphQL operation id is stale — pass --query-id)"
        elif response.status_code in (401, 403):
            hint = " (auth_token/ct0 are not a live session — log in again and re-export)"
        raise RuntimeError(f"HTTP {response.status_code}: {response.text[:200]}{hint}")
    payload = response.json()
    if unavailable(payload):
        raise RuntimeError(
            "X answered UserUnavailable — the auth_token/ct0 session is not "
            "logged in (a logged-out request always gets this answer)."
        )
    tweets: list[dict] = []
    walk(payload.get("data") or {}, tweets)
    return tweets, bottom_cursor(payload)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--username", required=True, help="one or more screen names, comma-separated")
    parser.add_argument("--cookies", default="cookies.json")
    parser.add_argument("--limit", type=int, default=200, help="tweets per account")
    parser.add_argument("--query-id", default=USER_TWEETS_QUERY_ID)
    parser.add_argument("--links-only", action="store_true")
    parser.add_argument("--delay", type=float, default=1.5, help="seconds between pages")
    args = parser.parse_args()

    import pathlib

    if not pathlib.Path(args.cookies).is_file():
        print(
            f"{args.cookies} is missing. Log in to x.com, copy the auth_token, ct0, "
            "twid and _mb_tk cookies (DevTools → Application → Cookies) into it.",
            file=sys.stderr,
        )
        return 4

    cookies = load_cookies(args.cookies)
    session = requests.Session()
    session.headers.update(headers(cookies, args.query_id))
    session.cookies.update(cookies)

    accounts = {}
    fatal = None
    for screen_name in [name.strip().lstrip("@") for name in args.username.split(",") if name.strip()]:
        collected: dict[str, dict] = {}
        cursor = None
        while len(collected) < args.limit:
            try:
                tweets, cursor = fetch_page(session, screen_name, args.query_id, cursor)
            except Exception as exc:  # noqa: BLE001 - one account must not stop the rest
                message = str(exc)[:300]
                # A dead session fails the same way for every account; stop.
                if "Could not authenticate" in message or "UserUnavailable" in message:
                    fatal = message
                    break
                accounts[screen_name] = {"error": message, "tweets": list(collected.values())}
                break
            before = len(collected)
            for tweet in tweets:
                tweet_id = str(tweet.get("rest_id"))
                text = tweet_text(tweet)
                collected.setdefault(
                    tweet_id,
                    {
                        "id": tweet_id,
                        "time": (tweet.get("legacy") or {}).get("created_at"),
                        "text": text[:1000],
                        "links": sorted(set(CHANNEL_RE.findall(text))),
                    },
                )
            if not cursor or len(collected) == before:
                break
            time.sleep(args.delay)
        if fatal:
            break
        accounts[screen_name] = {"tweets": list(collected.values())[: args.limit]}

    if args.links_only:
        seen = set()
        for account in accounts.values():
            for tweet in account.get("tweets", []):
                for link in tweet["links"]:
                    if link not in seen:
                        seen.add(link)
                        print(link)
    else:
        print(
            json.dumps({"accounts": accounts}, ensure_ascii=False, indent=2),
            file=sys.stdout,
        )
    if fatal:
        print(f"stopped: {fatal}", file=sys.stderr)
    if fatal or any("error" in a for a in accounts.values()):
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
