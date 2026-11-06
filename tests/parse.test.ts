import { describe, expect, it } from "vitest";
import { channelUrlFor, parseYouTubeInput } from "../src/parse.js";

const channelId = "UCBR8-60-B28hp2BmDPdntcQ";

describe("parseYouTubeInput", () => {
  it.each([
    ["https://www.youtube.com/@YouTube", "channel", "https://www.youtube.com/@YouTube"],
    ["youtube.com/@YouTube/videos", "channel", "https://www.youtube.com/@YouTube"],
    ["@YouTube", "channel", "https://www.youtube.com/@YouTube"],
    [`https://m.youtube.com/channel/${channelId}`, "channel", `https://www.youtube.com/channel/${channelId}`],
    [channelId, "channel", `https://www.youtube.com/channel/${channelId}`],
    ["https://www.youtube.com/user/legacyname", "channel", "https://www.youtube.com/user/legacyname"],
    ["https://www.youtube.com/c/CustomName", "channel", "https://www.youtube.com/c/CustomName"],
    ["https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10s", "video", "https://www.youtube.com/watch?v=dQw4w9WgXcQ"],
    ["https://youtu.be/dQw4w9WgXcQ", "video", "https://www.youtube.com/watch?v=dQw4w9WgXcQ"],
    ["https://www.youtube.com/shorts/dQw4w9WgXcQ", "video", "https://www.youtube.com/watch?v=dQw4w9WgXcQ"],
  ])("accepts %s", (input, kind, url) => {
    expect(parseYouTubeInput(input)).toEqual({ kind, url });
  });

  it.each([
    "", "   ", "https://example.com/@YouTube", "https://youtube.com.evil.com/@YouTube", "javascript:alert(1)",
    "//evil.com/@YouTube", "https://www.youtube.com/", "https://www.youtube.com/results?search_query=piano",
    "https://www.youtube.com/watch?v=short", "@ab", "UC123", "x".repeat(201),
    "https://www.youtube.com/user/%E0%A4",
  ])("rejects %j", (input) => {
    expect(parseYouTubeInput(input)).toBeNull();
  });

  it("builds the canonical channel URL from an ID", () => {
    expect(channelUrlFor(channelId)).toBe(`https://www.youtube.com/channel/${channelId}`);
  });
});
