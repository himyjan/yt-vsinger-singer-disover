/**
 * Build-time environment helpers.
 *
 * `vite/client` already types `import.meta.env` with an index signature;
 * these just narrow the values to `string` and give them a default.
 */

export function envString(key: string): string {
  return (import.meta.env as Record<string, string | undefined>)[key] ?? "";
}

export const env = {
  /** Google OAuth client id, for linking a YouTube account. */
  googleClientId: envString("VITE_GOOGLE_CLIENT_ID"),
  /** YouTube Data API key, for public (non-scoped) calls. */
  youtubeApiKey: envString("VITE_YOUTUBE_API_KEY"),
  /** Twitch application client id (a public client needs no secret). */
  twitchClientId: envString("VITE_TWITCH_CLIENT_ID"),
  /** VK application id. */
  vkClientId: envString("VITE_VK_CLIENT_ID"),
};
