/**
 * Addresses a roster stores as a "link".
 *
 * A platform roster (vdb especially) records whatever URL the performer
 * published, and it arrives in one of four shapes:
 *
 *   https://open.spotify.com/artist/…   an absolute address
 *   https%3A%2F%2Fopen.spotify.com%2F…  the same address, percent-encoded
 *   open.spotify.com/artist/…           a host and a path, no scheme
 *   yiic@example.com                    an e-mail address (`%40` for the `@`)
 *
 * Only the first is an href. The encoded form resolves **relative to our own
 * origin** — `localhost:3000/https%3A%2F%2F…` — and the bare form is not a
 * URL at all. `toHref()` is the single place that turns any of them into
 * something an `<a href>` can use, or `null` when there is no address.
 */

/** Decodes a percent-encoded value, and folds full-width characters. */
function decode(value: string): string {
  let out = value;
  if (/%[0-9a-f]{2}/i.test(out)) {
    try {
      out = decodeURIComponent(out);
    } catch {
      out = value;
    }
  }
  return out.normalize("NFKC");
}

/**
 * The href for a value a roster stored, or `null` when it is not an address.
 *
 * A bare `host/path` gets `https://`; an e-mail address becomes `mailto:`.
 * Everything else returns `null` — a link that 404s is worse than no link.
 */
export function toHref(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return null;

  const decoded = decode(trimmed);

  if (/^(?:https?:\/\/|mailto:)/i.test(decoded)) return decoded;
  if (/^[^/\s@]+@[^/\s@]+\.[^/\s@]+$/.test(decoded)) return `mailto:${decoded}`;

  // A hostname needs at least one dot: `discord.gg/abc`, `yuyix.com`.
  if (
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9-]+)*\.[a-z]{2,}(?:[/?#]|$)/i.test(
      decoded,
    )
  ) {
    return `https://${decoded}`;
  }
  return null;
}

/** The host of an address, without `www.` — `open.spotify.com`. */
export function addressHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url.replace(/^mailto:/i, "").split("@")[1] ?? url;
  }
}
