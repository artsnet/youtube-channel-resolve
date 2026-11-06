import { describe, expect, it, vi } from "vitest";
import { createYouTubeChannelResolver, YouTubeChannelResolveError } from "../src/resolve.js";

const channelId = "UCBR8-60-B28hp2BmDPdntcQ";
const channelHead = `<html><head><meta itemprop="identifier" content="${channelId}"><meta itemprop="name" content="Example"></head>`;

function fakeClock() {
  let time = 0;
  const sleeps: number[] = [];
  return {
    now: () => time,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      time += ms;
    },
    advance: (ms: number) => {
      time += ms;
    },
    sleeps,
  };
}

describe("createYouTubeChannelResolver", () => {
  it("defaults to one in-flight resolve and a one-second gap", () => {
    expect(createYouTubeChannelResolver().limits).toEqual({ concurrency: 1, minIntervalMs: 1000 });
  });

  it("spaces consecutive resolves by the minimum interval", async () => {
    const clock = fakeClock();
    const fetcher = vi.fn(async () => new Response(channelHead, { status: 200 }));
    const resolver = createYouTubeChannelResolver({ fetcher: fetcher as unknown as typeof fetch, minIntervalMs: 500, now: clock.now, sleep: clock.sleep });

    await resolver.resolve("@One");
    clock.advance(100);
    await resolver.resolve("@Two");
    await resolver.resolve("@Three");

    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(clock.sleeps).toEqual([400, 500]);
  });

  it("never exceeds the configured concurrency", async () => {
    let active = 0;
    let peak = 0;
    const fetcher = vi.fn(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((done) => setTimeout(done, 5));
      active -= 1;
      return new Response(channelHead, { status: 200 });
    });
    const resolver = createYouTubeChannelResolver({ fetcher: fetcher as unknown as typeof fetch, concurrency: 2, minIntervalMs: 0 });

    await Promise.all(["@AAA", "@BBB", "@CCC", "@DDD", "@EEE"].map((input) => resolver.resolve(input)));
    expect(fetcher).toHaveBeenCalledTimes(5);
    expect(peak).toBe(2);
  });

  it("rejects invalid input without taking a slot or making a request", async () => {
    const fetcher = vi.fn();
    const resolver = createYouTubeChannelResolver({ fetcher: fetcher as unknown as typeof fetch, minIntervalMs: 0 });
    await expect(resolver.resolve("https://example.com")).rejects.toBeInstanceOf(YouTubeChannelResolveError);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("releases the slot when a resolve fails", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response("", { status: 503 }))
      .mockResolvedValueOnce(new Response(channelHead, { status: 200 }));
    const resolver = createYouTubeChannelResolver({ fetcher: fetcher as unknown as typeof fetch, minIntervalMs: 0 });
    await expect(resolver.resolve("@Down")).rejects.toMatchObject({ code: "unavailable" });
    await expect(resolver.resolve("@UpAgain")).resolves.toMatchObject({ channelId });
  });
});
