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

## Seeding test data (local D1)

- Seed via `npx wrangler d1 execute wzrdmail-dev --local --command "..."` from `services/api` — it shares state with a running dev server.
- Required NOT NULL columns: `organizations(org_id, name, human_email, plan)`, `inboxes(inbox_id, org_id, username, domain, display_name)`, `api_keys(key_id, org_id, key_hash, permissions)`.
- `api_keys.key_hash` is the SHA-256 hex of the literal `wm_…` token, e.g.
  `python3 -c "import hashlib;print(hashlib.sha256(b'wm_admin_test').hexdigest())"`.
- Authenticate requests with `Authorization: Bearer wm_admin_test` (or `x-api-key`). `permissions` is comma-separated (`read`, `send`, `admin`); read-only keys get 403 on send.

## Devin Secrets Needed
None — all local.
