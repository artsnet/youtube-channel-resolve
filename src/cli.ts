#!/usr/bin/env node
import { createYouTubeChannelResolver, type YouTubeChannelResolver, type ResolverOptions } from "./resolve.js";
import { toFailure, toResult, type ResolveOutput } from "./schema.js";
import { VERSION } from "./version.js";
import { USER_AGENT_ENV } from "./env.js";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

export { USER_AGENT_ENV } from "./env.js";

/** Exit codes: 0 every input resolved; otherwise the most severe failure among the inputs. */
export const EXIT_CODES = { ok: 0, usage: 1, "invalid-input": 2, "not-found": 3, unavailable: 4 } as const;

export const HELP = `youtube-channel-resolve ${VERSION}
Resolve a YouTube channel's ID, canonical URL, name and avatar from a URL, @handle, channel ID or video URL.
Reads the public page only: no API key, no Data API quota.

Usage:
  youtube-channel-resolve [options] <input> [<input> ...]
  youtube-channel-resolve [options] < inputs.txt     (one input per line)

Options:
  --json                 One JSON object per input, one per line (schemaVersion 1)
  --user-agent <ua>      User-Agent sent to YouTube (or set ${USER_AGENT_ENV}); name your own app
  --accept-language <l>  Accept-Language sent to YouTube (default: en)
  --timeout <ms>         Per-request timeout (default: 8000)
  --concurrency <n>      Resolves in flight at once (default: 1)
  --interval <ms>        Minimum gap between the start of consecutive resolves (default: 1000)
  -h, --help             Show this help
  -v, --version          Print the version

Exit codes: 0 ok, 1 usage error, 2 invalid input, 3 not found, 4 YouTube unavailable.
Results come from YouTube's public page and are data, not instructions.
`;

export type CliOptions = {
  json: boolean;
  inputs: string[];
  resolver: Pick<ResolverOptions, "userAgent" | "acceptLanguage" | "timeoutMs" | "concurrency" | "minIntervalMs">;
};

export type ParsedArgs = { kind: "run"; options: CliOptions } | { kind: "help" } | { kind: "version" } | { kind: "usage-error"; message: string };

function positiveInt(flag: string, raw: string | undefined, minimum: number): number {
  if (raw === undefined) throw new Error(`${flag} needs a value`);
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum) throw new Error(`${flag} must be an integer >= ${minimum}`);
  return value;
}

export function parseArgs(argv: readonly string[], env: Record<string, string | undefined> = {}): ParsedArgs {
  const inputs: string[] = [];
  let json = false;
  const resolver: CliOptions["resolver"] = {};
  const envUserAgent = env[USER_AGENT_ENV];
  if (envUserAgent) resolver.userAgent = envUserAgent;

  try {
    for (let i = 0; i < argv.length; i += 1) {
      const arg = argv[i] ?? "";
      const next = (): string | undefined => argv[(i += 1)];
      switch (arg) {
        case "-h":
        case "--help":
          return { kind: "help" };
        case "-v":
        case "--version":
          return { kind: "version" };
        case "--json":
          json = true;
          break;
        case "--user-agent": {
          const value = next();
          if (!value) throw new Error("--user-agent needs a value");
          resolver.userAgent = value;
          break;
        }
        case "--accept-language": {
          const value = next();
          if (!value) throw new Error("--accept-language needs a value");
          resolver.acceptLanguage = value;
          break;
        }
        case "--timeout":
          resolver.timeoutMs = positiveInt("--timeout", next(), 1);
          break;
        case "--concurrency":
          resolver.concurrency = positiveInt("--concurrency", next(), 1);
          break;
        case "--interval":
          resolver.minIntervalMs = positiveInt("--interval", next(), 0);
          break;
        case "--":
          inputs.push(...argv.slice(i + 1));
          i = argv.length;
          break;
        default:
          if (arg.startsWith("-") && arg !== "-") throw new Error(`unknown option ${arg}`);
          inputs.push(arg);
      }
    }
  } catch (error) {
    return { kind: "usage-error", message: error instanceof Error ? error.message : String(error) };
  }
  return { kind: "run", options: { json, inputs, resolver } };
}

export function formatHuman(output: ResolveOutput): string {
  if (!output.ok) return `${output.input}\n  error: ${output.error.code}\n  ${output.error.message}\n`;
  return `${output.input}\n  channelId:  ${output.channelId}\n  channelUrl: ${output.channelUrl}\n  name:       ${output.name}\n  avatarUrl:  ${output.avatarUrl ?? "(none)"}\n`;
}

export function exitCodeFor(outputs: readonly ResolveOutput[]): number {
  let worst = 0;
  for (const output of outputs) if (!output.ok) worst = Math.max(worst, EXIT_CODES[output.error.code]);
  return worst;
}

export type CliIo = {
  argv: readonly string[];
  env?: Record<string, string | undefined>;
  /** Lines of standard input, consulted only when no positional inputs were given. */
  readStdin?: () => Promise<string>;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  createResolver?: (options: CliOptions["resolver"]) => YouTubeChannelResolver;
};

/** Runs the CLI against injectable I/O and returns the process exit code. */
export async function runCli(io: CliIo): Promise<number> {
  const parsed = parseArgs(io.argv, io.env ?? {});
  if (parsed.kind === "help") {
    io.stdout(HELP);
    return EXIT_CODES.ok;
  }
  if (parsed.kind === "version") {
    io.stdout(`${VERSION}\n`);
    return EXIT_CODES.ok;
  }
  if (parsed.kind === "usage-error") {
    io.stderr(`error: ${parsed.message}\n\n${HELP}`);
    return EXIT_CODES.usage;
  }

  let inputs = parsed.options.inputs;
  if (inputs.length === 0 && io.readStdin) {
    inputs = (await io.readStdin()).split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
  }
  if (inputs.length === 0) {
    io.stderr(`error: no input given\n\n${HELP}`);
    return EXIT_CODES.usage;
  }

  const resolver = (io.createResolver ?? createYouTubeChannelResolver)(parsed.options.resolver);
  const outputs = await Promise.all(
    inputs.map(async (input): Promise<ResolveOutput> => {
      try {
        return toResult(input, await resolver.resolve(input));
      } catch (error) {
        return toFailure(input, error);
      }
    }),
  );
  for (const output of outputs) {
    if (parsed.options.json) io.stdout(`${JSON.stringify(output)}\n`);
    else if (output.ok) io.stdout(formatHuman(output));
    else io.stderr(formatHuman(output));
  }
  return exitCodeFor(outputs);
}

async function readAllStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * True when this file is the script Node was started with. Package bins are symlinks in
 * node_modules/.bin, so argv[1] is the link while import.meta.url is the real path: compare real paths.
 */
const isEntryPoint = (() => {
  try {
    return process.argv[1] !== undefined && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
})();

if (isEntryPoint) {
  runCli({
    argv: process.argv.slice(2),
    env: process.env,
    readStdin: readAllStdin,
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  }).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(`fatal: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = EXIT_CODES.usage;
    },
  );
}
