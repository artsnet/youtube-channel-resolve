import { channelPageComplete, extractChannelMeta, extractVideoChannelRef, watchPageComplete } from "./extract.js";
import { channelUrlFor, parseYouTubeInput, youtubePageHosts } from "./parse.js";
import { VERSION } from "./version.js";

export type ResolvedYouTubeChannel = {
  /** `UC…` channel ID. */
  channelId: string;
  /** `https://www.youtube.com/channel/UC…`. */
  channelUrl: string;
  /** Channel display name as YouTube renders it, at most 120 characters. */
  name: string;
  /** Avatar on a YouTube CDN host, or `null` when the page had none. */
  avatarUrl: string | null;
};

export type YouTubeChannelResolveCode = "invalid-input" | "not-found" | "unavailable";

export type ResolveOptions = {
  /** Replacement for the global `fetch` (tests, proxies, Workers service bindings). */
  fetcher?: typeof fetch;
  /** Per-request timeout. Default 8000. */
  timeoutMs?: number;
  /**
   * The `User-Agent` sent to YouTube. Set this to something that identifies *your* application and
   * gives YouTube a way to contact you. The default names only this library.
   */
  userAgent?: string;
  /** `Accept-Language` sent to YouTube. Default `en`. Affects only localized channel names. */
  acceptLanguage?: string;
};

export class YouTubeChannelResolveError extends Error {
  readonly code: YouTubeChannelResolveCode;

  constructor(code: YouTubeChannelResolveCode, options?: { cause?: unknown }) {
    super(`YouTube channel resolve failed: ${code}`, options);
    this.name = "YouTubeChannelResolveError";
    this.code = code;
  }
}

export const DEFAULT_USER_AGENT = `youtube-channel-resolve/${VERSION} (+https://github.com/artsnet/youtube-channel-resolve)`;
export const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_BYTES = 3_000_000;

type FetchResult = { status: number; finalUrl: string; text: string };
type StopWhen = (window: string) => boolean;

/** How much of the previously-scanned text is carried forward so a marker split across a chunk
 * boundary is still found. The author block extract.ts looks for is roughly 200 bytes, so 512
 * characters leaves ample room. */
const STOP_WINDOW_TAIL_LENGTH = 512;

/**
 * Computes the bounded window `stopWhen` should scan for the next chunk, and the tail to carry
 * into the chunk after that. `window` is only ever `tail + chunk` — never the whole document — so
 * the per-chunk stop check stays cheap regardless of how much has been read so far.
 */
export function nextStopWindow(previousTail: string, chunk: string): { window: string; tail: string } {
  const window = previousTail + chunk;
  return { window, tail: window.slice(-STOP_WINDOW_TAIL_LENGTH) };
}

function pageHeaders(options: ResolveOptions): Record<string, string> {
  return {
    Accept: "text/html",
    "Accept-Language": options.acceptLanguage ?? "en",
    "User-Agent": options.userAgent ?? DEFAULT_USER_AGENT,
    // Skips the EU consent interstitial, which would otherwise hide the channel metadata.
    Cookie: "SOCS=CAI",
  };
}

async function assertYouTubePage(response: { status: number; body: ReadableStream<Uint8Array> | null }, finalUrl: string): Promise<void> {
  let host = "";
  try {
    host = new URL(finalUrl).hostname.toLowerCase();
  } catch {
    await response.body?.cancel().catch(() => {});
    throw new YouTubeChannelResolveError("unavailable");
  }
  // consent.youtube.com and google.com/sorry are interstitials, not the requested page.
  if (!youtubePageHosts.has(host)) {
    await response.body?.cancel().catch(() => {});
    throw new YouTubeChannelResolveError("unavailable");
  }
  if (response.status === 404) {
    await response.body?.cancel().catch(() => {});
    throw new YouTubeChannelResolveError("not-found");
  }
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => {});
    throw new YouTubeChannelResolveError("unavailable");
  }
}

/**
 * Reads the response incrementally, stopping as soon as `stopWhen` says the metadata we need has
 * fully arrived (the metadata is not confined to any fixed prefix of the page — YouTube renders it
 * well into the body) or once the byte cap is hit. Chunks are kept in an array and joined once, at
 * the end, so the accumulated text is never re-copied on every chunk; `stopWhen` only ever sees a
 * bounded `tail + chunk` window (see `nextStopWindow`), never the whole document, so its cost does
 * not grow with how much has been read. The real (regex-based) extraction runs exactly once, by
 * the caller, on the final joined text.
 *
 * Status and the final (post-redirect) host are checked before any body bytes are read, and the
 * body is cancelled before throwing in that case, so a 404/5xx/interstitial response never streams
 * up to the byte cap.
 */
async function fetchUntil(url: string, options: ResolveOptions, stopWhen: StopWhen): Promise<FetchResult> {
  const fetcher = options.fetcher ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const response = await fetcher(url, { headers: pageHeaders(options), redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
  const finalUrl = response.url || url;
  await assertYouTubePage(response, finalUrl);
  if (!response.body) return { status: response.status, finalUrl, text: "" };

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let tail = "";
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      const chunkText = decoder.decode(value, { stream: true });
      parts.push(chunkText);
      const { window, tail: nextTail } = nextStopWindow(tail, chunkText);
      tail = nextTail;
      if (stopWhen(window) || bytes >= MAX_BYTES) {
        await reader.cancel().catch(() => {});
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }
  return { status: response.status, finalUrl, text: parts.join("") };
}

async function loadPage<T>(url: string, options: ResolveOptions, stopWhen: StopWhen, extract: (text: string) => T | null): Promise<T> {
  let page: FetchResult;
  try {
    page = await fetchUntil(url, options, stopWhen);
  } catch (error) {
    if (error instanceof YouTubeChannelResolveError) throw error;
    throw new YouTubeChannelResolveError("unavailable", { cause: error });
  }
  const found = extract(page.text);
  if (found === null) throw new YouTubeChannelResolveError("not-found");
  return found;
}

/**
 * Resolves a pasted channel URL, `@handle`, channel ID, or video URL to the channel it belongs to,
 * by reading the public page only (no Data API, no key, no quota).
 *
 * Makes one request for a channel reference and two for a video reference (watch page, then the
 * channel page). Throws `YouTubeChannelResolveError` with `code` `invalid-input` (not a YouTube
 * reference, no request made), `not-found` (404 or no channel metadata on the page), or
 * `unavailable` (timeout, network failure, non-200, or an interstitial such as the consent page).
 */
export async function resolveYouTubeChannel(input: string, options: ResolveOptions = {}): Promise<ResolvedYouTubeChannel> {
  const parsed = parseYouTubeInput(input);
  if (!parsed) throw new YouTubeChannelResolveError("invalid-input");

  let channelPageUrl = parsed.url;
  if (parsed.kind === "video") {
    const ref = await loadPage(parsed.url, options, watchPageComplete, extractVideoChannelRef);
    channelPageUrl = ref.kind === "id" ? channelUrlFor(ref.channelId) : ref.url;
  }

  const meta = await loadPage(channelPageUrl, options, channelPageComplete, extractChannelMeta);
  return { ...meta, channelUrl: channelUrlFor(meta.channelId) };
}

export type ResolverOptions = ResolveOptions & {
  /** How many resolves may be in flight at once. Default 1. */
  concurrency?: number;
  /** Minimum gap between the *start* of consecutive resolves, in milliseconds. Default 1000. */
  minIntervalMs?: number;
  /** Clock and sleep, injectable for tests. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

export type YouTubeChannelResolver = {
  /** Resolves one input, queued behind the resolver's concurrency and interval limits. */
  resolve(input: string): Promise<ResolvedYouTubeChannel>;
  /** The effective limits, for diagnostics. */
  readonly limits: { concurrency: number; minIntervalMs: number };
};

const defaultSleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/**
 * Wraps `resolveYouTubeChannel` with a polite queue: at most `concurrency` resolves in flight and
 * at least `minIntervalMs` between the start of one resolve and the next. The CLI and the MCP
 * server use this so that batch use does not hammer YouTube; the defaults are deliberately
 * conservative and the caller has to opt into anything faster.
 */
export function createYouTubeChannelResolver(options: ResolverOptions = {}): YouTubeChannelResolver {
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? 1));
  const minIntervalMs = Math.max(0, options.minIntervalMs ?? 1_000);
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const { concurrency: _c, minIntervalMs: _m, now: _n, sleep: _s, ...resolveOptions } = options;

  let inFlight = 0;
  let lastStartedAt = Number.NEGATIVE_INFINITY;
  const waiting: Array<() => void> = [];

  const acquire = (): Promise<void> =>
    new Promise((release) => {
      if (inFlight < concurrency) {
        inFlight += 1;
        release();
      } else {
        waiting.push(() => {
          inFlight += 1;
          release();
        });
      }
    });

  const releaseSlot = (): void => {
    inFlight -= 1;
    waiting.shift()?.();
  };

  return {
    limits: { concurrency, minIntervalMs },
    async resolve(input: string): Promise<ResolvedYouTubeChannel> {
      // Reject bad input before taking a slot: no request is made for it, so it should not wait.
      if (!parseYouTubeInput(input)) throw new YouTubeChannelResolveError("invalid-input");
      await acquire();
      try {
        const gap = lastStartedAt + minIntervalMs - now();
        if (gap > 0) await sleep(gap);
        lastStartedAt = now();
        return await resolveYouTubeChannel(input, resolveOptions);
      } finally {
        releaseSlot();
      }
    },
  };
}
