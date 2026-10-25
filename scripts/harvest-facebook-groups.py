"""
Harvest Facebook groups through facebook-gql-scraper.

The library talks to Facebook's internal GraphQL endpoints with a saved
cookie session. Facebook gates group posts behind a login: without cookies the
group URL answers `302 → /login/?next=…`, the fb_dtsg token never appears, and
both search and group reads fail with "Cookies are expired". So this script
needs a real session:

    pip install facebook-gql-scraper
    # export cookies with Cookie-Editor → facebook_cookies.json (Netscape or
    # JSON, the same shape the README shows: a list of {name, value, …})
    python scripts/harvest-facebook-groups.py \
        --group 2569285399989405 \
        --cookies facebook_cookies.json

It prints the group's posts and every YouTube / Twitch / lit.link / Bilibili
link found in them, as JSON on stdout, so it can be piped into the dataset
tools. It never writes `data/` itself.

Exit codes: 0 on success, 2 when the session is not logged in, 3 when the
library is not installed.
"""

from __future__ import annotations

import argparse
import json
import re
import sys

try:
    import facebook_gql_scraper as fgs
    from facebook_gql_scraper.exceptions import SessionExpiredError
except ImportError:  # pragma: no cover - the CI path does not need it
    print(
        "facebook-gql-scraper is not installed: pip install facebook-gql-scraper",
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

    ctx = fgs.FacebookContext(
        cookies_file=args.cookies, state_file=args.state, quiet=True
    )

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
