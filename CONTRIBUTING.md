# Contributing

Thanks for helping. This is a small package with a narrow job, so most contributions are one of three things.

## YouTube changed its page

This is the most common break. Please open an issue with the input that fails (a handle or URL that is fine to share) and the `error.code`. A pull request is welcome: add a fixture in `tests/extract.test.ts` that reproduces the new markup, then adjust `src/extract.ts`. Keep the extraction allow-listed (specific tags and attributes), not a general HTML parser.

## Bugs and small features

Open an issue first for anything that changes the JSON shape or the CLI's exit codes; those are the contract other tools rely on (`schemaVersion` only moves on a breaking change). Otherwise send a pull request with a test.

## Checks

```bash
npm install
npm run typecheck
npm test
npm run build
node dist/cli.js --json @YouTube   # live check, needs network
```

CI runs the same on Node 20, 22 and 24.

## Ground rules

- The core (`src/parse.ts`, `src/extract.ts`, `src/resolve.ts`) must stay free of Node-only APIs so it keeps running in Cloudflare Workers.
- Do not add a default User-Agent that names an operator, and do not add a hosted endpoint.
- Do not loosen the default rate limits.
- Commit messages: a short imperative summary line, optionally followed by why.
