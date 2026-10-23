/**
 * Images must load over HTTPS.
 *
 * The app is deployed on HTTPS, and some upstream APIs still publish plain
 * `http://` CDN URLs — Bilibili's `i0.hdslb.com` profile images are the common
 * one. A browser either blocks those as mixed content or reports them in the
 * console after upgrading them itself. The dataset and the Bilibili adapter
 * normalise new values, but cached or older JSON can still contain one, so
 * every rendered image goes through this helper as well.
 */
export function imageUrl(url: string | null | undefined): string {
  if (!url) return "";
  if (url.startsWith("//")) return `https:${url}`;
  if (url.startsWith("http://")) return `https://${url.slice("http://".length)}`;
  return url;
}
