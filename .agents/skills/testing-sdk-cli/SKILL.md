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
