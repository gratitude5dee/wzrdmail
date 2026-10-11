---
name: testing-api-worker
description: How to run and test the wzrdmail Cloudflare Worker API locally with wrangler dev, local D1 migrations, and pnpm check.
---

# Testing the wzrdmail API worker locally

1. `pnpm install` at repo root (pnpm/Turbo monorepo).
2. Start dev server: `pnpm --filter @wzrdmail/api dev` → wrangler dev on http://localhost:8787. The placeholder D1/KV/R2 ids in `services/api/wrangler.jsonc` are fine locally — wrangler dev uses local resources under `services/api/.wrangler/state/v3/`.
3. Apply local D1 migrations (from `services/api`): `npx wrangler d1 migrations apply wzrdmail-dev --local`. No server restart needed — the running dev server sees the same local D1 state immediately.
4. Health: `curl localhost:8787/v0/health` → `{"ok":true,"env":"dev","build_sha":"dev","migration_head":"0001_init.sql"}` (migration_head is `null` before migrations). Unknown routes return 404 `{"name":"not_found","message":"no such endpoint"}`.
5. Email ingress (`src/ingress/email.ts`) is NOT reachable via HTTP in wrangler 3.x — POST to `/cdn-cgi/handler/email` returns the app's 404 (that route only exists in wrangler 4.x local email simulation). Test via unit tests or deployed Email Routing instead.
6. Full checks: `pnpm check` at repo root (turbo typecheck+lint+test). Use `pnpm check --force` to bypass turbo cache. Note: turbo warns `no output files found for task @wzrdmail/core#build` (outputs key mismatch in turbo.json).

## Quick org bootstrap without seeding

`POST /v0/agent/sign-up {"username":"…","human_email":"x@example.com"}` (unauthenticated) returns `{api_key (admin), inbox_id, organization_id, pod_id}`. Locally there is no `THIRDWEB_CLIENT_ID`, so the OTP step is skipped and no external call is made. Use that admin key to mint scoped keys via `POST /v0/api-keys {name, inbox_id, permissions:["read","drafts"]}` or the CLI `keys create --inbox-id … --permissions read,drafts`.

Docs worker: `npx wrangler dev --port 8789 --inspector-port 93xx` in `services/docs`; pages serve HTML, and raw markdown via `Accept: text/markdown` or a `.md` suffix. Its renderer (`src/markdown.ts`) only recognises ``` fences at column 0 — indented fences inside list items render as literal text, so check new pages visually.

When running api + docs + mcp dev servers together, give each a unique `--inspector-port` (default 9229 collides and workerd exits).

## Outbound-send behavior in wrangler dev (important)

- `send_email` bindings are only declared under `env.staging`/`env.production` in wrangler.jsonc, so `env.EMAIL` is undefined locally: `CloudflareEmailProvider.send` throws and **immediate sends always land in state `rejected` with HTTP 200** (see `egress/send.ts` doSend catch). This is expected — do not report it as a bug. To test the `sent` state or state-dependent guards, flip the row via `wrangler d1 execute wzrdmail-dev --local --command "UPDATE messages SET state='sent' WHERE msg_id='…'"`.
- Sign-up creates orgs with `verified=0`, which restricts sends to the org's `human_email` only (`verify your account to email external recipients`). To send to arbitrary recipients locally: `UPDATE organizations SET verified=1 WHERE org_id='…'` via d1 execute — `authenticate()` reads `verified` per request, so it takes effect immediately.
- Miniflare 3 does not auto-fire cron triggers (wrangler warns at startup): scheduled dispatch (`deliverDueScheduled`), trash purge, and webhook retry sweeps are not reachable via plain HTTP. Test those paths in unit tests or force rows due + call the sweep in vitest.
- Other handy local seeds: `INSERT INTO suppressions (org_id,address,reason,created_at)` to force `suppressed_recipient` errors; raw MIME for a message is at `GET /v0/inboxes/{id}/messages/{msg_id}/raw` (stored in local R2), useful for asserting headers like `Reply-To`.

## Seeding test data (local D1)

- Seed via `npx wrangler d1 execute wzrdmail-dev --local --command "..."` from `services/api` — it shares state with a running dev server.
- Required NOT NULL columns: `organizations(org_id, name, human_email, plan)`, `inboxes(inbox_id, org_id, username, domain, display_name)`, `api_keys(key_id, org_id, key_hash, permissions)`.
- `api_keys.key_hash` is the SHA-256 hex of the literal `wm_…` token, e.g.
  `python3 -c "import hashlib;print(hashlib.sha256(b'wm_admin_test').hexdigest())"`.
- Authenticate requests with `Authorization: Bearer wm_admin_test` (or `x-api-key`). `permissions` is comma-separated (`read`, `send`, `admin`); read-only keys get 403 on send.

## Domain verification tests

- `POST /v0/domains` enforces `PLANS[plan].customDomains` — `free` allows **0**, so any
  domain test must seed `organizations.plan` to `developer`/`startup`/`enterprise` or
  create returns `plan_limit_exceeded`.
- `POST /v0/domains/:id/verify` performs **real DNS-over-HTTPS** calls to
  `cloudflare-dns.com` from inside the worker — it needs outbound network. A domain on
  the reserved `.invalid` TLD (e.g. `neverresolves-<rand>.invalid`) always NXDOMAINs:
  all three checks fail → `status:"failed"` + `failure_reason` in the response and in
  the emitted `domain.failed` event payload.
- `domain.verified`/`domain.failed` events emit exactly once per transition (guarded
  `INSERT ... WHERE status != ?`); re-verifying does not duplicate the event row.

## Checking `events` rows after API calls

`npx wrangler d1 execute wzrdmail-dev --local --command "SELECT type, payload FROM events WHERE org_id='...' ORDER BY created_at"` — `payload` is the full event envelope JSON (`.data` holds the resource payload).

## Exercising sdk-ts against a live worker

`packages/sdk-ts` has no build output (`tsc --noEmit` only) and its sources import
`./x.js` specifiers that plain `node` cannot resolve to `.ts`. To run the SDK against a
live API, drop a temp vitest file in `packages/sdk-ts/test/` (vite resolves `.js`→`.ts`)
and run `npx vitest run test/<file>.test.ts` from that package; delete the file after.

## sdk-python live calls

`(cd sdk-python && uv run python script.py)` — client class is `WzrdMail`
(`from wzrdmail import WzrdMail`), constructed as `WzrdMail(api_key=..., base_url='http://localhost:8787')`.

## Devin Secrets Needed

None — all local.
