import { z } from "zod";
import type { ResolvedYouTubeChannel, YouTubeChannelResolveCode } from "./resolve.js";
import { YouTubeChannelResolveError } from "./resolve.js";

/**
 * The JSON shape shared by the CLI (`--json`) and the MCP tool's structured content. Bump
 * `SCHEMA_VERSION` only for a breaking change to these shapes.
 */
export const SCHEMA_VERSION = 1 as const;

export const resultSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  ok: z.literal(true),
  input: z.string().describe("The input exactly as given"),
  channelId: z.string().describe("UC… channel ID"),
  channelUrl: z.string().describe("https://www.youtube.com/channel/UC…"),
  name: z.string().describe("Channel display name as YouTube renders it"),
  avatarUrl: z.string().nullable().describe("Avatar URL on a YouTube CDN host, or null"),
});

export const failureCodeSchema = z.enum(["invalid-input", "not-found", "unavailable"]);

export const failureSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  ok: z.literal(false),
  input: z.string(),
  error: z.object({
    code: failureCodeSchema,
    message: z.string(),
  }),
});

export const outputSchema = z.discriminatedUnion("ok", [resultSchema, failureSchema]);

export type ResolveResult = z.infer<typeof resultSchema>;
export type ResolveFailure = z.infer<typeof failureSchema>;
export type ResolveOutput = z.infer<typeof outputSchema>;

export const failureMessages: Record<YouTubeChannelResolveCode, string> = {
  "invalid-input": "Not a YouTube channel URL, @handle, channel ID, or video URL. No request was made.",
  "not-found": "YouTube returned 404 or the page carried no channel metadata.",
  "unavailable": "YouTube could not be reached, timed out, returned a non-200 status, or served an interstitial page.",
};

export function toResult(input: string, channel: ResolvedYouTubeChannel): ResolveResult {
  return { schemaVersion: SCHEMA_VERSION, ok: true, input, ...channel };
}

/** Maps any thrown value to a failure record; non-resolver errors become `unavailable`. */
export function toFailure(input: string, error: unknown): ResolveFailure {
  const code: YouTubeChannelResolveCode = error instanceof YouTubeChannelResolveError ? error.code : "unavailable";
  return { schemaVersion: SCHEMA_VERSION, ok: false, input, error: { code, message: failureMessages[code] } };
}
