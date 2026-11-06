import { describe, expect, it, vi } from "vitest";
import { DEFAULT_USER_AGENT, nextStopWindow, resolveYouTubeChannel, YouTubeChannelResolveError } from "../src/resolve.js";

const channelId = "UCBR8-60-B28hp2BmDPdntcQ";
const channelHead = `<html><head><meta itemprop="identifier" content="${channelId}"><meta itemprop="name" content="Example Channel"><meta property="og:image" content="https://yt3.googleusercontent.com/a"></head>`;
const watchHeadWithChannelId = `<html><head><meta itemprop="channelId" content="${channelId}"></head>`;
const watchPageWithAuthorLink = `<html><head><meta itemprop="identifier" content="dQw4w9WgXcQ"></head><body>
<span itemprop="author" itemscope itemtype="http://schema.org/Person">
<link itemprop="url" href="https://www.youtube.com/@Example">
</span>
</body></html>`;

function page(html: string, init: { status?: number; url?: string } = {}): Response {
  const response = new Response(html, { status: init.status ?? 200, headers: { "content-type": "text/html" } });
  if (init.url) Object.defineProperty(response, "url", { value: init.url });
  return response;
}

async function failure(promise: Promise<unknown>): Promise<string> {
  try { await promise; } catch (error) { if (error instanceof YouTubeChannelResolveError) return error.code; throw error; }
  throw new Error("expected a resolve failure");
}

describe("resolveYouTubeChannel", () => {
  it("fetches a channel page once with identifying headers and returns the metadata", async () => {
    const fetcher = vi.fn(async () => page(channelHead));
    const result = await resolveYouTubeChannel("https://www.youtube.com/@Example", { fetcher: fetcher as unknown as typeof fetch });

    expect(result).toEqual({ channelId, channelUrl: `https://www.youtube.com/channel/${channelId}`, name: "Example Channel", avatarUrl: "https://yt3.googleusercontent.com/a" });
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://www.youtube.com/@Example");
    expect(init.headers).toMatchObject({ "User-Agent": DEFAULT_USER_AGENT, "Accept-Language": "en", Cookie: "SOCS=CAI" });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("follows a video URL to its channel page via the author link when there is no channel id meta", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(page(watchPageWithAuthorLink))
      .mockResolvedValueOnce(page(channelHead));
    const result = await resolveYouTubeChannel("https://youtu.be/dQw4w9WgXcQ", { fetcher: fetcher as unknown as typeof fetch });

    expect(result.channelId).toBe(channelId);
    expect(fetcher.mock.calls.map((call) => call[0])).toEqual(["https://www.youtube.com/watch?v=dQw4w9WgXcQ", "https://www.youtube.com/@Example"]);
  });

  it("follows a video URL to its channel page via the channel id meta when present", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(page(watchHeadWithChannelId))
      .mockResolvedValueOnce(page(channelHead));
    const result = await resolveYouTubeChannel("https://youtu.be/dQw4w9WgXcQ", { fetcher: fetcher as unknown as typeof fetch });

    expect(result.channelId).toBe(channelId);
    expect(fetcher.mock.calls.map((call) => call[0])).toEqual(["https://www.youtube.com/watch?v=dQw4w9WgXcQ", `https://www.youtube.com/channel/${channelId}`]);
  });

  it("classifies failures", async () => {
    const fetcherFor = (response: Response | Error) => (async () => { if (response instanceof Error) throw response; return response; }) as unknown as typeof fetch;

    expect(await failure(resolveYouTubeChannel("https://example.com/x", { fetcher: fetcherFor(page(channelHead)) }))).toBe("invalid-input");
    expect(await failure(resolveYouTubeChannel("@Missing", { fetcher: fetcherFor(page("<html><head></head>", { status: 404 })) }))).toBe("not-found");
    expect(await failure(resolveYouTubeChannel("@NoId", { fetcher: fetcherFor(page("<html><head><meta property=\"og:title\" content=\"YouTube\"></head>")) }))).toBe("not-found");
    expect(await failure(resolveYouTubeChannel("@Consent", { fetcher: fetcherFor(page(channelHead, { url: "https://consent.youtube.com/m?continue=x" })) }))).toBe("unavailable");
    expect(await failure(resolveYouTubeChannel("@Sorry", { fetcher: fetcherFor(page("<html></html>", { url: "https://www.google.com/sorry/index" })) }))).toBe("unavailable");
    expect(await failure(resolveYouTubeChannel("@Down", { fetcher: fetcherFor(page("", { status: 503 })) }))).toBe("unavailable");
    expect(await failure(resolveYouTubeChannel("@Timeout", { fetcher: fetcherFor(new DOMException("aborted", "AbortError")) }))).toBe("unavailable");
  });

  it("stops reading once the channel metadata is found and cancels the rest", async () => {
    const cancel = vi.fn();
    const chunks = [
      "<html><head><title>x</title></head><body>",
      `<link rel="canonical" href="https://www.youtube.com/channel/${channelId}"><meta property="og:title" content="Example Channel"><meta itemprop="name" content="Example Channel"><meta property="og:image" content="https://yt3.googleusercontent.com/a"><meta itemprop="identifier" content="${channelId}">`,
      "x".repeat(10_000) + "</body></html>",
    ];
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        const next = chunks.shift();
        if (next === undefined) controller.close();
        else controller.enqueue(new TextEncoder().encode(next));
      },
      cancel,
    });
    const fetcher = (async () => new Response(stream, { status: 200 })) as unknown as typeof fetch;

    await expect(resolveYouTubeChannel("@Example", { fetcher })).resolves.toMatchObject({ channelId });
    expect(cancel).toHaveBeenCalled();
  });

  it("keeps the avatar when a chunk boundary splits the og:image tag", async () => {
    const cancel = vi.fn();
    const chunks = [
      `<html><head></head><body><link rel="canonical" href="https://www.youtube.com/channel/${channelId}"><meta property="og:title" content="Example Channel"><meta property="og:image" content="https://yt3.googleusercontent.com/av`,
      `atar"><meta itemprop="name" content="Example Channel"><meta itemprop="identifier" content="${channelId}">`,
      "x".repeat(10_000),
    ];
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        const next = chunks.shift();
        if (next === undefined) controller.close();
        else controller.enqueue(new TextEncoder().encode(next));
      },
      cancel,
    });
    const fetcher = (async () => new Response(stream, { status: 200 })) as unknown as typeof fetch;

    const result = await resolveYouTubeChannel("@Example", { fetcher });
    expect(result.avatarUrl).toBe("https://yt3.googleusercontent.com/avatar");
    expect(cancel).toHaveBeenCalled();
  });

  it("stops near the byte cap on a page with no channel metadata, without reading it all", async () => {
    const cancel = vi.fn();
    const chunk = "x".repeat(64_000);
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new TextEncoder().encode(chunk));
      },
      cancel,
    });
    const fetcher = (async () => new Response(stream, { status: 200 })) as unknown as typeof fetch;

    expect(await failure(resolveYouTubeChannel("@Huge", { fetcher }))).toBe("not-found");
    expect(pulls).toBeLessThanOrEqual(49);
    expect(cancel).toHaveBeenCalled();
  });

  it("classifies a 404 as not-found without reading its body", async () => {
    // The stream's own `pull` fires once automatically to fill its internal queue (a spec detail of
    // ReadableStream, independent of any reader) but must never be driven further by our code, which
    // would happen if `fetchUntil` called `reader.read()` to stream a 404 body toward the 3 MB cap.
    const cancel = vi.fn();
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new TextEncoder().encode("x".repeat(64_000)));
      },
      cancel,
    });
    const fetcher = (async () => new Response(stream, { status: 404 })) as unknown as typeof fetch;

    expect(await failure(resolveYouTubeChannel("@Missing", { fetcher }))).toBe("not-found");
    // Exactly the one automatic pull from stream construction — our code never calls `reader.read()`.
    expect(pulls).toBe(1);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("stops near the byte cap on a page with no channel metadata, in small 4 KB chunks", async () => {
    const cancel = vi.fn();
    const chunk = "x".repeat(4_000);
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new TextEncoder().encode(chunk));
      },
      cancel,
    });
    const fetcher = (async () => new Response(stream, { status: 200 })) as unknown as typeof fetch;

    // ~750 chunks to the 3 MB cap. Each chunk's stop check only ever scans a bounded tail+chunk
    // window (see `nextStopWindow`), never the whole accumulated text, so per-chunk cost here does
    // not grow with how much has already been read (unlike an `indexOf` over the full rope).
    expect(await failure(resolveYouTubeChannel("@Huge4k", { fetcher }))).toBe("not-found");
    expect(pulls).toBeGreaterThan(700);
    expect(pulls).toBeLessThanOrEqual(751);
    expect(cancel).toHaveBeenCalled();
  });
});

describe("nextStopWindow", () => {
  it("prepends the previous tail to the new chunk", () => {
    expect(nextStopWindow("abc", "def")).toEqual({ window: "abcdef", tail: "abcdef" });
  });

  it("caps the tail at the last 512 characters of the window", () => {
    const chunk = "y".repeat(600);
    const { tail } = nextStopWindow("x".repeat(100), chunk);
    expect(tail).toHaveLength(512);
    expect(tail).toBe(chunk.slice(-512));
  });

  it("keeps a marker split across the tail/chunk boundary intact in the next window", () => {
    const marker = 'itemprop="identifier"';
    const prefix = marker.slice(0, 10);
    const suffix = marker.slice(10);
    const { tail } = nextStopWindow("padding-before", prefix);
    const { window } = nextStopWindow(tail, `${suffix}>`);
    expect(window).toContain(`${marker}>`);
  });
});

describe("resolveYouTubeChannel options", () => {
  it("sends a caller-supplied User-Agent and Accept-Language and never names a default operator", async () => {
    const fetcher = vi.fn(async () => page(channelHead));
    await resolveYouTubeChannel("@Example", { fetcher: fetcher as unknown as typeof fetch, userAgent: "MyApp/2.0 (contact@example.com)", acceptLanguage: "ja" });
    const [, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.headers).toMatchObject({ "User-Agent": "MyApp/2.0 (contact@example.com)", "Accept-Language": "ja" });
    expect(DEFAULT_USER_AGENT).toMatch(/^youtube-channel-resolve\//);
    // The product token names this library, not any operator; the URL only points at the source.
    expect(DEFAULT_USER_AGENT.split("/")[0]).toBe("youtube-channel-resolve");
  });

  it("keeps the underlying error as the cause of an unavailable failure", async () => {
    const boom = new TypeError("fetch failed");
    const fetcher = (async () => { throw boom; }) as unknown as typeof fetch;
    await expect(resolveYouTubeChannel("@Example", { fetcher })).rejects.toMatchObject({ code: "unavailable", cause: boom });
  });
});
