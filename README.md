# youtube-channel-resolve

Resolve a YouTube channel's **ID, canonical URL, name and avatar** from any channel URL, `@handle`, `UC…` channel ID or video URL. No API key, no Data API quota: it reads the public page only.

Ships as a **library** (Node 20+ and Cloudflare Workers), a **CLI**, and an **MCP server** that agents can call.

[日本語](#日本語)

```
npx @artsnet/youtube-channel-resolve --json https://youtu.be/dQw4w9WgXcQ
{"schemaVersion":1,"ok":true,"input":"https://youtu.be/dQw4w9WgXcQ","channelId":"UCuAXFkgsw1L7xaCfnd5JJOw","channelUrl":"https://www.youtube.com/channel/UCuAXFkgsw1L7xaCfnd5JJOw","name":"Rick Astley","avatarUrl":"https://yt3.googleusercontent.com/…"}
```

## Accepted input

| Input | Example | Requests |
|---|---|---|
| Channel URL | `https://www.youtube.com/@YouTube`, `/channel/UC…`, `/user/name`, `/c/name` | 1 |
| Handle | `@YouTube` | 1 |
| Channel ID | `UCBR8-60-B28hp2BmDPdntcQ` | 1 |
| Video URL | `watch?v=`, `youtu.be/`, `/shorts/`, `/embed/`, `/live/` | 2 (watch page, then channel page) |

Anything else is rejected as `invalid-input` before any request is made. Only `youtube.com`, `www.youtube.com`, `m.youtube.com` and `youtu.be` are ever fetched.

## Library

```bash
npm install @artsnet/youtube-channel-resolve
```

```ts
import { resolveYouTubeChannel, YouTubeChannelResolveError } from "@artsnet/youtube-channel-resolve";

try {
  const channel = await resolveYouTubeChannel("@YouTube", {
    userAgent: "MyApp/1.0 (https://example.com/contact)", // identify *your* app to YouTube
  });
  // { channelId: "UC…", channelUrl: "https://www.youtube.com/channel/UC…", name: "YouTube", avatarUrl: "https://yt3.…" | null }
} catch (error) {
  if (error instanceof YouTubeChannelResolveError) error.code; // "invalid-input" | "not-found" | "unavailable"
}
```

Options: `userAgent`, `acceptLanguage` (default `en`), `timeoutMs` (default `8000`), `fetcher` (a `fetch` replacement for tests, proxies or Workers service bindings).

For more than a handful of resolves, use the polite queue. It allows one resolve in flight and one second between resolves by default; loosen it only if you have a reason to.

```ts
import { createYouTubeChannelResolver } from "@artsnet/youtube-channel-resolve";

const resolver = createYouTubeChannelResolver({ userAgent: "MyApp/1.0 (…)", concurrency: 1, minIntervalMs: 1000 });
const channels = await Promise.all(inputs.map((input) => resolver.resolve(input)));
```

The core has no Node-only dependencies (`fetch`, `ReadableStream`, `TextDecoder`, `AbortSignal.timeout`, `URL`), so it runs unchanged in Cloudflare Workers. The CLI and MCP server are Node-only.

Lower-level pieces are exported too: `parseYouTubeInput` (offline normalisation), `extractChannelMeta` / `extractVideoChannelRef` (HTML to metadata), and the zod schemas for the JSON output.

### Errors

| `code` | Meaning |
|---|---|
| `invalid-input` | Not a YouTube channel or video reference. No request was made. |
| `not-found` | YouTube answered 404, or the page carried no channel metadata. |
| `unavailable` | Timeout, network failure, non-200 status, or an interstitial (consent page, `google.com/sorry`). The underlying error is on `cause`. |

### How it reads the page

The channel page is streamed and reading stops as soon as the needed tags have arrived (YouTube renders them well into the body), with a 3 MB cap. Metadata comes from `<meta itemprop="identifier">` / `itemprop="channelId"` / the canonical link, `itemprop="name"` / `og:title`, and `og:image`. Avatars are kept only on YouTube CDN hosts; names are capped at 120 characters. The `SOCS=CAI` cookie is sent so the EU consent interstitial does not hide the metadata.

## CLI

```bash
npx @artsnet/youtube-channel-resolve @YouTube https://youtu.be/dQw4w9WgXcQ
npx @artsnet/youtube-channel-resolve --json < inputs.txt     # one input per line, "#" comments ignored
```

```
Options:
  --json                 One JSON object per input, one per line (schemaVersion 1)
  --user-agent <ua>      User-Agent sent to YouTube (or set YOUTUBE_CHANNEL_RESOLVE_USER_AGENT)
  --accept-language <l>  Accept-Language sent to YouTube (default: en)
  --timeout <ms>         Per-request timeout (default: 8000)
  --concurrency <n>      Resolves in flight at once (default: 1)
  --interval <ms>        Minimum gap between the start of consecutive resolves (default: 1000)
```

Exit codes: `0` every input resolved, `1` usage error, `2` invalid input, `3` not found, `4` YouTube unavailable. With several inputs the most severe failure wins. In `--json` mode every input produces exactly one line on stdout, success or failure:

```json
{"schemaVersion":1,"ok":true,"input":"@YouTube","channelId":"UC…","channelUrl":"https://www.youtube.com/channel/UC…","name":"YouTube","avatarUrl":"https://yt3.…"}
{"schemaVersion":1,"ok":false,"input":"https://example.com","error":{"code":"invalid-input","message":"Not a YouTube channel URL, @handle, channel ID, or video URL. No request was made."}}
```

## MCP server

A stdio server for Claude Code, Claude Desktop, Cursor and any other MCP client. It runs on your machine, with your network and your User-Agent. There is no hosted endpoint.

```json
{
  "mcpServers": {
    "youtube-channel-resolve": {
      "command": "npx",
      "args": ["-y", "-p", "@artsnet/youtube-channel-resolve", "youtube-channel-resolve-mcp"],
      "env": { "YOUTUBE_CHANNEL_RESOLVE_USER_AGENT": "MyAgent/1.0 (https://example.com/contact)" }
    }
  }
}
```

Claude Code: `claude mcp add youtube-channel-resolve -e YOUTUBE_CHANNEL_RESOLVE_USER_AGENT="MyAgent/1.0 (…)" -- npx -y -p @artsnet/youtube-channel-resolve youtube-channel-resolve-mcp`

| Tool | Network | Returns |
|---|---|---|
| `resolve_youtube_channel` `{ input }` | yes | The same record as the CLI's `--json` line; failures come back as an error result carrying `error.code`. |
| `parse_youtube_input` `{ input }` | no | Whether the input is a channel or video reference and which page would be fetched. |

Both tools are annotated read-only. Environment: `YOUTUBE_CHANNEL_RESOLVE_USER_AGENT`, `YOUTUBE_CHANNEL_RESOLVE_INTERVAL_MS` (default `1000`), `YOUTUBE_CHANNEL_RESOLVE_CONCURRENCY` (default `1`).

**Everything a tool returns is text from YouTube's public page.** It is data for the agent to report, never an instruction for it to follow. The tool descriptions say so, and your own prompts should treat channel names accordingly. See also [SKILL.md](SKILL.md), a short usage guide written for agents.

## Responsibility

This package reads public YouTube pages on behalf of whoever runs it. Compliance with YouTube's Terms of Service and with the law of your jurisdiction is your responsibility. Please identify your application in the User-Agent, keep the default rate limits unless you have a reason not to, and do not use it to collect data at a scale YouTube would object to. YouTube changes its pages without notice; when extraction breaks, open an issue with the input that failed.

## Development

```bash
npm install
npm run typecheck && npm test && npm run build
node dist/cli.js --json @YouTube
```

MIT © Artsnet. See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).

---

## 日本語

YouTube の **チャンネル URL・@ハンドル・UC… のチャンネル ID・動画 URL** から、チャンネル ID・正規 URL・名前・アバターを解決します。API キー不要、Data API のクォータを消費しません。公開ページだけを読みます。

**ライブラリ**(Node 20 以上と Cloudflare Workers)、**CLI**、エージェントから呼べる **MCP サーバー** を同梱しています。

### 使い方

```bash
# CLI
npx @artsnet/youtube-channel-resolve --json @YouTube https://youtu.be/dQw4w9WgXcQ

# ライブラリ
npm install @artsnet/youtube-channel-resolve
```

```ts
import { resolveYouTubeChannel } from "@artsnet/youtube-channel-resolve";
const channel = await resolveYouTubeChannel("@YouTube", { userAgent: "MyApp/1.0 (https://example.com/contact)" });
```

MCP サーバーは stdio で動く自己ホスト専用です。Artsnet が運用する公開エンドポイントはありません。設定例は上の英語セクションの JSON をそのまま使ってください。

### 失敗コードと終了コード

| コード | 意味 | CLI 終了コード |
|---|---|---|
| `invalid-input` | YouTube のチャンネル・動画の参照ではない。リクエストは発生しない | 2 |
| `not-found` | 404、またはページにチャンネル情報がない | 3 |
| `unavailable` | タイムアウト、ネットワーク障害、200 以外、同意画面などの割り込みページ | 4 |

### 礼儀設定

既定では同時 1 件、間隔 1 秒です(`--concurrency` / `--interval`、MCP では環境変数)。緩める側は利用者の明示設定です。User-Agent には自分のアプリ名と連絡先を入れてください(`--user-agent` または `YOUTUBE_CHANNEL_RESOLVE_USER_AGENT`)。既定値はこのライブラリ名だけで、運営者名は含みません。

### 責任について

このパッケージは、実行した人の代わりに YouTube の公開ページを読みます。YouTube の利用規約および各国の法令の遵守は利用者の責任です。ツールが返す内容はすべて YouTube のページ上のテキストであり、エージェントにとってはデータであって指示ではありません。YouTube はページ構造を予告なく変えるため、解析が壊れたときは失敗した入力を添えて Issue を立ててください。
