---
name: testing-sdk-cli
description: How to build and end-to-end test the wzrdmail TypeScript SDK (packages/sdk-ts) and CLI (apps/cli) against a local mock API server.
---

# Testing the wzrdmail SDK + CLI

The live https://api.wzrd.tech may not implement the §7 SDK/CLI endpoints — do not assume it does. Test against a local mock server instead.

## Build
- `pnpm install --frozen-lockfile` at repo root (pnpm 9.15.1, Node 22+).
- `pnpm --filter @wzrdmail/cli build` → single-file bundle at `apps/cli/dist/bin.js` (tsup, ESM).
- `pnpm check` at repo root runs typecheck/lint/tests via turbo; expected green.

## Running the CLI
- `WZRDMAIL_API_KEY=... WZRDMAIL_BASE_URL=http://localhost:PORT node apps/cli/dist/bin.js <cmd>`
- Bin wiring: `node_modules/.bin/wzrdmail` is NOT self-linked inside apps/cli (pnpm doesn't link a package's own bin); use `npm exec --no -- wzrdmail ...` from `apps/cli` instead.
- Exit codes: 0 ok, 1 usage/other error, 2 auth (missing key or 401), 3 plan_limit_exceeded (goal.md §10).
- `--format json` prints machine-clean JSON on stdout; errors go to stderr (raw error envelope JSON in json mode).

## Mock server pattern
Write a small Node `http` server implementing goal.md §7 shapes:
- List envelopes are collection-keyed: `{"inboxes":[...],"next_page_token":...}` (same for messages/threads/webhooks/domains).
- Error envelope: `{"name":"...","message":"..."}` with proper HTTP status (401 unauthorized, 402 plan_limit_exceeded, 429 rate_limited with `Retry-After` header).
- Log every request (method/path/query/Authorization header/content-type/parsed body) to an in-memory array exposed at `GET /__log`, and add a `POST /__control` endpoint to prime behaviors (e.g. number of 429s to return) — this lets you assert header/body correctness and retry counts.
- `/v0/agent/sign-up` is the only unauthenticated endpoint (SDK sends no Authorization header there).
- SDK retries 429 up to 3 times honoring Retry-After seconds; verify via request count in `/__log` and elapsed wall time.
- Spec response shapes (goal.md §0.1): sign-up → `{api_key, inbox_id, organization_id}`; verify → `{verified: true}`.

## MCP server (services/mcp)
- Local dev: the pinned wrangler ^3.100 FAILS to start (`No such module "cloudflare-internal:email"` — the `agents` package imports `cloudflare:email`, unsupported by wrangler 3's miniflare). Use `npx -y wrangler@4 dev --port 8788` from services/mcp instead (or bump the devDependency to wrangler 4).
- `API_BASE_URL` dev var is http://localhost:8787 — run the mock §7 server there (`PORT=8787 node server.mjs`).
- Endpoints: `/health` → `{ok:true}`; `/mcp` Streamable HTTP; auth via `x-api-key` header or `Authorization: Bearer` (missing key → HTTP 401 `{name,message}` envelope).
- Drive it with a real client: node script importing `@modelcontextprotocol/sdk` `Client` + `StreamableHTTPClientTransport` (pass headers via `requestInit.headers`). The script file must live inside services/mcp (or otherwise resolve the sdk from its own path) — Node ESM resolves bare imports relative to the script file, not cwd.
- Expect 22 tools (§9). API errors surface as tool results with `isError: true` and content JSON `{error:{name,message},status}` (not protocol errors). Tools proxy to API_BASE_URL with the caller's MCP key as `Authorization: Bearer`.
