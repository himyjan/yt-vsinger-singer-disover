"""
Harvest Facebook groups through facebook-gql-scraper.

The library talks to Facebook's internal GraphQL endpoints with a saved
cookie session. Facebook gates group posts behind a login: without cookies the
group URL answers `302 → /login/?next=…`, the fb_dtsg token never appears, and
both search and group reads fail with "Cookies are expired". So this script
needs a real session:

    # with uv, no venv to manage (3.13 is required; the system 3.9 is too old)
    uv run --no-project --python 3.13 --with facebook-gql-scraper \
        python scripts/harvest-facebook-groups.py \
        --group 2569285399989405 --cookies facebook_cookies.json

    # or with a venv you keep
    uv venv --python 3.13 && uv pip install facebook-gql-scraper
    .venv/bin/python scripts/harvest-facebook-groups.py \
        --group 2569285399989405 --cookies facebook_cookies.json

Export the cookies with Cookie-Editor → `facebook_cookies.json`: a list of
`{name, value, …}` objects, as in the library's README.

It prints the group's posts and every YouTube / Twitch / lit.link / Bilibili
link found in them, as JSON on stdout, so it can be piped into the dataset
tools. It never writes `data/` itself.

Exit codes: 0 on success, 2 when the session is not logged in, 3 when the
library is not installed, 4 when the cookie file is missing.
"""

from __future__ import annotations

import argparse
import json
import pathlib
import re
import sys

try:
    import facebook_gql_scraper as fgs
    from facebook_gql_scraper.exceptions import SessionExpiredError
except ImportError:  # pragma: no cover - the CI path does not need it
    print(
        "facebook-gql-scraper is not installed: "
        "uv run --no-project --python 3.13 --with facebook-gql-scraper python <script>",
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


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--group", action="append", required=True, help="group id or slug")
    parser.add_argument("--cookies", default="facebook_cookies.json")
    parser.add_argument("--state", default="fb_state.json")
    parser.add_argument("--limit", type=int, default=50, help="posts per group")
    args = parser.parse_args()

    if not pathlib.Path(args.cookies).is_file():
        print(
            f"{args.cookies} is missing. Export the cookies with Cookie-Editor "
            "while logged in to Facebook and save them as that file.",
            file=sys.stderr,
        )
        return 4

    ctx = fgs.FacebookContext(
        cookies_file=args.cookies, state_file=args.state, quiet=True
    )
    # A logged-in page carries DTSGInitialData; only the logged-out login form
    # carries the `{"name":"fb_dtsg","value":…}` the library looks for, so it
    # reports a missing token for a session that is perfectly valid.
    if not ctx.fb_dtsg:
        token = re.search(
            r'"DTSGInitialData",\[\],\{"token":"([^"]+)"',
            ctx.get("https://www.facebook.com").text,
        )
        if token:
            ctx.fb_dtsg = token.group(1)

    out: dict = {"groups": [], "errors": []}
    for group_id in args.group:
        try:
            group = fgs.Group.from_group_id(ctx, group_id=group_id)
        except SessionExpiredError:
            out["errors"].append(
                f"{group_id}: the session is not logged in — Facebook redirected "
                "to /login, so group posts are not public"
            )
            continue
        except Exception as exc:  # noqa: BLE001 - a broken group must not stop the run
            message = str(exc)
            if "fb_dtsg" in message:
                message = (
                    "no fb_dtsg token — Facebook answered the login page, so the "
                    "cookie session is missing or expired"
                )
            out["errors"].append(f"{group_id}: {message[:300]}")
            continue

        record = {
            "id": group.id,
            "name": group.name,
            "privacy": group.privacy,
            "members": group.member_count,
            "posts": [],
        }
        try:
            for post in group.get_posts():
                text = post.text or ""
                record["posts"].append(
                    {
                        "id": post.id,
                        "time": post.creation_time,
                        "text": text[:600],
                        "links": sorted(set(CHANNEL_RE.findall(text))),
                        "author": getattr(post.owner, "name", None),
                    }
                )
                if len(record["posts"]) >= args.limit:
                    break
        except SessionExpiredError:
            out["errors"].append(f"{group_id}: the session expired while reading posts")
        except Exception as exc:  # noqa: BLE001
            out["errors"].append(f"{group_id} posts: {str(exc)[:300]}")
        out["groups"].append(record)

    print(json.dumps(out, ensure_ascii=False, indent=2))
    failed = bool(out["errors"]) and not any(g["posts"] for g in out["groups"])
    return 2 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
