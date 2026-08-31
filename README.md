# wzrdmail

Email for AI agents, self-hosted on Cloudflare at `wzrd.tech`. The full
specification of record is [goal.md](./goal.md) — read §2 (non-negotiables)
and §3 (non-goals) before writing any code.

## The golden path

```bash
# 1. An agent with no credentials signs up
curl -X POST https://api.wzrd.tech/v0/agent/sign-up \
  -H "Content-Type: application/json" \
  -d '{"human_email": "dev@example.com", "username": "scout"}'

# 2. Verify with the OTP from the developer's inbox
curl -X POST https://api.wzrd.tech/v0/agent/verify \
  -H "Authorization: Bearer $WZRDMAIL_API_KEY" \
  -d '{"otp_code": "482913"}'

# 3. Send real mail
curl -X POST https://api.wzrd.tech/v0/inboxes/scout@wzrd.tech/messages/send \
  -H "Authorization: Bearer $WZRDMAIL_API_KEY" \
  -d '{"to": ["human@gmail.com"], "subject": "Report ready", "text": "Done."}'
```

## Layout

- `packages/core` — zod schemas (single source of field truth), ids, plans,
  `MailProvider` seam, threading, quote-strip, webhook signing. Pure, no
  bindings, unit-tested.
- `services/api` — the Worker: Hono `/v0/*` routes, `email()` ingress, queue
  consumers, Durable Objects. D1 migrations in `services/api/migrations/`.
- `scripts/setup.ts` — idempotent provisioning (D1/KV/R2, wrangler.jsonc
  patch, migrations, secrets). Copy `scripts/config.example.toml` →
  `scripts/config.toml` first.

## Development

Node ≥22 and pnpm 9 required.

```bash
pnpm install
just check          # typecheck + lint + tests (or: pnpm check)
just dev            # wrangler dev
just setup dev      # provision local resources + apply migrations
```

Conventions: TypeScript strict, no `any` in `packages/` or `services/`;
vitest + `@cloudflare/vitest-pool-workers` for Worker-context tests;
conventional commits; forward-only D1 migrations; ADRs in `docs/decisions/`
for anything that contradicts or extends goal.md.
