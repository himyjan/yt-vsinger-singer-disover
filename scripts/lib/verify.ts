/**
 * Data verification with web search grounding.
 *
 * The keyword classifier is fast, free and deterministic — but it is wrong
 * often enough to matter. A channel named "Bainju" tells you nothing; a
 * channel called "Kaya Nishikino Ch." could be a VTuber, a singer, or a
 * fan account.
 *
 * This module asks a grounding-capable model — one that can **search the
 * web** and cite what it found — to verify each channel, and turns the
 * answer into a correction.
 *
 * ## Why grounding rather than a plain model
 *
 * A model asked "is 富士葵 a VTuber?" from memory will answer from stale
 * priors and will happily invent a gender. A model with Google Search
 * grounding looks the channel up, reads the agency's own site, and answers
 * from what it actually found. That is the difference between a guess and a
 * verification.
 *
 * ## Why corrections, not direct writes
 *
 * The verifier never edits a record directly. It writes an **override** into
 * `data/overrides.json`, which the normal sync then applies. The result is
 * that a verification run is fully reviewable — `git diff data/overrides.json`
 * shows exactly what was changed and why — and that a wrong verification can
 * be reverted by deleting one entry.
 *
 * ## Confidence
 *
 * The model returns a confidence for each field. Corrections below the
 * threshold are discarded, because a wrong correction is worse than no
 * correction: it silently overrides the deterministic classifier.
 */

import { GoogleGenAI, type GenerateContentConfig } from "@google/genai";
import type { ArtistKind, ArtistRole, Gender, RegionCode } from "./types";

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

export interface VerificationRequest {
  id: string;
  name: string;
  handle: string | null;
  description: string | null;
  tags: string[];
  /** The classifier's current guess, shown to the model as a prior. */
  current: {
    kind: ArtistKind;
    role: ArtistRole;
    region: RegionCode;
    gender: Gender;
    isAi: boolean;
    confidence: number;
  };
}

export interface VerificationResult {
  id: string;
  kind: ArtistKind | null;
  role: ArtistRole | null;
  region: RegionCode | null;
  gender: Gender | null;
  isAi: boolean | null;
  /** The model's confidence in the answer, 0–1. */
  confidence: number;
  /** A short explanation, and the source the model relied on. */
  reasoning: string;
  /** URLs the model actually read. */
  sources: string[];
  /** True when the channel does not appear to be a performer at all. */
  isAggregator: boolean;
}

export interface VerifierOptions {
  /** Gemini API key. */
  apiKey: string;
  /** Model to use. */
  model?: string;
  /** Minimum confidence for a correction to be accepted. */
  minConfidence?: number;
  /** Whether to enable Google Search grounding. */
  useSearch?: boolean;
  /** Milliseconds between requests. */
  delayMs?: number;
  onLog?: (message: string) => void;
}

/* -------------------------------------------------------------------------- */
/* The prompt                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The response schema. Using a schema rather than free text means the
 * answer is always machine-readable, and the model's confidence is captured
 * alongside the answer rather than inferred from prose.
 */
const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    kind: {
      type: "string",
      enum: ["virtual", "real", "unknown"],
      description:
        "'virtual' for a VTuber/VSinger/virtual idol, 'real' for a real human singer or producer.",
    },
    role: {
      type: "string",
      enum: [
        "vtuber",
        "vsinger",
        "singer",
        "musician",
        "producer",
        "composer",
        "unknown",
      ],
    },
    region: {
      type: "string",
      enum: [
        "jp",
        "cn",
        "tw",
        "hk",
        "kr",
        "en",
        "id",
        "my",
        "sea",
        "unknown",
      ],
    },
    gender: {
      type: "string",
      enum: ["female", "male", "unknown"],
      description:
        "Only answer female or male if the channel states it. Otherwise 'unknown'.",
    },
    isAi: {
      type: "boolean",
      description:
        "True for AI-generated performers, AI VTubers, AI singers and synthesised voices.",
    },
    isAggregator: {
      type: "boolean",
      description:
        "True for fan/clip/compilation channels that re-upload other creators' work.",
    },
    confidence: {
      type: "number",
      description:
        "Your confidence in the answer, from 0 to 1. Be conservative.",
    },
    reasoning: {
      type: "string",
      description: "One or two sentences explaining what you found.",
    },
  },
  required: [
    "kind",
    "role",
    "region",
    "gender",
    "isAi",
    "isAggregator",
    "confidence",
    "reasoning",
  ],
} as const;

function buildPrompt(request: VerificationRequest): string {
  const description = request.description
    ? request.description.slice(0, 800)
    : "(no description)";

  return [
    "You are verifying metadata about a YouTube channel that publishes singing content.",
    "",
    "Use Google Search to find out who this performer is. Prefer official sources:",
    "the performer's own channel, their agency's roster page, their official site,",
    "or a wiki page that cites them.",
    "",
    "## The channel",
    `Name: ${request.name}`,
    `Handle: ${request.handle ? "@" + request.handle : "(unknown)"}`,
    `URL: https://www.youtube.com/channel/${request.id}`,
    `Description: ${description}`,
    `Tags: ${request.tags.slice(0, 20).join(", ") || "(none)"}`,
    "",
    "## What we need to know",
    "1. `kind` — is this a virtual performer (VTuber / VSinger / virtual idol) or a real human artist?",
    "2. `role` — what do they do?",
    "3. `region` — which language area do they primarily perform in?",
    "4. `gender` — ONLY if the channel or agency states it. Otherwise 'unknown'.",
    "5. `isAi` — is the performer AI-generated (AI VTuber, AI singer, Synthesizer V / CeVIO AI voice)?",
    "6. `isAggregator` — is this a fan, clip or compilation channel rather than a performer?",
    "",
    "## Rules",
    "- If the search finds nothing conclusive, answer 'unknown' for that field and lower `confidence`.",
    "- Never guess a gender from a name or from a photo.",
    "- If the channel is a fan/clip/compilation channel, say so and set `kind` to 'unknown'.",
    "- Our current guess is shown for reference only. Correct it if the search disagrees.",
    "",
    `## Our current guess (may be wrong)`,
    `kind=${request.current.kind} role=${request.current.role} region=${request.current.region} gender=${request.current.gender} isAi=${request.current.isAi} confidence=${request.current.confidence.toFixed(2)}`,
  ].join("\n");
}

/* -------------------------------------------------------------------------- */
/* Verifier                                                                   */
/* -------------------------------------------------------------------------- */

export class Verifier {
  private readonly client: GoogleGenAI;
  private readonly model: string;
  private readonly minConfidence: number;
  private readonly useSearch: boolean;
  private readonly delayMs: number;
  private readonly onLog: (message: string) => void;

  constructor(options: VerifierOptions) {
    this.client = new GoogleGenAI({ apiKey: options.apiKey });
    this.model = options.model ?? "gemini-2.5-flash";
    this.minConfidence = options.minConfidence ?? 0.7;
    this.useSearch = options.useSearch ?? true;
    this.delayMs = options.delayMs ?? 1200;
    this.onLog = options.onLog ?? (() => {});
  }

  /**
   * Verifies one channel.
   *
   * Returns `null` when the model could not answer or the answer was not
   * usable — never throws for a content problem, only for a configuration
   * one.
   */
  async verify(request: VerificationRequest): Promise<VerificationResult | null> {
    const config: GenerateContentConfig = {
      systemInstruction:
        "You verify YouTube channel metadata using web search. You are precise, " +
        "you cite what you found, and you say 'unknown' rather than guessing.",
      contents: buildPrompt(request),
      ...(this.useSearch
        ? { tools: [{ googleSearch: {} }] }
        : {}),
      generationConfig: {
        responseMimeType: "application/json",
        responseJsonSchema: RESPONSE_SCHEMA,
        temperature: 0,
      },
    };

    try {
      const response = await this.client.models.generateContent({
        model: this.model,
        config,
      });

      const text = response.text ?? "";
      if (!text) return null;

      let parsed: any;
      try {
        parsed = JSON.parse(text);
      } catch {
        this.onLog(`  ! unparseable response for ${request.id}`);
        return null;
      }

      const grounding = (response.candidates?.[0] as any)?.groundingMetadata;
      const sources: string[] = [];
      const chunks = grounding?.groundingChunks ?? grounding?.webSearchQueries;
      if (Array.isArray(chunks)) {
        for (const chunk of chunks) {
          const uri = chunk?.web?.uri ?? chunk?.web?.url;
          if (uri) sources.push(uri);
        }
      }

      return {
        id: request.id,
        kind: normalizeEnum(parsed.kind, ["virtual", "real"]),
        role: normalizeEnum(parsed.role, [
          "vtuber",
          "vsinger",
          "singer",
          "musician",
          "producer",
          "composer",
        ]),
        region: normalizeEnum(parsed.region, [
          "jp",
          "cn",
          "tw",
          "hk",
          "kr",
          "en",
          "id",
          "my",
          "sea",
        ]),
        gender: normalizeEnum(parsed.gender, ["female", "male"]),
        isAi: typeof parsed.isAi === "boolean" ? parsed.isAi : null,
        isAggregator: parsed.isAggregator === true,
        confidence: clamp01(Number(parsed.confidence ?? 0)),
        reasoning: String(parsed.reasoning ?? "").slice(0, 400),
        sources: sources.slice(0, 6),
      };
    } catch (err) {
      this.onLog(`  ! verification failed for ${request.id}: ${(err as Error).message}`);
      return null;
    }
  }

  /** Waits between requests so a batch does not trip a rate limit. */
  async throttle(): Promise<void> {
    if (this.delayMs <= 0) return;
    await new Promise((resolve) => setTimeout(resolve, this.delayMs));
  }

  /**
   * Turns a verification result into an override object, or `null` when the
   * result is not confident enough to act on.
   */
  toOverride(
    result: VerificationResult,
    current: VerificationRequest["current"],
  ): Record<string, unknown> | null {
    if (result.confidence < this.minConfidence) return null;

    const override: Record<string, unknown> = {};
    if (result.kind && result.kind !== current.kind) override.kind = result.kind;
    if (result.role && result.role !== current.role) override.role = result.role;
    if (result.region && result.region !== current.region) {
      override.region = result.region;
    }
    if (result.gender && result.gender !== current.gender) {
      override.gender = result.gender;
    }
    if (result.isAi !== null && result.isAi !== current.isAi) {
      override.isAi = result.isAi;
    }
    if (result.isAggregator) {
      // An aggregator is not a performer: hide it and mark it unsinging.
      override.hidden = true;
      override.isSinging = false;
    }

    return Object.keys(override).length > 0 ? override : null;
  }
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function normalizeEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
): T | null {
  if (typeof value !== "string") return null;
  const lower = value.toLowerCase();
  return (allowed as readonly string[]).includes(lower) ? (lower as T) : null;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}
