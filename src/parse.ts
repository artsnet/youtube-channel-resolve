/** A YouTube channel ID: `UC` followed by 22 URL-safe base64 characters. */
export const youtubeChannelIdPattern = /^UC[A-Za-z0-9_-]{22}$/;

export type ParsedYouTubeInput = { kind: "channel" | "video"; url: string };

/** Hosts whose pages the resolver may fetch; anything else is rejected before any network call. */
export const youtubePageHosts: ReadonlySet<string> = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"]);

const MAX_INPUT_LENGTH = 200;
const HANDLE = /^@[A-Za-z0-9._-]{3,30}$/;
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const LEGACY_NAME = /^[A-Za-z0-9._-]{1,100}$/;

/** Builds the canonical `https://www.youtube.com/channel/UC…` URL for a channel ID. */
export function channelUrlFor(channelId: string): string {
  return `https://www.youtube.com/channel/${channelId}`;
}

function channel(path: string): ParsedYouTubeInput {
  return { kind: "channel", url: `https://www.youtube.com${path}` };
}

function video(videoId: string): ParsedYouTubeInput {
  return { kind: "video", url: `https://www.youtube.com/watch?v=${videoId}` };
}

/**
 * Normalizes a pasted URL, `@handle`, channel ID, or video URL to the single YouTube page to fetch.
 * Returns `null` for anything that is not a YouTube channel or video reference.
 */
export function parseYouTubeInput(raw: string): ParsedYouTubeInput | null {
  const input = raw.trim();
  if (!input || input.length > MAX_INPUT_LENGTH) return null;
  if (youtubeChannelIdPattern.test(input)) return channel(`/channel/${input}`);
  if (HANDLE.test(input)) return channel(`/${input}`);

  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (!youtubePageHosts.has(url.hostname.toLowerCase())) return null;

  let segments: string[];
  try {
    segments = url.pathname.split("/").filter(Boolean).map((segment) => decodeURIComponent(segment));
  } catch {
    return null; // malformed percent-encoding in the path
  }
  if (url.hostname.toLowerCase() === "youtu.be") {
    const id = segments[0] ?? "";
    return VIDEO_ID.test(id) ? video(id) : null;
  }
  const first = segments[0];
  const second = segments[1] ?? "";
  if (first === "watch") {
    const videoId = url.searchParams.get("v") ?? "";
    return VIDEO_ID.test(videoId) ? video(videoId) : null;
  }
  if ((first === "shorts" || first === "embed" || first === "live") && VIDEO_ID.test(second)) return video(second);
  if (first === "channel" && youtubeChannelIdPattern.test(second)) return channel(`/channel/${second}`);
  if ((first === "user" || first === "c") && LEGACY_NAME.test(second)) return channel(`/${first}/${second}`);
  if (first && HANDLE.test(first)) return channel(`/${first}`);
  return null;
}
