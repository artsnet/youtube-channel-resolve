import { describe, expect, it, vi } from "vitest";
import { EXIT_CODES, HELP, parseArgs, runCli } from "../src/cli.js";
import { YouTubeChannelResolveError, type YouTubeChannelResolver } from "../src/resolve.js";
import { VERSION } from "../src/version.js";

const channelId = "UCBR8-60-B28hp2BmDPdntcQ";
const resolved = { channelId, channelUrl: `https://www.youtube.com/channel/${channelId}`, name: "Example", avatarUrl: null };

function io(argv: string[], resolve: YouTubeChannelResolver["resolve"], extra: { stdin?: string; env?: Record<string, string> } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const createResolver = vi.fn(() => ({ resolve, limits: { concurrency: 1, minIntervalMs: 0 } }));
  const run = () =>
    runCli({
      argv,
      env: extra.env ?? {},
      readStdin: async () => extra.stdin ?? "",
      stdout: (text) => out.push(text),
      stderr: (text) => err.push(text),
      createResolver,
    });
  return { run, out, err, createResolver };
}

describe("parseArgs", () => {
  it("collects inputs and options", () => {
    expect(parseArgs(["--json", "--timeout", "500", "--concurrency", "2", "--interval", "0", "--user-agent", "X/1", "--accept-language", "ja", "@a", "--", "-b"])).toEqual({
      kind: "run",
      options: { json: true, inputs: ["@a", "-b"], resolver: { timeoutMs: 500, concurrency: 2, minIntervalMs: 0, userAgent: "X/1", acceptLanguage: "ja" } },
    });
  });

  it("reads the User-Agent from the environment and lets the flag override it", () => {
    const env = { YOUTUBE_CHANNEL_RESOLVE_USER_AGENT: "Env/1" };
    expect(parseArgs(["@a"], env)).toMatchObject({ options: { resolver: { userAgent: "Env/1" } } });
    expect(parseArgs(["--user-agent", "Flag/1", "@a"], env)).toMatchObject({ options: { resolver: { userAgent: "Flag/1" } } });
  });

  it.each([["--timeout", "0"], ["--concurrency", "x"], ["--interval", "-1"], ["--bogus"], ["--user-agent"]])("rejects %s %s", (...argv) => {
    expect(parseArgs(argv.filter((a): a is string => a !== undefined))).toMatchObject({ kind: "usage-error" });
  });

  it("recognises help and version", () => {
    expect(parseArgs(["-h"])).toEqual({ kind: "help" });
    expect(parseArgs(["--version"])).toEqual({ kind: "version" });
  });
});

describe("runCli", () => {
  it("prints help and the version", async () => {
    const help = io(["--help"], vi.fn());
    expect(await help.run()).toBe(0);
    expect(help.out.join("")).toBe(HELP);
    const version = io(["-v"], vi.fn());
    expect(await version.run()).toBe(0);
    expect(version.out.join("")).toBe(`${VERSION}\n`);
  });

  it("fails with a usage error when there is no input", async () => {
    const { run, err } = io([], vi.fn());
    expect(await run()).toBe(EXIT_CODES.usage);
    expect(err.join("")).toContain("no input given");
  });

  it("prints one JSON line per input and exits with the worst failure", async () => {
    const resolve = vi.fn(async (input: string) => {
      if (input === "@ok") return resolved;
      throw new YouTubeChannelResolveError(input === "@missing" ? "not-found" : "unavailable");
    });
    const { run, out, err } = io(["--json", "@ok", "@missing", "@down"], resolve);
    expect(await run()).toBe(EXIT_CODES.unavailable);
    expect(err).toEqual([]);
    const lines = out.join("").trim().split("\n").map((line) => JSON.parse(line));
    expect(lines).toEqual([
      { schemaVersion: 1, ok: true, input: "@ok", ...resolved },
      { schemaVersion: 1, ok: false, input: "@missing", error: { code: "not-found", message: expect.any(String) } },
      { schemaVersion: 1, ok: false, input: "@down", error: { code: "unavailable", message: expect.any(String) } },
    ]);
  });

  it("writes human output to stdout for successes and stderr for failures", async () => {
    const resolve = vi.fn(async (input: string) => {
      if (input === "@ok") return resolved;
      throw new YouTubeChannelResolveError("invalid-input");
    });
    const { run, out, err } = io(["@ok", "nope"], resolve);
    expect(await run()).toBe(EXIT_CODES["invalid-input"]);
    expect(out.join("")).toContain(`channelId:  ${channelId}`);
    expect(err.join("")).toContain("error: invalid-input");
  });

  it("reads inputs from stdin when none are given, skipping blank and comment lines", async () => {
    const resolve = vi.fn(async (_input: string) => resolved);
    const { run, out } = io(["--json"], resolve, { stdin: "@one\n\n# comment\n  @two  \n" });
    expect(await run()).toBe(0);
    expect(resolve.mock.calls.map((call) => call[0])).toEqual(["@one", "@two"]);
    expect(out).toHaveLength(2);
  });

  it("passes the resolver options through to the resolver factory", async () => {
    const { run, createResolver } = io(["--concurrency", "3", "--interval", "250", "@a"], vi.fn(async () => resolved));
    await run();
    expect(createResolver).toHaveBeenCalledWith({ concurrency: 3, minIntervalMs: 250 });
  });

  it("maps a non-resolver exception to unavailable instead of crashing", async () => {
    const { run, out } = io(["--json", "@a"], vi.fn(async () => { throw new Error("boom"); }));
    expect(await run()).toBe(EXIT_CODES.unavailable);
    expect(JSON.parse(out[0] ?? "")).toMatchObject({ ok: false, error: { code: "unavailable" } });
  });
});
