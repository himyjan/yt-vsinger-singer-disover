/**
 * Twitch GQL — the quota-free, secret-free Twitch source.
 *
 * This is the **youtubei.js equivalent for Twitch**.
 *
 * The official Helix API needs a client id *and* a client secret, and it
 * counts against a rate limit. But the Twitch website itself talks to an
 * internal GraphQL endpoint — `https://gql.twitch.tv/gql` — and that
 * endpoint only needs the **public web client id** that every Twitch page
 * ships with.
 *
 * So the same trade-off InnerTube offers on YouTube applies here:
 *
 * | | YouTube | Twitch |
 * | --- | --- | --- |
 * | Official API | Data API v3 | Helix |
 * | Quota | 10,000 units/day | a rate limit |
 * | Credentials | an API key | a client id **and** a secret |
 * | **Free source** | **InnerTube** (youtubei.js) | **GQL** (this module) |
 *
 * The GQL endpoint gives the channel's display name, its **description**, its
 * **follower count**, its avatar and its live status — all without a secret.
 */

import { RateLimiter } from "./rate-limit";

const GQL = "https://gql.twitch.tv/gql";

/**
 * The public client id that the Twitch website uses.
 *
 * It is not a secret: it is embedded in every Twitch page, and the GQL
 * endpoint only rejects requests that do not send one.
 */
export const TWITCH_WEB_CLIENT_ID = "kimne78kx3ncx6brgo4mv6wki5h1ko";

export interface TwitchProfile {
  /** The numeric user id. */
  id: string;
  /** The login — the name in the URL. */
  login: string | null;
  /** The display name. */
  displayName: string | null;
  /** The channel description — where a performer states their own language. */
  description: string | null;
  /** The profile image. */
  avatar: string | null;
  /** The follower count. */
  followers: number | null;
  /** The live stream, when the channel is live. */
  live: {
    id: string;
    title: string;
    viewers: number | null;
    game: string | null;
  } | null;
}

export interface TwitchFollow {
  /** The channel's user id. */
  id: string;
  /** The channel's login. */
  login: string | null;
  /** The channel's display name. */
  displayName: string | null;
  /** The channel's follower count. */
  followers: number | null;
  /** The channel's avatar. */
  avatar: string | null;
}

export interface TwitchGqlOptions {
  /** The client id. Defaults to the public web client id. */
  clientId?: string;
  /** Pause between requests, in milliseconds. */
  delayMs?: number;
  onLog?: (message: string) => void;
}

export class TwitchGqlSource {
  private readonly clientId: string;
  private readonly delayMs: number;
  private readonly onLog: (message: string) => void;
  /** The adaptive limiter — it widens when Twitch pushes back. */
  private readonly limiter: RateLimiter;

  constructor(options: TwitchGqlOptions = {}) {
    this.clientId = options.clientId ?? TWITCH_WEB_CLIENT_ID;
    this.delayMs = options.delayMs ?? 300;
    this.onLog = options.onLog ?? (() => {});
    this.limiter = new RateLimiter({
      minIntervalMs: this.delayMs,
      maxIntervalMs: 15_000,
      onLimit: (m) => this.onLog(`twitch gql: ${m}`),
      onChange: (ms) =>
        this.onLog(`twitch gql: interval → ${Math.round(ms)}ms`),
    });
  }

  private async throttle(): Promise<void> {
    await this.limiter.wait();
  }

  private async query<T>(body: string): Promise<T | null> {
    try {
      await this.throttle();
      const res = await fetch(GQL, {
        method: "POST",
        headers: {
          "Client-Id": this.clientId,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query: body }),
      });
      if (!res.ok) return null;
      const json = (await res.json()) as {
        data?: T;
        errors?: { message: string }[];
      };
      if (json.errors?.length && !json.data) {
        this.limiter.penalise();
        this.onLog(`twitch gql: ${json.errors[0]?.message ?? "error"}`);
        return null;
      }
      this.limiter.reward();
      return json.data ?? null;
    } catch (err) {
      this.limiter.penalise();
      this.onLog(`twitch gql: ${(err as Error).message}`);
      return null;
    }
  }

  /**
   * A channel's profile.
   *
   * @param loginOrId The login (`tarik`) or the numeric user id.
   */
  async profile(loginOrId: string): Promise<TwitchProfile | null> {
    if (!loginOrId) return null;

    const isId = /^\d+$/.test(loginOrId);
    const field = isId ? "id" : "login";
    const value = isId ? `"${loginOrId}"` : `"${loginOrId.replace(/"/g, "")}"`;

    const data = await this.query<{
      user: {
        id: string;
        login?: string;
        displayName?: string;
        description?: string;
        profileImageURL?: string | null;
        followers?: { totalCount?: number } | null;
        stream?: {
          id: string;
          title?: string;
          viewersCount?: number;
          game?: { displayName?: string } | null;
        } | null;
      } | null;
    }>(
      `query { user(${field}: ${value}) { id login displayName description profileImageURL(width: 200) followers { totalCount } stream { id title viewersCount game { displayName } } } }`,
    );

    const user = data?.user;
    if (!user?.id) return null;

    return {
      id: user.id,
      login: user.login ?? null,
      displayName: user.displayName ?? null,
      description: user.description ?? null,
      avatar: user.profileImageURL ?? null,
      followers: user.followers?.totalCount ?? null,
      live: user.stream
        ? {
            id: user.stream.id,
            title: user.stream.title ?? "",
            viewers: user.stream.viewersCount ?? null,
            game: user.stream.game?.displayName ?? null,
          }
        : null,
    };
  }

  /**
   * The channels an account follows.
   *
   * This is the subscriptions list — the Twitch equivalent of the YouTube
   * subscriptions the account-linking feature reads. It needs the account's own
   * user id, which the OAuth flow supplies.
   */
  async follows(userId: string, limit = 100): Promise<TwitchFollow[]> {
    if (!userId) return [];

    const data = await this.query<{
      user: {
        follows?: {
          edges?: {
            node?: {
              id: string;
              login?: string;
              displayName?: string;
              profileImageURL?: string | null;
              followers?: { totalCount?: number } | null;
            };
          }[];
        } | null;
      } | null;
    }>(
      `query { user(id: "${userId}") { follows(first: ${Math.min(
        100,
        limit,
      )}) { edges { node { id login displayName profileImageURL(width: 100) followers { totalCount } } } } } }`,
    );

    const edges = data?.user?.follows?.edges ?? [];
    return edges
      .map((edge) => edge.node)
      .filter((node): node is NonNullable<typeof node> => !!node?.id)
      .map((node) => ({
        id: node.id,
        login: node.login ?? null,
        displayName: node.displayName ?? null,
        followers: node.followers?.totalCount ?? null,
        avatar: node.profileImageURL ?? null,
      }));
  }
}
