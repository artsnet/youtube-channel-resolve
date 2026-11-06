import { describe, expect, it } from "vitest";
import { channelPageComplete, extractChannelMeta, extractVideoChannelRef, watchPageComplete } from "../src/extract.js";
import { nextStopWindow } from "../src/resolve.js";

const channelId = "UCBR8-60-B28hp2BmDPdntcQ";

const channelPage = `<!DOCTYPE html><html><head>
<meta property="og:image" content="https://yt3.googleusercontent.com/avatar=s900-c-k-c0x00ffffff-no-rj">
<meta itemprop="name" content="Rock &amp; Roll &#39;Channel&#39;">
<meta property="og:title" content="Rock &amp; Roll &#39;Channel&#39;">
<link rel="canonical" href="https://www.youtube.com/channel/${channelId}">
<meta itemprop="identifier" content="${channelId}">
</head><body>ignored</body></html>`;

const watchPage = `<html><head><meta property="og:title" content="A video title">
<meta itemprop="channelId" content="${channelId}"></head><body></body></html>`;

const consentPage = `<html><head><title>Before you continue to YouTube</title><meta property="og:title" content="YouTube"></head></html>`;

describe("extractChannelMeta", () => {
  it("reads the channel id, decoded name, and avatar from a channel page head", () => {
    expect(extractChannelMeta(channelPage)).toEqual({
      channelId,
      name: "Rock & Roll 'Channel'",
      avatarUrl: "https://yt3.googleusercontent.com/avatar=s900-c-k-c0x00ffffff-no-rj",
    });
  });

  it("extracts metadata that sits in the body, after </head>", () => {
    const html = `<html><head><title>YouTube</title></head><body>
<link rel="canonical" href="https://www.youtube.com/channel/${channelId}">
<meta property="og:title" content="YouTube">
<meta property="og:image" content="https://yt3.googleusercontent.com/avatar">
<meta itemprop="name" content="YouTube">
<meta itemprop="identifier" content="${channelId}">
</body></html>`;
    expect(extractChannelMeta(html)).toEqual({
      channelId,
      name: "YouTube",
      avatarUrl: "https://yt3.googleusercontent.com/avatar",
    });
  });

  it("falls back to the canonical link when itemprop metadata is missing", () => {
    const html = `<head><link rel="canonical" href="https://www.youtube.com/channel/${channelId}"><meta property="og:title" content="Name"></head>`;
    expect(extractChannelMeta(html)).toEqual({ channelId, name: "Name", avatarUrl: null });
  });

  it("returns null without a valid channel id or a name", () => {
    expect(extractChannelMeta(consentPage)).toBeNull();
    expect(extractChannelMeta(`<head><meta itemprop="identifier" content="${channelId}"></head>`)).toBeNull();
    expect(extractChannelMeta(`<head><meta itemprop="identifier" content="bad"><meta itemprop="name" content="x"></head>`)).toBeNull();
  });

  it("ignores an http avatar", () => {
    const html = `<head><meta itemprop="identifier" content="${channelId}"><meta itemprop="name" content="N"><meta property="og:image" content="http://insecure/img"></head>`;
    expect(extractChannelMeta(html)?.avatarUrl).toBeNull();
  });

  it("ignores an avatar hosted outside the YouTube CDN allow-list", () => {
    const html = `<head><meta itemprop="identifier" content="${channelId}"><meta itemprop="name" content="N"><meta property="og:image" content="https://evil.example/x.png"></head>`;
    expect(extractChannelMeta(html)?.avatarUrl).toBeNull();
  });

  it("keeps an avatar hosted on an allow-listed YouTube CDN host", () => {
    const html = `<head><meta itemprop="identifier" content="${channelId}"><meta itemprop="name" content="N"><meta property="og:image" content="https://yt3.ggpht.com/x"></head>`;
    expect(extractChannelMeta(html)?.avatarUrl).toBe("https://yt3.ggpht.com/x");
  });

  it("truncates a very long name to 120 characters", () => {
    const longName = "A".repeat(300);
    const html = `<head><meta itemprop="identifier" content="${channelId}"><meta itemprop="name" content="${longName}"></head>`;
    expect(extractChannelMeta(html)?.name).toHaveLength(120);
    expect(extractChannelMeta(html)?.name).toBe("A".repeat(120));
  });

  it("keeps a > inside a quoted attribute value", () => {
    const html = `<head><meta itemprop="identifier" content="${channelId}"><meta property="og:title" content="A > B Channel"><meta property='og:image' content='https://yt3.googleusercontent.com/c?a=1>2'></head>`;
    expect(extractChannelMeta(html)).toEqual({ channelId, name: "A > B Channel", avatarUrl: "https://yt3.googleusercontent.com/c?a=1>2" });
  });

  it("matches tags regardless of attribute order and quote style", () => {
    const html = `<head>
<meta content="${channelId}" itemprop="identifier" data-x="1">
<meta property='og:title' content='Quoted &amp; Name'>
<link href="https://www.youtube.com/channel/${channelId}" rel="canonical">
<meta content="https://yt3.googleusercontent.com/b" property="og:image"/>
</head>`;
    expect(extractChannelMeta(html)).toEqual({ channelId, name: "Quoted & Name", avatarUrl: "https://yt3.googleusercontent.com/b" });
  });
});

describe("extractVideoChannelRef", () => {
  it("prefers an explicit channel id meta tag", () => {
    expect(extractVideoChannelRef(watchPage)).toEqual({ kind: "id", channelId });
  });

  it("falls back to the author's channel URL when there is no channel id meta", () => {
    const html = `<html><head><meta itemprop="identifier" content="dQw4w9WgXcQ"></head><body>
<span itemprop="author" itemscope itemtype="http://schema.org/Person">
<link itemprop="url" href="http://www.youtube.com/@RickAstleyYT">
<link itemprop="name" content="Rick Astley">
</span>
</body></html>`;
    expect(extractVideoChannelRef(html)).toEqual({ kind: "url", url: "https://www.youtube.com/@RickAstleyYT" });
  });

  it("falls back to a channelId JSON literal when there is no meta or author link", () => {
    const html = `<html><body>var ytInitialData = {"channelId":"${channelId}","other":1};</body></html>`;
    expect(extractVideoChannelRef(html)).toEqual({ kind: "id", channelId });
  });

  it("ignores an author link on a non-YouTube host and falls through", () => {
    const withJsonFallback = `<html><body>
<span itemprop="author" itemscope itemtype="http://schema.org/Person">
<link itemprop="url" href="https://example.com/@notYouTube">
</span>
var ytInitialData = {"channelId":"${channelId}"};
</body></html>`;
    expect(extractVideoChannelRef(withJsonFallback)).toEqual({ kind: "id", channelId });

    const withoutFallback = `<html><body>
<span itemprop="author" itemscope itemtype="http://schema.org/Person">
<link itemprop="url" href="https://example.com/@notYouTube">
</span>
</body></html>`;
    expect(extractVideoChannelRef(withoutFallback)).toBeNull();
  });

  it("returns null for a consent page", () => {
    expect(extractVideoChannelRef(consentPage)).toBeNull();
  });

  it("finds the author link when the author marker uses single quotes", () => {
    const html = `<html><body><span itemprop='author'><link itemprop="url" href="https://www.youtube.com/@Example"></span></body></html>`;
    expect(extractVideoChannelRef(html)).toEqual({ kind: "url", url: "https://www.youtube.com/@Example" });
  });

  it("ignores a <link itemprop=\"url\"> that appears after the author block has closed", () => {
    const html = `<html><body>
<span itemprop="author" itemscope itemtype="http://schema.org/Person">
<link itemprop="name" content="Rick Astley">
</span>
<link itemprop="url" href="https://www.youtube.com/@Outside">
</body></html>`;
    expect(extractVideoChannelRef(html)).toBeNull();
  });
});

describe("channelPageComplete", () => {
  it("is true once the identifier tag has closed", () => {
    const text = `<meta itemprop="identifier" content="${channelId}">`;
    expect(channelPageComplete(text)).toBe(true);
  });

  it("is false while the identifier tag is still open (text cut mid-tag)", () => {
    const text = `<meta itemprop="identifier" content="${channelId}"`;
    expect(channelPageComplete(text)).toBe(false);
  });

  it("finds the tag once the tail carries it across a chunk boundary", () => {
    const full = `<meta itemprop="identifier" content="${channelId}">`;
    const splitAt = full.indexOf('content="') + 5; // splits mid-attribute, before the closing `>`
    const { tail } = nextStopWindow("", full.slice(0, splitAt));
    expect(channelPageComplete(tail)).toBe(false);
    const { window } = nextStopWindow(tail, full.slice(splitAt));
    expect(channelPageComplete(window)).toBe(true);
  });
});

describe("watchPageComplete", () => {
  it("is true once the channelId meta tag has closed", () => {
    const text = `<meta itemprop="channelId" content="${channelId}">`;
    expect(watchPageComplete(text)).toBe(true);
  });

  it("is false while the channelId meta tag is still open (text cut mid-tag)", () => {
    const text = `<meta itemprop="channelId" content="${channelId}"`;
    expect(watchPageComplete(text)).toBe(false);
  });

  it("is true once the author block has closed, even without a channelId meta", () => {
    const text = `<span itemprop="author"><link itemprop="url" href="https://www.youtube.com/@Example"></span>`;
    expect(watchPageComplete(text)).toBe(true);
  });

  it("is false while the author block is still open (no closing </span> yet)", () => {
    const text = `<span itemprop="author"><link itemprop="url" href="https://www.youtube.com/@Example">`;
    expect(watchPageComplete(text)).toBe(false);
  });

  it("finds the author block's closing </span> once the tail carries it across a chunk boundary", () => {
    const full = `<span itemprop="author"><link itemprop="url" href="https://www.youtube.com/@Example"></span>`;
    const splitAt = full.indexOf("</span>") + 3;
    const { tail } = nextStopWindow("", full.slice(0, splitAt));
    expect(watchPageComplete(tail)).toBe(false);
    const { window } = nextStopWindow(tail, full.slice(splitAt));
    expect(watchPageComplete(window)).toBe(true);
  });
});
