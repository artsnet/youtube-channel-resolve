# Security policy

## Reporting

Report vulnerabilities privately through GitHub's "Report a vulnerability" form on this repository (Security tab), not in a public issue. Include the input that triggers the problem and the version. You will get an acknowledgement within a week.

## Scope

In scope: anything that lets input or page content reach somewhere it should not, such as fetching a host other than YouTube, following a redirect off YouTube, returning an avatar from a non-YouTube host, unbounded memory or time on a hostile page, or a way for page text to be interpreted as instructions by the CLI or the MCP server.

Out of scope: YouTube changing its page structure (open a normal issue), and rate limiting or blocking by YouTube caused by how the package was run.

## Design notes

- Only `youtube.com`, `www.youtube.com`, `m.youtube.com` and `youtu.be` are fetched; the final post-redirect host is checked before any body is read.
- Responses are streamed and capped at 3 MB; reading stops as soon as the needed tags arrive.
- Avatar URLs must be `https` on a YouTube CDN host; names are capped at 120 characters and entity-decoded only.
- The MCP server is stdio-only, read-only, and has no hosted endpoint. Tool results are labelled as data in the tool descriptions.
- No credentials are read or stored. The only environment variables used are the User-Agent and the rate-limit knobs.
