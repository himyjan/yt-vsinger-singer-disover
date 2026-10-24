/**
 * Web-search link discovery — the optional fallback.
 *
 * Everything else in `link-discovery.ts` reads something the performer wrote:
 * a description, a bio, a wiki page. That covers a lot, and it covers nothing
 * for the performer who publishes only on Bilibili and has never written their
 * YouTube URL down in a place this project can read.
 *
 * For those, the only way to find the account is to **search the web** for it.
 * This module asks a search-grounded model for the performer's official
 * accounts, and returns the URLs as **candidates** — never as facts. The
 * caller still resolves each one and requires the profile to confirm the
 * identity, so a wrong search result is rejected rather than written down.
 *
 * It needs `GEMINI_API_KEY` and is off by default (`--web`), because it costs
 * a model call per channel and because the deterministic passes answer most
 * of the catalogue.
 */

import { GoogleGenAI, type GenerateContentConfig } from "@google/genai";

export interface WebLinkFinderOptions {
  apiKey: string;
  /** Model to use. The free tier of the default is enough. */
  model?: string;
  /** Whether Google Search grounding is enabled. Defaults to true. */
  useSearch?: boolean;
  /** Minimum model confidence for the answer to be used. */
  minConfidence?: number;
  /** Milliseconds between requests. */
  delayMs?: number;
  onLog?: (message: string) => void;
}

/** What the model found. */
export interface WebLinkResult {
  /** YouTube channel URLs or ids. */
  youtube: string[];
  /** Twitch login URLs. */
  twitch: string[];
  /** X / Twitter profile URLs. */
  x: string[];
  /** The model's confidence in the answer, 0–1. */
  confidence: number;
  /** One or two sentences on what it found and where. */
  reasoning: string;
  /** The pages it actually read. */
  sources: string[];
}

export interface WebLinkRequest {
  name: string;
  aliases: string[];
  region: string;
  /** The platform URLs the record already has, to give the search a anchor. */
  knownUrls: string[];
}

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    youtube: {
      type: "array",
      items: { type: "string" },
      description:
        "Official YouTube channel URLs (youtube.com/channel/UC… or youtube.com/@handle). Empty when there is none.",
    },
    twitch: {
      type: "array",
      items: { type: "string" },
      description: "Official Twitch channel URLs. Empty when there is none.",
    },
    x: {
      type: "array",
      items: { type: "string" },
      description: "Official X / Twitter profile URLs. Empty when there is none.",
    },
    confidence: {
      type: "number",
      description: "Your confidence that these are the same performer, 0 to 1.",
    },
    reasoning: { type: "string", description: "One or two sentences." },
  },
  required: ["youtube", "twitch", "x", "reasoning"],
} as const;

function buildPrompt(request: WebLinkRequest): string {
  return [
    "You are finding the official accounts of a virtual singer or VTuber.",
    "",
    "The performer is catalogued under their Bilibili account, and the catalogue",
    "has no YouTube or Twitch link for them. Find those accounts if they exist.",
    "",
    "## The performer",
    `Name: ${request.name}`,
    `Also known as: ${request.aliases.slice(0, 8).join(", ") || "(none)"}`,
    `Region: ${request.region}`,
    `Known accounts: ${request.knownUrls.slice(0, 6).join(", ") || "(none)"}`,
    "",
    "## Rules",
    "- Search the web. Only return accounts you can confirm belong to THIS performer.",
    "- A same-name account is not enough: check that its description, links or",
    "  agency page points back at the known account above.",
    "- Prefer the official channel over a fan, clip or re-upload channel.",
    "- Return an empty list rather than guessing.",
    "- Put the URLs in `youtube`, `twitch` and `x`; explain briefly in `reasoning`.",
  ].join("\n");
}

export class WebLinkFinder {
  private readonly client: GoogleGenAI;
  private readonly model: string;
  private readonly useSearch: boolean;
  private readonly minConfidence: number;
  private readonly delayMs: number;
  private readonly onLog: (message: string) => void;

  constructor(options: WebLinkFinderOptions) {
    this.client = new GoogleGenAI({ apiKey: options.apiKey });
    this.model = options.model ?? "gemini-2.5-flash";
    this.useSearch = options.useSearch ?? true;
    this.minConfidence = options.minConfidence ?? 0.6;
    this.delayMs = options.delayMs ?? 1200;
    this.onLog = options.onLog ?? (() => {});
  }

  /** Searches for one performer. Returns `null` when nothing usable came back. */
  async find(request: WebLinkRequest): Promise<WebLinkResult | null> {
    const config: GenerateContentConfig = {
      systemInstruction:
        "You find the official accounts of performers using web search. " +
        "You cite what you found, and you return nothing rather than guessing.",
      ...(this.useSearch ? { tools: [{ googleSearch: {} }] } : {}),
      responseMimeType: "application/json",
      responseJsonSchema: RESPONSE_SCHEMA,
      temperature: 0,
    };

    try {
      const response = await this.client.models.generateContent({
        model: this.model,
        contents: buildPrompt(request),
        config,
      });

      const text = response.text ?? "";
      if (!text) return null;

      let parsed: {
        youtube?: unknown;
        twitch?: unknown;
        x?: unknown;
        confidence?: unknown;
        reasoning?: unknown;
      };
      try {
        parsed = JSON.parse(text);
      } catch {
        this.onLog(`  ! unparseable search result for ${request.name}`);
        return null;
      }

      const list = (value: unknown): string[] =>
        Array.isArray(value)
          ? value
              .filter((item): item is string => typeof item === "string")
              .map((item) => item.trim())
              .filter(Boolean)
              .slice(0, 4)
          : [];

      const result: WebLinkResult = {
        youtube: list(parsed.youtube),
        twitch: list(parsed.twitch),
        x: list(parsed.x),
        confidence: clamp01(Number(parsed.confidence ?? 0)),
        reasoning: String(parsed.reasoning ?? "").slice(0, 400),
        sources: groundingSources(response),
      };

      if (result.confidence < this.minConfidence) return null;
      if (
        !result.youtube.length &&
        !result.twitch.length &&
        !result.x.length
      ) {
        return null;
      }
      return result;
    } catch (err) {
      this.onLog(
        `  ! search failed for ${request.name}: ${(err as Error).message}`,
      );
      return null;
    }
  }

  /** Waits between requests so a batch does not trip a rate limit. */
  async throttle(): Promise<void> {
    if (this.delayMs <= 0) return;
    await new Promise((resolve) => setTimeout(resolve, this.delayMs));
  }
}

function groundingSources(response: unknown): string[] {
  const candidates = (response as { candidates?: unknown[] })?.candidates;
  const metadata = (candidates?.[0] as { groundingMetadata?: unknown })
    ?.groundingMetadata as { groundingChunks?: unknown[] } | undefined;
  const out: string[] = [];
  for (const chunk of metadata?.groundingChunks ?? []) {
    const uri =
      (chunk as { web?: { uri?: string; url?: string } })?.web?.uri ??
      (chunk as { web?: { uri?: string; url?: string } })?.web?.url;
    if (typeof uri === "string" && uri) out.push(uri);
  }
  return out.slice(0, 6);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}
