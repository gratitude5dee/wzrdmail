# Migrate from AgentMail

wzrdmail is shape-compatible with AgentMail v0. Code written against AgentMail ports by changing a base URL and a key prefix — no schema change, no handler rewrite. This page is the cutover contract used by Air; it applies to any AgentMail integration.

## What stays the same

- **Paths**: `/v0/inboxes`, `/v0/inboxes/{inbox_id}/messages/send`, `/v0/inboxes/{inbox_id}/drafts`, `/v0/webhooks`, `/v0/api-keys`, `/v0/agent/sign-up`, `/v0/agent/verify`.
- **Field casing**: `inbox_id`, `message_id`, `thread_id`, `draft_id`, `extracted_text`, `next_page_token`, `client_id` — snake_case throughout. Collections are keyed by their plural (`inboxes`, `messages`, `threads`, `drafts`).
- **Error envelope**: `{"name": "…", "message": "…"}` with the same HTTP statuses.
- **Webhook signing**: Standard Webhooks / Svix scheme (`svix-id`, `svix-timestamp`, `svix-signature`, `whsec_` secrets). Existing Svix verification code verifies wzrdmail deliveries unchanged.
- **Idempotency**: `client_id` on create bodies and the `Idempotency-Key` header on send/reply both work.
- **Lists**: `POST /v0/inboxes/{inbox_id}/lists/receive/block` and `DELETE …/lists/receive/block/{entry}` are served as aliases of the native `/lists` endpoints, so block-list code ports unchanged.

## What changes

| AgentMail | wzrdmail |
| --- | --- |
| `https://api.agentmail.to/v0` | `https://api.wzrd.tech/v0` |
| `AGENTMAIL_API_KEY` | `WZRDMAIL_API_KEY` |
| AgentMail key prefix | `wm_live_…` / `wm_test_…` |
| `Authorization: Bearer <key>` | same — or `x-api-key: wm_…` |
| `whsec_` secret from AgentMail | new `whsec_` secret returned once by `POST /v0/webhooks` |
| `https://mcp.agentmail.to/mcp` | `https://mcp.mail.wzrd.tech/mcp` |
| `agentmail` CLI | `wzrdmail` (alias `wm`) |
| `AgentMailClient` (TS) / `AgentMail` (Python) | `WzrdMailClient` (`npm i wzrdmail`) / `WzrdMail` (`pip install wzrdmail`) |
| `official/email/agentmail` skill | `plugins/agents` skills (`send-email`, `check-email`, `manage-inboxes`, …) |

## Cutover steps

### 1. Provision inboxes

One pod per tenant: `POST /v0/pods` with `{ "client_id": "<user_id>" }` (idempotent — a retry returns the same pod; `GET /v0/pods` lists them, `DELETE /v0/pods/{pod_id}` retires the pod and its inboxes). Then `POST /v0/pods/{pod_id}/inboxes` (or `POST /v0/inboxes` with `"pod_id"`) with `{ "username", "client_id" }`. Inboxes land on `@wzrd.tech`, which is pre-verified; re-runs with the same `client_id` return the existing inbox.

### 2. Register one webhook at your existing endpoint

```http
POST /v0/webhooks
{ "url": "https://<your-app>/api/inbound/email", "event_types": ["message.received"], "pod_ids": ["pod_…"], "client_id": "inbound-v1" }
```

The response carries `secret` (`whsec_…`) once. Store it as `WZRDMAIL_WEBHOOK_SECRET` and hand it to your existing Svix verifier — the verification code does not change. Omit `pod_ids` to receive every pod in the organization.

### 3. Mint draft-only keys for sandboxes

Where AgentMail gave an agent a scoped key that could draft but not send:

```http
POST /v0/api-keys
{ "name": "box-<user>", "inbox_id": "<user>@wzrd.tech", "permissions": ["read", "drafts"] }
```

The key sees only that inbox. `create_draft` / `POST …/drafts` succeed; `…/messages/send`, `…/drafts/{id}/send`, replies, forwards, `POST /v0/inboxes`, and every other inbox return `403 forbidden`. Keep a `send` key in the control plane that reviews and sends drafts.

### 4. Swap the env vars

`AGENTMAIL_API_KEY` → `WZRDMAIL_API_KEY`, base URL → `https://api.wzrd.tech`, webhook secret → the new `whsec_`. If you gate the switch behind a flag (e.g. `MAIL_PROVIDER=wzrdmail`), both providers can run side by side until validation passes.

### 5. Repoint the agent's MCP and skills

Replace the AgentMail MCP entry with:

```json
{ "mcpServers": { "wzrdmail": { "type": "http", "url": "https://mcp.mail.wzrd.tech/mcp", "headers": { "x-api-key": "${WZRDMAIL_API_KEY}" } } } }
```

Tool names are `list_inboxes`, `list_messages`, `get_message`, `send_message`, `reply_to_message`, `reply_all_to_message`, `forward_message`, `list_threads`, `get_thread`, `search_threads`, `create_draft`, `update_draft`, `send_draft`, `get_attachment`, and more (see the Integrations page). Install the native plugin in place of the AgentMail skill.

### 6. Verify

Send from a wzrdmail inbox, reply externally, and confirm your endpoint receives `message.received` with a valid signature and an `extracted_text` field. Then, with the draft-only key, confirm `create_draft` succeeds and `send_draft` returns `403`.

## Inbox-scoped API keys

`POST /v0/api-keys` accepts an optional `inbox_id` alongside `pod_id` and `permissions`:

- The key inherits the inbox's pod; `pod_id`, if also given, must match.
- `GET /v0/inboxes` returns only that inbox; `GET /v0/inboxes/{other}` is `403`.
- The key cannot create inboxes, pods, domains, or webhooks, cannot read organization usage, and can only mint further keys for the same inbox with a subset of its own permissions.
- `permissions` default to the creator's; `["read", "drafts"]` is the draft-only shape. `send` implies `drafts`.

## Lists receive/block alias

```http
POST   /v0/inboxes/{inbox_id}/lists/receive/block          { "pattern": "spam@example.com" }   # or { "entry": … } / { "address": … } / { "domain": "junk.example" }
GET    /v0/inboxes/{inbox_id}/lists/receive/block
DELETE /v0/inboxes/{inbox_id}/lists/receive/block/{entry}   # entry = lst_… id or the exact pattern
```

Rows are identical to `POST /v0/inboxes/{inbox_id}/lists` with `{ "kind": "block", "pattern" }`. Blocked senders emit `message.rejected` instead of `message.received`.

## Known divergences

- Outbound attachments over 5 MiB are rejected with `{"name": "message_too_large"}`.
- No IMAP/SMTP bridge; no WebSocket `Subscribe` message type — use `wzrdmail events tail` or webhooks.
- `search` endpoints do substring/field match (semantic search later).
- Event types are `message.received|sent|delivered|bounced|complained|rejected` and `domain.verified`; there is no `message.received.spam` variant.
