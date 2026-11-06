import { youtubeChannelIdPattern } from "./parse.js";
import { parseYouTubeInput } from "./parse.js";

export type ChannelMeta = { channelId: string; name: string; avatarUrl: string | null };
export type VideoChannelRef = { kind: "id"; channelId: string } | { kind: "url"; url: string };

const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&#x27;": "'", "&apos;": "'" };

function decodeEntities(value: string): string {
  return value.replace(/&(?:amp|lt|gt|quot|#39|#x27|apos);/g, (entity) => ENTITIES[entity] ?? entity);
}

// A tag ends at the first ">" that is not inside a quoted attribute value.
const TAG_PATTERN = /<(meta|link)\b((?:[^>"']|"[^"]*"|'[^']*')*)\/?>/gi;
const ATTRIBUTE_PATTERN = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;

type AttributeMap = Record<string, string>;

function parseAttributes(attrs: string): AttributeMap {
  const result: AttributeMap = {};
  for (const match of attrs.matchAll(ATTRIBUTE_PATTERN)) {
    const name = (match[1] ?? "").toLowerCase();
    const value = match[2] ?? match[3] ?? match[4] ?? "";
    result[name] = value;
  }
  return result;
}

/** Finds the first <kind> tag in text whose `attribute` equals `value`, returning its attribute map. */
function findTag(text: string, kind: "meta" | "link", attribute: string, value: string): AttributeMap | null {
  for (const match of text.matchAll(TAG_PATTERN)) {
    if ((match[1] ?? "").toLowerCase() !== kind) continue;
    const attrs = parseAttributes(match[2] ?? "");
    if (attrs[attribute] === value) return attrs;
  }
  return null;
}

const AVATAR_HOSTS = new Set(["yt3.ggpht.com", "yt3.googleusercontent.com", "i.ytimg.com"]);
const MAX_AVATAR_URL_LENGTH = 2048;
const MAX_NAME_LENGTH = 120;

/** Keeps an avatar URL only when it is a well-formed https URL on an allow-listed YouTube CDN host. */
function sanitizeAvatarUrl(value: string | undefined): string | null {
  if (!value || value.length > MAX_AVATAR_URL_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || !AVATAR_HOSTS.has(url.hostname)) return null;
  return value;
}

const CANONICAL_CHANNEL = /^https:\/\/www\.youtube\.com\/channel\/([^/?#]+)$/;

function canonicalChannelId(text: string): string | null {
  const href = findTag(text, "link", "rel", "canonical")?.href;
  if (!href) return null;
  const match = CANONICAL_CHANNEL.exec(href);
  return match?.[1] ?? null;
}

/**
 * Channel page: id from identifier/canonical, name from itemprop name or og:title, avatar from og:image.
 * The tags we need are not guaranteed to be inside <head> — YouTube also renders them into the body — so
 * this scans the whole page text handed to it.
 */
export function extractChannelMeta(html: string): ChannelMeta | null {
  const channelId =
    findTag(html, "meta", "itemprop", "identifier")?.content?.trim() ||
    findTag(html, "meta", "itemprop", "channelId")?.content?.trim() ||
    canonicalChannelId(html)?.trim() ||
    null;
  if (!channelId || !youtubeChannelIdPattern.test(channelId)) return null;
  const rawName =
    findTag(html, "meta", "itemprop", "name")?.content?.trim() ||
    findTag(html, "meta", "property", "og:title")?.content?.trim() ||
    null;
  if (!rawName) return null;
  const name = Array.from(decodeEntities(rawName)).slice(0, MAX_NAME_LENGTH).join("");
  if (!name) return null;
  const avatar = findTag(html, "meta", "property", "og:image")?.content?.trim();
  return {
    channelId,
    name,
    avatarUrl: sanitizeAvatarUrl(avatar ? decodeEntities(avatar) : undefined),
  };
}

const CHANNEL_ID_JSON = /"channelId":"(UC[A-Za-z0-9_-]{22})"/;

/** Index of the `itemprop="author"` (or `itemprop='author'`) marker at or after `from`, or -1. */
function indexOfAuthorMarker(text: string, from: number): number {
  const start = Math.max(0, from);
  const double = text.indexOf('itemprop="author"', start);
  const single = text.indexOf("itemprop='author'", start);
  if (double === -1) return single;
  if (single === -1) return double;
  return Math.min(double, single);
}

/**
 * Watch page: there is no reliable channel id meta tag any more. Priority is:
 *   (a) an explicit <meta itemprop="channelId"> (still seen on some pages);
 *   (b) the author's channel URL, from the <link itemprop="url"> inside the itemprop="author" block
 *       (never <meta itemprop="identifier">, which on a watch page is the *video* id);
 *   (c) the first `"channelId":"UC…"` JSON literal embedded in the page's inline data.
 */
export function extractVideoChannelRef(html: string): VideoChannelRef | null {
  const metaChannelId = findTag(html, "meta", "itemprop", "channelId")?.content?.trim();
  if (metaChannelId && youtubeChannelIdPattern.test(metaChannelId)) return { kind: "id", channelId: metaChannelId };

  const authorIndex = indexOfAuthorMarker(html, 0);
  if (authorIndex !== -1) {
    // Bound the search to the author block itself, so a <link itemprop="url"> that appears later
    // in the page (outside the author's <span>) is never mistaken for the channel's own link.
    const authorEnd = html.indexOf("</span>", authorIndex);
    const authorSection = authorEnd === -1 ? html.slice(authorIndex) : html.slice(authorIndex, authorEnd);
    for (const match of authorSection.matchAll(TAG_PATTERN)) {
      if ((match[1] ?? "").toLowerCase() !== "link") continue;
      const attrs = parseAttributes(match[2] ?? "");
      if (attrs.itemprop !== "url" || !attrs.href) continue;
      const parsed = parseYouTubeInput(attrs.href);
      if (parsed && parsed.kind === "channel") return { kind: "url", url: parsed.url };
    }
  }

  const jsonMatch = CHANNEL_ID_JSON.exec(html);
  if (jsonMatch?.[1]) return { kind: "id", channelId: jsonMatch[1] };

  return null;
}

/**
 * Cheap stop markers for the streaming reader in `resolve.ts`. Each scans only for a literal
 * marker (via `indexOf`, no regex) and confirms the tag/block it belongs to has actually closed —
 * a marker string alone can appear split across chunk boundaries or with its `>` not yet arrived.
 * They receive a bounded `window` (the previous window's tail plus the new chunk — see
 * `nextStopWindow` in resolve.ts), never the whole document, so both the marker and the closing
 * `>`/`</span>` must be found within that window. These are optimizations only: the real
 * extraction still runs once, on the accumulated text.
 */

/** True once `itemprop="identifier"` (the last channel-page tag we need) has fully arrived in `window`. */
export function channelPageComplete(window: string): boolean {
  const idx = window.indexOf('itemprop="identifier"');
  if (idx === -1) return false;
  return window.indexOf(">", idx) !== -1;
}

/**
 * True once either the `itemprop="channelId"` meta tag has closed within `window`, or the
 * `itemprop="author"` block has closed with `</span>` within `window`.
 */
export function watchPageComplete(window: string): boolean {
  const channelIdIndex = window.indexOf('itemprop="channelId"');
  if (channelIdIndex !== -1 && window.indexOf(">", channelIdIndex) !== -1) return true;

  const authorIndex = indexOfAuthorMarker(window, 0);
  if (authorIndex !== -1 && window.indexOf("</span>", authorIndex) !== -1) return true;

  return false;
}
