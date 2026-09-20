/**
 * The docs corpus (§14.1 of goal.md). Every page is authored as markdown
 * and served with content negotiation: browsers get rendered HTML,
 * `Accept: text/markdown` (or a `.md` suffix) gets the raw source.
 * API shapes here mirror goal.md §7 exactly — snake_case fields,
 * `{"name": …, "message": …}` error envelopes, `wm_` key prefix.
 */

export interface DocPage {
  slug: string;
  title: string;
  description: string;
  markdown: string;
}

const quickstart: DocPage = {
  slug: "quickstart",
  title: "Quickstart",
  description: "Get an agent inbox at @wzrd.tech in under two minutes with curl.",
  markdown: `# Quickstart

wzrdmail gives AI agents real, persistent, two-way email inboxes at \`@wzrd.tech\`, driven over REST, MCP, CLI, SDKs, webhooks, and WebSockets. An agent with only \`curl\` can get an inbox in under two minutes.

## 1. Sign up (no credentials required)

Your developer's email receives a one-time code:

\`\`\`bash
curl -X POST https://api.wzrd.tech/v0/agent/sign-up \\
  -H "Content-Type: application/json" \\
  -d '{"human_email": "dev@example.com", "username": "scout"}'
# → { "api_key": "wm_live_…", "inbox_id": "scout@wzrd.tech", "organization_id": "org_…" }
\`\`\`

Save the \`api_key\` — it is shown once. Export it as \`WZRDMAIL_API_KEY\`.

## 2. Verify with the OTP

Until verified, your org is sandboxed: sends are restricted to the \`human_email\` you signed up with.

\`\`\`bash
curl -X POST https://api.wzrd.tech/v0/agent/verify \\
  -H "Authorization: Bearer $WZRDMAIL_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"otp_code": "482913"}'
\`\`\`

## 3. Send real mail

\`\`\`bash
curl -X POST https://api.wzrd.tech/v0/inboxes/scout@wzrd.tech/messages/send \\
  -H "Authorization: Bearer $WZRDMAIL_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"to": ["human@gmail.com"], "subject": "Report ready", "text": "Done. Reply to approve."}'
\`\`\`

## 4. Read the reply

When the human replies, your webhook fires (\`message.received\`, Svix-compatible signature) and the reply is queryable:

\`\`\`bash
curl https://api.wzrd.tech/v0/inboxes/scout@wzrd.tech/threads \\
  -H "Authorization: Bearer $WZRDMAIL_API_KEY"
\`\`\`

## 5. Connect via MCP

Any MCP client gets the same power with one line:

\`\`\`bash
claude mcp add --transport http wzrdmail https://mcp.mail.wzrd.tech/mcp
\`\`\`

## 6. Or the CLI

\`\`\`bash
npx wzrdmail --format json inboxes list
\`\`\`

## Next steps

- [Authentication](/api/auth) — Bearer keys and \`x-api-key\`
- [Inboxes](/api/inboxes) — create and manage inboxes by API
- [Messages](/api/messages) — send, reply, search, attachments
- [Webhooks](/api/webhooks) — Standard Webhooks (Svix-compatible) delivery
- [Migrate from AgentMail](/migrate-from-agentmail) — cut over by changing a base URL and a key prefix
`
};

const auth: DocPage = {
  slug: "api/auth",
  title: "API Reference: Authentication",
  description: "Authenticate with wm_ API keys via Bearer or x-api-key.",
  markdown: `# Authentication

All API requests go to \`https://api.wzrd.tech/v0\` and authenticate with an API key prefixed \`wm_\` (\`wm_live_…\` for live keys, \`wm_test_…\` for test mode).

Pass the key either way:

\`\`\`bash
curl https://api.wzrd.tech/v0/auth/me \\
  -H "Authorization: Bearer $WZRDMAIL_API_KEY"

curl https://api.wzrd.tech/v0/auth/me \\
  -H "x-api-key: $WZRDMAIL_API_KEY"
\`\`\`

## GET /v0/auth/me

Returns the identity behind the key:

\`\`\`json
{
  "organization_id": "org_01J…",
  "pod_id": "pod_01J…",
  "verified": true
}
\`\`\`

## API keys

- \`GET /v0/api-keys\` — list keys (hashes only; plaintext is shown once at creation)
- \`POST /v0/api-keys\` — mint a key
- \`DELETE /v0/api-keys/{id}\` — revoke a key

## Errors

Every error uses the same envelope with the correct HTTP status:

\`\`\`json
{ "name": "forbidden", "message": "verify your account to email external recipients" }
\`\`\`

Error names include \`validation_error\`, \`forbidden\`, \`not_found\`, \`rate_limited\`, \`message_too_large\`, and \`plan_limit_exceeded\`. \`429\` responses always carry a \`Retry-After\` header.

## Pagination

Collections take \`limit\` (default 20, max 100) and \`page_token\`, and return \`{ "items": […], "next_page_token": "…" }\`.

## Idempotency

All create operations accept a \`client_id\` and return the prior result on replay.
`
};

const agent: DocPage = {
  slug: "api/agent",
  title: "API Reference: Agent sign-up & verify",
  description: "Self-serve onboarding: sign-up, OTP verify, sandbox rules.",
  markdown: `# Agent sign-up & verify

Agents onboard themselves without pre-existing credentials. The developer's email receives a one-time code to verify the account.

## POST /v0/agent/sign-up

No auth. Fails if \`human_email\` is already registered.

\`\`\`bash
curl -X POST https://api.wzrd.tech/v0/agent/sign-up \\
  -H "Content-Type: application/json" \\
  -d '{"human_email": "dev@example.com", "username": "scout"}'
\`\`\`

Response:

\`\`\`json
{
  "api_key": "wm_live_…",
  "inbox_id": "scout@wzrd.tech",
  "organization_id": "org_01J…"
}
\`\`\`

## POST /v0/agent/verify

Authenticated with the key from sign-up. The OTP arrives at the developer's \`human_email\`.

\`\`\`bash
curl -X POST https://api.wzrd.tech/v0/agent/verify \\
  -H "Authorization: Bearer $WZRDMAIL_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"otp_code": "482913"}'
\`\`\`

## Unverified sandbox

Until verification succeeds, all endpoints work but send targets are restricted to the org's own \`human_email\`. Attempting to email anyone else returns:

\`\`\`json
{ "name": "forbidden", "message": "verify your account to email external recipients" }
\`\`\`

with HTTP 403.
`
};

const inboxes: DocPage = {
  slug: "api/inboxes",
  title: "API Reference: Inboxes",
  description: "Create, list, update, and delete agent inboxes.",
  markdown: `# Inboxes

The inbox is the unit of the product: created by API in milliseconds, addressable from the whole internet, threaded, searchable, evented.

## Endpoints

- \`GET /v0/inboxes\` — list inboxes (paginated: \`limit\`, \`page_token\`)
- \`POST /v0/inboxes\` — create an inbox
- \`GET /v0/inboxes/{inbox_id}\` — fetch one inbox
- \`PATCH /v0/inboxes/{inbox_id}\` — update (e.g. \`display_name\`)
- \`DELETE /v0/inboxes/{inbox_id}\` — delete an inbox

## Create an inbox

\`\`\`bash
curl -X POST https://api.wzrd.tech/v0/inboxes \\
  -H "Authorization: Bearer $WZRDMAIL_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"username": "support", "domain": "wzrd.tech", "display_name": "Support Bot", "client_id": "inbox-support-1"}'
\`\`\`

All fields are optional — omit \`username\` for a generated one. \`client_id\` makes the create idempotent: replays return the prior result.

Response:

\`\`\`json
{
  "inbox_id": "support@wzrd.tech",
  "display_name": "Support Bot",
  "organization_id": "org_01J…",
  "pod_id": "pod_01J…",
  "created_at": "2026-08-31T17:04:05Z"
}
\`\`\`

## List inboxes

\`\`\`bash
curl "https://api.wzrd.tech/v0/inboxes?limit=20" \\
  -H "Authorization: Bearer $WZRDMAIL_API_KEY"
\`\`\`

\`\`\`json
{ "items": [ { "inbox_id": "scout@wzrd.tech", "…": "…" } ], "next_page_token": null }
\`\`\`

Plan limits apply to inbox creation (Free: 3, Developer: 10, Startup: 150). Over-limit creates return \`403 {"name": "plan_limit_exceeded", "message": "…"}\`.
`
};

const messages: DocPage = {
  slug: "api/messages",
  title: "API Reference: Messages",
  description: "Send, reply, forward, search, and manage messages.",
  markdown: `# Messages

## Endpoints

- \`GET /v0/inboxes/{inbox_id}/messages\` — list (filters: \`labels\`, \`before\`/\`after\`)
- \`GET /v0/inboxes/{inbox_id}/messages/search?query=\` — search
- \`GET /v0/inboxes/{inbox_id}/messages/{msg_id}\` — fetch one message
- \`GET /v0/inboxes/{inbox_id}/messages/{msg_id}/raw\` — raw RFC 5322 source
- \`GET /v0/inboxes/{inbox_id}/messages/{msg_id}/attachments/{att_id}\` — download an attachment
- \`POST /v0/inboxes/{inbox_id}/messages/send\` — send
- \`POST /v0/inboxes/{inbox_id}/messages/{msg_id}/reply\` — reply
- \`POST /v0/inboxes/{inbox_id}/messages/{msg_id}/reply-all\` — reply all
- \`POST /v0/inboxes/{inbox_id}/messages/{msg_id}/forward\` — forward
- \`PATCH /v0/inboxes/{inbox_id}/messages/{msg_id}\` — update labels / read state
- \`DELETE /v0/inboxes/{inbox_id}/messages/{msg_id}\` — delete
- \`POST /v0/inboxes/{inbox_id}/messages/batch-get\` — batch fetch
- \`PATCH /v0/inboxes/{inbox_id}/messages/batch-update\` — batch update

## Send

\`\`\`bash
curl -X POST https://api.wzrd.tech/v0/inboxes/scout@wzrd.tech/messages/send \\
  -H "Authorization: Bearer $WZRDMAIL_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "to": ["human@gmail.com"],
    "subject": "Report ready",
    "text": "Done. Reply to approve.",
    "attachments": [{"filename": "report.pdf", "content_type": "application/pdf", "content": "<base64>"}],
    "labels": ["reports"],
    "client_id": "send-report-1"
  }'
\`\`\`

Optional fields: \`cc\`, \`bcc\`, \`html\`, \`reply_to\`, \`headers\`.

## Limits

- ≤50 recipients per message
- Outbound message size ≤5 MiB — larger returns \`413 {"name": "message_too_large", "message": "…"}\`
- Inbound messages stored up to 25 MiB

## Reading messages

Received messages include \`extracted_text\` — the reply content with quoted history stripped:

\`\`\`json
{
  "message_id": "msg_01J…",
  "thread_id": "thread_01J…",
  "inbox_id": "scout@wzrd.tech",
  "from": "human@gmail.com",
  "subject": "Re: Report ready",
  "text": "Approved!\\n\\n> Done. Reply to approve.",
  "extracted_text": "Approved!",
  "labels": ["received"],
  "created_at": "2026-08-31T17:10:00Z"
}
\`\`\`
`
};

const threads: DocPage = {
  slug: "api/threads",
  title: "API Reference: Threads",
  description: "Conversation threads built from RFC 5322 lineage.",
  markdown: `# Threads

Messages are grouped into threads via RFC 5322 lineage (\`Message-ID\` / \`In-Reply-To\` / \`References\`), so a whole conversation is one queryable object.

## Endpoints

- \`GET /v0/inboxes/{inbox_id}/threads\` — list threads for an inbox
- \`GET /v0/inboxes/{inbox_id}/threads/search?query=\` — search
- \`GET /v0/inboxes/{inbox_id}/threads/{thread_id}\` — fetch one thread
- \`PATCH /v0/inboxes/{inbox_id}/threads/{thread_id}\` — update labels / read state
- \`DELETE /v0/inboxes/{inbox_id}/threads/{thread_id}\` — delete
- Org-wide: \`GET /v0/threads\`, \`GET /v0/threads/search\`, \`GET /v0/threads/{id}\`

## List threads

\`\`\`bash
curl https://api.wzrd.tech/v0/inboxes/scout@wzrd.tech/threads \\
  -H "Authorization: Bearer $WZRDMAIL_API_KEY"
\`\`\`

\`\`\`json
{
  "items": [
    {
      "thread_id": "thread_01J…",
      "inbox_id": "scout@wzrd.tech",
      "subject": "Report ready",
      "message_count": 2,
      "last_message_at": "2026-08-31T17:10:00Z"
    }
  ],
  "next_page_token": null
}
\`\`\`
`
};

const webhooks: DocPage = {
  slug: "api/webhooks",
  title: "API Reference: Webhooks",
  description: "Standard Webhooks (Svix-compatible) event delivery.",
  markdown: `# Webhooks

Webhooks are signed with the Standard Webhooks scheme — the same scheme AgentMail uses via Svix — so existing Svix verification code works unchanged.

## Endpoints

- \`GET /v0/webhooks\` · \`POST /v0/webhooks\` — org-wide
- \`GET /v0/webhooks/{id}\` · \`PATCH /v0/webhooks/{id}\` · \`DELETE /v0/webhooks/{id}\`
- \`GET /v0/webhooks/{id}/headers\` · \`PATCH /v0/webhooks/{id}/headers\` — custom headers
- Inbox-scoped mirrors under \`/v0/inboxes/{inbox_id}/webhooks…\`

## Create a webhook

\`\`\`bash
curl -X POST https://api.wzrd.tech/v0/webhooks \\
  -H "Authorization: Bearer $WZRDMAIL_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"url": "https://example.com/api/inbound/email", "event_types": ["message.received"], "client_id": "wh-1"}'
\`\`\`

The response includes a \`whsec_\` signing secret, shown once.

## Event envelope

Every state change emits exactly one immutable event:

\`\`\`json
{
  "event_id": "evt_01J…",
  "type": "message.received",
  "created_at": "2026-08-31T17:04:05Z",
  "organization_id": "org_…",
  "pod_id": "pod_…",
  "inbox_id": "scout@wzrd.tech",
  "data": { "message": { "…": "full message object, extracted_text included" } }
}
\`\`\`

Event types: \`message.received\`, \`message.sent\`, \`message.delivered\`, \`message.bounced\`, \`message.complained\`, \`message.rejected\`, \`domain.verified\`.

## Verifying signatures

Deliveries carry \`svix-id\`, \`svix-timestamp\`, and \`svix-signature\` headers (\`v1,\` + base64 HMAC-SHA256 over \`{id}.{timestamp}.{payload}\` with your \`whsec_\` secret). Any Svix / Standard Webhooks verification library verifies them unchanged.

## Delivery & retries

POST with a 10 s timeout; success is any 2xx. Retries at 30 s, 5 m, 30 m, 2 h, 8 h, then dead-letter. Deliveries are idempotent by event id — dedupe on \`event_id\` in your handler.
`
};

const migrate: DocPage = {
  slug: "migrate-from-agentmail",
  title: "Migrate from AgentMail",
  description:
    "Cut over from AgentMail: base URL, key prefix, one webhook, inbox-scoped draft-only keys, lists alias, MCP and plugin.",
  markdown: `# Migrate from AgentMail

wzrdmail is shape-compatible with AgentMail v0. Code written against AgentMail ports by changing a base URL and a key prefix — no schema change, no handler rewrite. This page is the cutover contract used by Air; it applies to any AgentMail integration.

## What stays the same

- **Paths**: \`/v0/inboxes\`, \`/v0/inboxes/{inbox_id}/messages/send\`, \`/v0/inboxes/{inbox_id}/drafts\`, \`/v0/webhooks\`, \`/v0/api-keys\`, \`/v0/agent/sign-up\`, \`/v0/agent/verify\`.
- **Field casing**: \`inbox_id\`, \`message_id\`, \`thread_id\`, \`draft_id\`, \`extracted_text\`, \`next_page_token\`, \`client_id\` — snake_case throughout. Collections are keyed by their plural (\`inboxes\`, \`messages\`, \`threads\`, \`drafts\`).
- **Error envelope**: \`{"name": "…", "message": "…"}\` with the same HTTP statuses.
- **Webhook signing**: Standard Webhooks / Svix scheme (\`svix-id\`, \`svix-timestamp\`, \`svix-signature\`, \`whsec_\` secrets). Existing Svix verification code verifies wzrdmail deliveries unchanged.
- **Idempotency**: \`client_id\` on create bodies and the \`Idempotency-Key\` header on send/reply both work.
- **Lists**: \`POST /v0/inboxes/{inbox_id}/lists/receive/block\` and \`DELETE …/lists/receive/block/{entry}\` are served as aliases of the native \`/lists\` endpoints, so block-list code ports unchanged.

## What changes

| AgentMail | wzrdmail |
| --- | --- |
| \`https://api.agentmail.to/v0\` | \`https://api.wzrd.tech/v0\` |
| \`AGENTMAIL_API_KEY\` | \`WZRDMAIL_API_KEY\` |
| AgentMail key prefix | \`wm_live_…\` / \`wm_test_…\` |
| \`Authorization: Bearer <key>\` | same — or \`x-api-key: wm_…\` |
| \`whsec_\` secret from AgentMail | new \`whsec_\` secret returned once by \`POST /v0/webhooks\` |
| \`https://mcp.agentmail.to/mcp\` | \`https://mcp.mail.wzrd.tech/mcp\` |
| \`agentmail\` CLI | \`wzrdmail\` (alias \`wm\`) |
| \`AgentMailClient\` (TS) / \`AgentMail\` (Python) | \`WzrdMailClient\` (\`npm i wzrdmail\`) / \`WzrdMail\` (\`pip install wzrdmail\`) |
| \`official/email/agentmail\` skill | \`plugins/agents\` skills (\`send-email\`, \`check-email\`, \`manage-inboxes\`, …) |

## Cutover steps

### 1. Provision inboxes

One pod per tenant: \`POST /v0/pods\` with \`{ "client_id": "<user_id>" }\` (idempotent — a retry returns the same pod; \`GET /v0/pods\` lists them, \`DELETE /v0/pods/{pod_id}\` retires the pod and its inboxes). Then \`POST /v0/pods/{pod_id}/inboxes\` (or \`POST /v0/inboxes\` with \`"pod_id"\`) with \`{ "username", "client_id" }\`. Inboxes land on \`@wzrd.tech\`, which is pre-verified; re-runs with the same \`client_id\` return the existing inbox.

### 2. Register one webhook at your existing endpoint

\`\`\`http
POST /v0/webhooks
{ "url": "https://<your-app>/api/inbound/email", "event_types": ["message.received"], "pod_ids": ["pod_…"], "client_id": "inbound-v1" }
\`\`\`

The response carries \`secret\` (\`whsec_…\`) once. Store it as \`WZRDMAIL_WEBHOOK_SECRET\` and hand it to your existing Svix verifier — the verification code does not change. Omit \`pod_ids\` to receive every pod in the organization.

### 3. Mint draft-only keys for sandboxes

Where AgentMail gave an agent a scoped key that could draft but not send:

\`\`\`http
POST /v0/api-keys
{ "name": "box-<user>", "inbox_id": "<user>@wzrd.tech", "permissions": ["read", "drafts"] }
\`\`\`

The key sees only that inbox. \`create_draft\` / \`POST …/drafts\` succeed; \`…/messages/send\`, \`…/drafts/{id}/send\`, replies, forwards, \`POST /v0/inboxes\`, and every other inbox return \`403 forbidden\`. Keep a \`send\` key in the control plane that reviews and sends drafts.

### 4. Swap the env vars

\`AGENTMAIL_API_KEY\` → \`WZRDMAIL_API_KEY\`, base URL → \`https://api.wzrd.tech\`, webhook secret → the new \`whsec_\`. If you gate the switch behind a flag (e.g. \`MAIL_PROVIDER=wzrdmail\`), both providers can run side by side until validation passes.

### 5. Repoint the agent's MCP and skills

Replace the AgentMail MCP entry with:

\`\`\`json
{ "mcpServers": { "wzrdmail": { "type": "http", "url": "https://mcp.mail.wzrd.tech/mcp", "headers": { "x-api-key": "\${WZRDMAIL_API_KEY}" } } } }
\`\`\`

Tool names are \`list_inboxes\`, \`list_messages\`, \`get_message\`, \`send_message\`, \`reply_to_message\`, \`reply_all_to_message\`, \`forward_message\`, \`list_threads\`, \`get_thread\`, \`search_threads\`, \`create_draft\`, \`update_draft\`, \`send_draft\`, \`get_attachment\`, and more (see the Integrations page). Install the native plugin in place of the AgentMail skill.

### 6. Verify

Send from a wzrdmail inbox, reply externally, and confirm your endpoint receives \`message.received\` with a valid signature and an \`extracted_text\` field. Then, with the draft-only key, confirm \`create_draft\` succeeds and \`send_draft\` returns \`403\`.

## Inbox-scoped API keys

\`POST /v0/api-keys\` accepts an optional \`inbox_id\` alongside \`pod_id\` and \`permissions\`:

- The key inherits the inbox's pod; \`pod_id\`, if also given, must match.
- \`GET /v0/inboxes\` returns only that inbox; \`GET /v0/inboxes/{other}\` is \`403\`.
- The key cannot create inboxes, pods, domains, or webhooks, cannot read organization usage, and can only mint further keys for the same inbox with a subset of its own permissions.
- \`permissions\` default to the creator's; \`["read", "drafts"]\` is the draft-only shape. \`send\` implies \`drafts\`.

## Lists receive/block alias

\`\`\`http
POST   /v0/inboxes/{inbox_id}/lists/receive/block          { "pattern": "spam@example.com" }   # or { "entry": … } / { "address": … } / { "domain": "junk.example" }
GET    /v0/inboxes/{inbox_id}/lists/receive/block
DELETE /v0/inboxes/{inbox_id}/lists/receive/block/{entry}   # entry = lst_… id or the exact pattern
\`\`\`

Rows are identical to \`POST /v0/inboxes/{inbox_id}/lists\` with \`{ "kind": "block", "pattern" }\`. Blocked senders emit \`message.rejected\` instead of \`message.received\`.

## Known divergences

- Outbound attachments over 5 MiB are rejected with \`{"name": "message_too_large"}\`.
- No IMAP/SMTP bridge; no WebSocket \`Subscribe\` message type — use \`wzrdmail events tail\` or webhooks.
- \`search\` endpoints do substring/field match (semantic search later).
- Event types are \`message.received|sent|delivered|bounced|complained|rejected\` and \`domain.verified\`; there is no \`message.received.spam\` variant.
`
};

const integrations: DocPage = {
  slug: "integrations",
  title: "Integrations",
  description: "Native agent plugin (Claude Code, Cursor, Codex), hosted MCP server, CLI, SDKs, and webhooks.",
  markdown: `# Integrations

## Agent plugin (Claude Code, Cursor, Codex, Open Plugins)

The native plugin lives at [\`plugins/agents\`](https://github.com/gratitude5dee/wzrdmail/tree/main/plugins/agents) and ships eight skills — \`send-email\`, \`check-email\`, \`manage-inboxes\`, \`wzrdmail\` (SDK), \`wzrdmail-cli\`, \`wzrdmail-mcp\`, \`wzrdmail-toolkit\`, \`agent-email-patterns\` — plus \`.mcp.json\` pointing at the hosted MCP server.

\`\`\`bash
# Claude Code
claude plugin marketplace add gratitude5dee/wzrdmail --path plugins/agents
claude plugin install wzrdmail

# Cursor — add plugins/agents as a local plugin, or merge .mcp.json into .cursor/mcp.json
# Codex — point at plugins/agents/.agents/plugins/marketplace.json
\`\`\`

Set \`WZRDMAIL_API_KEY\` in the client's environment; the skills never embed keys.

## MCP server

\`\`\`text
https://mcp.mail.wzrd.tech/mcp        Streamable HTTP
x-api-key: wm_live_…                  or  Authorization: Bearer wm_live_…
\`\`\`

\`\`\`bash
claude mcp add --transport http wzrdmail https://mcp.mail.wzrd.tech/mcp --header "x-api-key: \${WZRDMAIL_API_KEY}"
\`\`\`

All 24 tools: \`whoami\`, \`check_new_mail\`, \`list_inboxes\`, \`create_inbox\`, \`get_inbox\`, \`list_messages\`, \`get_message\`, \`send_message\`, \`reply_to_message\`, \`reply_all_to_message\`, \`forward_message\`, \`update_message\`, \`list_threads\`, \`get_thread\`, \`search_threads\`, \`list_drafts\`, \`create_draft\`, \`update_draft\`, \`send_draft\`, \`get_attachment\`, \`list_webhooks\`, \`create_webhook\`, \`list_domains\`, \`get_usage\`. Tools are filtered by the key's permissions: an inbox-scoped \`read,drafts\` key can \`create_draft\` but \`send_message\` / \`send_draft\` return \`forbidden\`.

The same URL also accepts OAuth 2.1 with PKCE: a client that connects with no credentials is sent through browser sign-in and a consent screen, and comes back with a token scoped to \`mail:read\`, \`mail:drafts\` and \`mail:send\` on one inbox. See the [MCP server reference](/mcp).

## Support matrix

Every row points at a real artifact, not a claim.

| Client | Mechanism | Artifact |
| --- | --- | --- |
| Claude Code / Claude Desktop | MCP with \`x-api-key\`, or OAuth 2.1 (PKCE) at the bare URL | \`plugins/agents\` plugin; \`claude mcp add --transport http wzrdmail https://mcp.mail.wzrd.tech/mcp\` |
| Cursor | MCP with \`x-api-key\` | \`plugins/agents\` local plugin, or \`.mcp.json\` merged into \`.cursor/mcp.json\` |
| Codex | MCP with \`x-api-key\` | \`plugins/agents/.agents/plugins/marketplace.json\` |
| Hermes | MCP with \`x-api-key\` | \`mcp_servers\` entry in \`~/.hermes/config.yaml\`; \`wzrdmail-mcp\` skill |
| Meta Muse | MCP + OAuth 2.1 (PKCE) | the connector listing on Meta's Muse Platform (submission pending); [connector page](/mcp/muse) |
| Any REST client | HTTPS + \`Authorization: Bearer\` | [Quickstart](/quickstart) |

## CLI

\`\`\`bash
npm i -g @wzrdmail/cli          # binaries: wzrdmail, wm
export WZRDMAIL_API_KEY=wm_live_…
wzrdmail inboxes list
wzrdmail messages send <inbox_id> --to a@example.com --subject Hi --text "Hello"
wzrdmail keys create --name box --inbox-id agent@wzrd.tech --permissions read,drafts
wzrdmail events tail --inbox-ids agent@wzrd.tech
\`\`\`

\`WZRDMAIL_BASE_URL\` overrides the API host; \`WZRDMAIL_CONFIG_PATH\` relocates the saved login.

## SDKs

\`\`\`bash
npm install wzrdmail     # import { WzrdMailClient } from "wzrdmail"
pip install wzrdmail     # from wzrdmail import WzrdMail
\`\`\`

## Webhooks

Standard Webhooks / Svix signing (\`svix-id\`, \`svix-timestamp\`, \`svix-signature\`, \`whsec_\` secret). Any Svix verifier or \`verifyWebhook\` from \`@wzrdmail/core\` works. Subscribe per inbox (\`inbox_id\`), per pod set (\`pod_ids\`), or organization-wide.
`
};

const mcp: DocPage = {
  slug: "mcp",
  title: "MCP server",
  description:
    "The hosted MCP server: endpoint, API-key and OAuth 2.1 auth, the 24 tools and their scopes, JSON vs streaming, polling, limits, revocation.",
  markdown: `# MCP server

wzrdmail runs a hosted [Model Context Protocol](https://modelcontextprotocol.io) server. Point any Streamable HTTP MCP client at one URL and it gets 24 tools for sending, reading, replying to and polling real email on \`@wzrd.tech\`.

\`\`\`text
https://mcp.mail.wzrd.tech/mcp            production
https://staging.mcp.mail.wzrd.tech/mcp    staging
\`\`\`

The server is a thin front end over the REST API at \`https://api.wzrd.tech/v0\`. Every tool call becomes one API call under the same identity, so the permission checks, plan limits and tenant isolation described in [Authentication](/api/auth) apply unchanged.

## Authentication

Two credentials are accepted on the same URL. Pick one; you never need both.

### API key

Mint a key in the [console](https://console.mail.wzrd.tech) or with \`POST /v0/api-keys\`, then send it as a header:

\`\`\`bash
claude mcp add --transport http wzrdmail https://mcp.mail.wzrd.tech/mcp \\
  --header "x-api-key: \${WZRDMAIL_API_KEY}"
\`\`\`

\`Authorization: Bearer wm_live_…\` is accepted as an equivalent alternative for clients that only support bearer auth. Never pass a key as a query-string parameter — it would end up in logs and shell history.

An API-key connection inherits exactly the key's scope and permissions: an organization key sees every inbox, an inbox-scoped key sees one, and \`read\`/\`drafts\`/\`send\`/\`admin\` decide which tools are registered.

### OAuth 2.1 with PKCE

Clients that speak OAuth connect to the **bare URL with no credentials**. The server is its own authorization server and advertises itself through the two well-known documents:

\`\`\`text
https://mcp.mail.wzrd.tech/.well-known/oauth-authorization-server
https://mcp.mail.wzrd.tech/.well-known/oauth-protected-resource/mcp
\`\`\`

| Endpoint | Purpose |
| --- | --- |
| \`POST /register\` | Dynamic client registration (RFC 7591). No pre-shared client secret needed. |
| \`GET /authorize\` | Browser sign-in and the consent screen. PKCE \`code_challenge_method=S256\` is required. |
| \`POST /token\` | Code exchange, refresh, and revocation (send \`token=…\`). |

The flow a user sees: the client opens \`/authorize\`; wzrdmail asks for an email address; someone with no wzrdmail account is asked to pick a username and gets \`<username>@wzrd.tech\` created there and then; a one-time code arrives by email and is entered; and a consent screen names the client, lets the user untick any optional scope and choose which single inbox the connection is pinned to. Approving mints an inbox-scoped API key behind the scenes and hands the client an access token.

Access tokens live 1 hour; refresh tokens rotate. The underlying key is never shown to the client — the token carries encrypted properties that only that token can unwrap.

## The 401 challenge

A request to \`/mcp\` with no credentials gets an RFC 9728 challenge, which is how an OAuth-capable client discovers where to register:

\`\`\`text
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer realm="OAuth", resource_metadata="https://mcp.mail.wzrd.tech/.well-known/oauth-protected-resource/mcp", scope="mail:read mail:drafts mail:send"

{ "name": "unauthorized", "message": "missing or invalid credentials" }
\`\`\`

An expired, revoked or malformed bearer token adds \`error="invalid_token"\` after \`resource_metadata\`. Clients that only do header keys can treat any 401 as "set \`x-api-key\`".

## Scopes

OAuth connections carry three scopes, which map onto the permission vocabulary the API already enforces.

| Scope | Permission | Grants |
| --- | --- | --- |
| \`mail:read\` | \`read\` | Read inboxes, messages, threads, drafts, attachments, webhooks, domains and usage; mark read and label; \`whoami\`; \`check_new_mail\` |
| \`mail:drafts\` | \`drafts\` | Compose and edit drafts without sending them |
| \`mail:send\` | \`send\` | Send, reply, reply-all, forward, and send a draft |

\`mail:read\` is mandatory — declining it denies the authorization. The other two can be unticked on the consent screen. **\`admin\` is never issued over OAuth**, so an OAuth connection cannot create inboxes or webhooks, mint keys, or touch org-level resources; do that with a key minted in the console.

## Tools

24 tools. Over OAuth a tool is only registered when the grant includes its scope, so a client never sees a tool that would answer \`forbidden\`. On the key lane every tool is registered and the API enforces permissions per call.

| Tool | Scope | What it does |
| --- | --- | --- |
| \`whoami\` | \`mail:read\` | Which \`@wzrd.tech\` address this connection owns, what it may do, whether the account is verified. Call it first. |
| \`check_new_mail\` | \`mail:read\` | Poll for mail that arrived since the last call. |
| \`list_inboxes\` | \`mail:read\` | List the inboxes this connection can see. |
| \`get_inbox\` | \`mail:read\` | One inbox: address, display name, pod. |
| \`create_inbox\` | \`admin\` key only | Create a new address. Not available over OAuth. |
| \`list_messages\` | \`mail:read\` | Messages in an inbox, newest first, with \`after\`/\`before\` filters. |
| \`get_message\` | \`mail:read\` | One message: headers, text, HTML, attachment list. |
| \`update_message\` | \`mail:read\` | Mark read or unread, add or remove labels. |
| \`send_message\` | \`mail:send\` | Send a new message from the inbox. |
| \`reply_to_message\` | \`mail:send\` | Reply to the sender, threaded correctly. |
| \`reply_all_to_message\` | \`mail:send\` | Reply to the sender and every other recipient. |
| \`forward_message\` | \`mail:send\` | Forward a message, attachments included. |
| \`list_threads\` | \`mail:read\` | Conversations in an inbox. |
| \`get_thread\` | \`mail:read\` | One conversation with its messages in order. |
| \`search_threads\` | \`mail:read\` | Substring and field search across threads. |
| \`list_drafts\` | \`mail:read\` | Unsent drafts. |
| \`create_draft\` | \`mail:drafts\` | Compose a draft without sending it. |
| \`update_draft\` | \`mail:drafts\` | Edit a draft in place. |
| \`send_draft\` | \`mail:send\` | Send an existing draft. |
| \`get_attachment\` | \`mail:read\` | Fetch one attachment's content and metadata. |
| \`list_webhooks\` | \`mail:read\` | List webhook subscriptions. |
| \`create_webhook\` | \`admin\` key only | Subscribe a URL to events. Not available over OAuth. |
| \`list_domains\` | \`mail:read\` | Custom domains and their verification state. |
| \`get_usage\` | \`mail:read\` | This month's usage per metric against plan limits. |

Every tool carries MCP annotations so a planner knows what it is about to do: the read-only tools are marked \`readOnlyHint\`, and the five sending tools are marked destructive and non-idempotent because mail that has left the system cannot be recalled. All create operations accept a \`client_id\` and return the prior result on replay, so a retry after a timeout does not double-send.

When the connection is pinned to one inbox, \`inbox_id\` is optional on every tool and defaults to that inbox.

## JSON and streaming

The same path answers two ways.

- **Streaming (default).** A POST whose \`Accept\` contains both \`application/json\` and \`text/event-stream\` gets a \`text/event-stream\` response and an \`mcp-session-id\` header, exactly as before. This is what Claude Code, Cursor, Codex and Hermes do.
- **Plain JSON.** A POST gets a single \`application/json\` response with no session header when any of these is true: the caller authenticated with an OAuth token; the \`Accept\` header is absent or lacks \`text/event-stream\`; or the request carries the header \`MCP-Response-Mode: json\`.

\`\`\`bash
curl -s -X POST https://mcp.mail.wzrd.tech/mcp \\
  -H "x-api-key: \${WZRDMAIL_API_KEY}" \\
  -H "Content-Type: application/json" \\
  -H "MCP-Response-Mode: json" \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
\`\`\`

\`MCP-Response-Mode: json\` is the documented escape hatch for any client behind a proxy, gateway or sandbox that cannot hold an SSE stream open. The JSON lane is stateless: no session id is issued and none is required on later calls.

Protocol versions \`2025-11-25\`, \`2025-06-18\`, \`2025-03-26\`, \`2024-11-05\` and \`2024-10-07\` are all accepted and echoed back by \`initialize\`.

## Polling for new mail

wzrdmail pushes events to [webhooks](/api/webhooks), but an MCP client has no address to be pushed to. \`check_new_mail\` is the poll primitive that replaces it:

\`\`\`json
{ "since": "2026-09-20T11:04:22.000Z", "limit": 20 }
\`\`\`

\`\`\`json
{ "messages": [ … ], "count": 2, "next_since": "2026-09-20T11:31:07.000Z" }
\`\`\`

Omit \`since\` on the first call. Persist \`next_since\` between runs and pass it back next time; when nothing arrived it comes back unchanged, so the loop never re-reads the same mail. A scheduled agent polling every few minutes is the intended shape. \`limit\` is 1–100 and defaults to 20.

## Limits

| Limit | Value |
| --- | --- |
| Free plan inboxes | 3 |
| Free plan sends | 100 per day, 3,000 emails per month |
| Free plan storage | 3 GB |
| Recipients per message | 50 |
| Outbound message size | 5 MiB including attachments |
| Collection page size | 20 by default, 100 maximum |
| Upstream timeout on the JSON lane | 15 s, returned as a JSON-RPC error |
| OAuth access token lifetime | 1 hour, refresh rotating |

Until an organization verifies its email with the one-time code, it is sandboxed: it can only email the address it signed up with. Over-limit calls answer \`{"name": "plan_limit_exceeded"}\`; \`429\` responses always carry \`Retry-After\`.

## Revoking access

- **Console.** Settings → Connected apps lists every OAuth connection. Disconnect revokes the key behind it; the next tool call fails with a re-authorize error.
- **API.** \`DELETE /v0/api-keys/{key_id}\` does the same thing for any key.
- **Protocol.** \`POST /token\` with a \`token=…\` parameter is the standard revocation request.
- **Expiry.** Access tokens expire after an hour regardless.

Revocation takes effect on the next call: the API re-validates the key on every request, so nothing is cached past it.

## See also

- [Meta Muse connector](/mcp/muse) — the connector listing built on this server.
- [Integrations](/integrations) — plugins, CLI, SDKs and webhooks.
- [Authentication](/api/auth) — keys, errors, pagination, idempotency.
`
};

const muse: DocPage = {
  slug: "mcp/muse",
  title: "Meta Muse connector",
  description:
    "Give a Meta Muse agent its own @wzrd.tech email address: what it can do, how to connect, the scopes, the limits, how to disconnect.",
  markdown: `# WZRD Mail for Meta Muse

**WZRD Mail gives your Muse agent a real email address.** Not a relay, not a mailbox you have to own somewhere else — an actual address on \`wzrd.tech\` that belongs to you, that anyone in the world can write to, and that your agent can send from, read, reply to and check for new mail.

Connecting takes about a minute. If you have never used wzrdmail before, the connect flow creates your account and your address as part of the same minute — there is nothing to sign up for first.

## What the connector does

Once connected, Muse can:

- Tell you which address it owns (\`whoami\`).
- Send email to anyone, from your \`@wzrd.tech\` address.
- Read the mail that address receives: messages, whole conversations, attachments.
- Reply, reply-all and forward, with correct threading, so conversations hold together.
- Write drafts and leave them for you to approve, instead of sending.
- Check for new mail on a schedule and act on what arrived.

A typical use: ask Muse to watch the address, and it checks every few minutes, summarizes what came in and drafts replies for you. Or hand the address out as a contact address for something you are running, and let Muse answer it.

## What it cannot do

Deliberately, over this connection Muse has **no administrative power**:

- It cannot create new inboxes or delete existing ones.
- It cannot create webhooks or change organization settings.
- It cannot mint or read API keys.
- It is pinned to **one inbox**. Even if your wzrdmail account has several addresses, this connection reaches exactly the one you chose when you approved it, and \`list_inboxes\` returns only that one.

Those actions need an API key created by a human in the wzrdmail console at [console.mail.wzrd.tech](https://console.mail.wzrd.tech). An OAuth connection is never granted them.

## Connecting, step by step

1. In Muse, add WZRD Mail as a connector, or point it at \`https://mcp.mail.wzrd.tech/mcp\`.
2. A wzrdmail sign-in page opens in your browser and asks for your email address. This is your own everyday address — it is how we reach you, and it is not the address your agent will get.
3. **If you are new to wzrdmail**, the next screen asks you to choose a username, and we create \`<username>@wzrd.tech\` for you there and then. Usernames are first-come, first-served; a short list of names such as \`admin\`, \`support\` and \`postmaster\` is reserved, and so are names that would impersonate a well-known person or brand. If you already have an account, this step is skipped.
4. We email you a 6-digit code. It expires in 10 minutes, you get 5 attempts, and you can ask for a new one after 60 seconds. Type it in. Verifying it is also what lifts the new-account sandbox, so your address can write to the outside world straight away.
5. A consent screen shows you exactly three things: which client is asking (Meta Muse), which permissions it wants — untick any you do not want to give — and which single inbox the connection will be pinned to, chosen from a list if you have more than one. Approve.
6. You are handed back to Muse. Ask it to call \`whoami\` and it will tell you its own address.

## Permissions, in plain words

The consent screen asks for up to three permissions.

| Permission | In plain words |
| --- | --- |
| \`mail:read\` | Read the mail in this one inbox — messages, conversations, attachments — and mark things read or labelled. Required; the connection is useless without it. |
| \`mail:drafts\` | Write and edit drafts. Drafts are never sent on their own. Optional. |
| \`mail:send\` | Actually send mail from your address: new messages, replies, forwards, and sending a draft. Optional — leave it off and Muse can only prepare mail for you to send yourself. |

If you want an agent that reads and proposes but never speaks for you, grant \`mail:read\` and \`mail:drafts\` and leave \`mail:send\` unticked. Muse will still be able to draft a reply to everything; it just cannot put it in the post.

Nothing beyond these three is available. There is no permission over this connection that lets Muse create addresses, spend money, or reach another inbox.

## How new mail reaches your agent

WZRD Mail cannot push a notification into Muse, so Muse pulls. The \`check_new_mail\` tool returns everything that arrived since the last time it looked, along with a \`next_since\` marker to use on the following call. A scheduled Muse agent that runs every few minutes and passes \`next_since\` back each time will see each message exactly once, without re-reading the whole inbox.

Ask for it in words — "check my wzrd mail every ten minutes and tell me if anything needs an answer" — and Muse wires the loop itself.

## Limits

A new account is on the free plan.

| Limit | Free plan |
| --- | --- |
| Inboxes | 3 |
| Sending | 100 emails per day |
| Total email volume | 3,000 emails per month |
| Stored mail | 3 GB |
| Custom domains | 0 |
| Seats | 1 |

And regardless of plan:

| Limit | Value |
| --- | --- |
| Recipients per message | 50 |
| Outgoing message size | 5 MiB, attachments included |
| Messages returned per call | 20 by default, 100 maximum |

Paid plans raise the per-plan numbers; see [mail.wzrd.tech](https://mail.wzrd.tech) for current pricing. Sending to addresses outside your own is enabled once the emailed code is verified, which happens while you connect. There are no regional restrictions.

Each tool call is a single HTTPS request answered as JSON, normally well inside 20 seconds; if the backend is slow the call returns an error rather than hanging.

## Disconnecting

Two ways, either is enough:

1. **In wzrdmail.** Sign in at [console.mail.wzrd.tech](https://console.mail.wzrd.tech), open Settings → Connected apps, find Meta Muse and press Disconnect. The next tool call Muse makes fails and tells it to reconnect.
2. **In Muse.** Remove the connector. The access token stops being used and expires within the hour.

Disconnecting does not delete anything. Your address, your mail and your account stay exactly as they were, and reconnecting later starts a fresh consent screen. To delete the inbox itself, or to have your data erased, use the console or write to \`privacy@wzrd.tech\`.

## Details, if you want them

- Endpoint: \`https://mcp.mail.wzrd.tech/mcp\` — a hosted MCP server, also reachable with an API key header for clients that prefer one. Full reference: [MCP server](/mcp).
- Authorization: OAuth 2.1 with PKCE (\`S256\`) and dynamic client registration. Access tokens last an hour; refresh tokens rotate.
- Your wzrdmail API key is created for you behind the consent screen and is never shown to Muse or to any other client.
- [Privacy policy](/legal/privacy) · [Terms of service](/legal/terms) · support: \`support@wzrd.tech\`.
`
};

const privacy: DocPage = {
  slug: "legal/privacy",
  title: "Privacy Policy",
  description:
    "What wzrdmail stores, where it stores it, who processes it, and how to have it deleted. Draft pending legal review.",
  markdown: `# Privacy Policy

## READ THIS FIRST — DRAFT PENDING LEGAL REVIEW

**This document has NOT been reviewed by a lawyer. The operating entity, the registered address, the governing law and the effective date below are PLACEHOLDERS. They must be filled in by a human and the whole document reviewed by counsel before wzrdmail is submitted to any app directory, including Meta's Muse Platform.** The descriptions of what the service actually does with data are accurate as of the last-updated date; the legal framing around them is not final and is not a legal representation by anyone.

| Field | Status |
| --- | --- |
| Operating entity | **[ENTITY NAME — PLACEHOLDER, NEEDS LEGAL REVIEW]** |
| Registered address | **[REGISTERED ADDRESS — PLACEHOLDER, NEEDS LEGAL REVIEW]** |
| Governing law and venue | **[JURISDICTION — PLACEHOLDER, NEEDS LEGAL REVIEW]** |
| Effective date | **[EFFECTIVE DATE — PLACEHOLDER, NEEDS LEGAL REVIEW]** |
| Last updated | 2026-09-20 |

## What this service is

wzrdmail ("the service") gives people and their software agents real email inboxes on \`wzrd.tech\`. Mail sent to one of those addresses is received, stored and made available over an API, an MCP server, a command-line tool and a web console. Because it is real email, the service necessarily handles the contents of your messages.

## What we collect

**Account data.** The email address of the person who signed up, an organization name if you set one, and a record of whether that address has been verified.

**Inboxes.** The addresses you create on \`wzrd.tech\`, their display names, and when they were created or retired.

**Message data.** For mail sent to or from your inboxes: envelope and headers (sender, recipients, subject, message id, timestamps), the message body in text and HTML, and attachments. Inbound mail is stored as the original MIME message plus a parsed copy.

**Credentials.** API keys are stored only as a SHA-256 hash together with a 12-character non-secret prefix used to identify them in a list. The plaintext key is shown to you once at creation and is stored nowhere. Sign-in codes are one-time, expire in 10 minutes, and are stored hashed or held entirely by our sign-in provider. OAuth grants store an encrypted reference that only the presented access token can unwrap.

**Operational data.** Per-organization usage counters (messages sent, messages received, bytes stored), rate-limit counters keyed by IP address and email address, and application logs. Logs record the shape of a request — path, status, timing, error names — and deliberately do not record message bodies or credentials.

We do not use tracking cookies, we do not run third-party analytics or advertising scripts in the console, and we do not sell personal data.

## Where it is stored

The service runs entirely on [Cloudflare](https://www.cloudflare.com):

| Data | Store |
| --- | --- |
| Accounts, inboxes, message metadata, key hashes, usage counters | Cloudflare D1 (SQLite) |
| Raw MIME messages and attachment bodies | Cloudflare R2 (object storage) |
| Rate-limit counters, short-lived sign-in state, OAuth grants | Cloudflare KV |
| Application code | Cloudflare Workers |

Cloudflare operates a global network; data may be processed in any region where Cloudflare runs the relevant service. Data is encrypted in transit (TLS) and at rest by the underlying Cloudflare services.

## Who else processes it

| Sub-processor | What they do | What they see |
| --- | --- | --- |
| Cloudflare | Compute, storage, inbound and outbound email routing | Everything listed above |
| thirdweb | Delivers and verifies the one-time codes used to sign in and to verify an account | The email address a code is sent to, and the code |
| Stripe | Reserved for billing on paid plans. Not in use today; no payment data is processed until paid plans are enabled | Billing contact and payment details, when enabled |

If we add or change a sub-processor we will update this list before the change takes effect.

Beyond these, your outgoing mail goes wherever you address it, and incoming mail comes from wherever it was sent. Email is not a confidential channel between servers we control; treat anything you send as readable by the recipient's mail provider.

## How long we keep it

- **Mail in an inbox** is kept until you delete it or delete the account.
- **Deleted messages and threads** move to trash and are permanently removed — the stored MIME object and its attachments deleted from R2, the rows deleted from D1 — by a scheduled purge 30 days later.
- **Deleting an inbox** retires the address immediately: it stops accepting mail and disappears from the API. Its stored mail follows the trash-and-purge path above.
- **API key hashes** are removed when the key is revoked.
- **Rate-limit counters** expire on their own, typically within hours.
- **Logs** are retained for the period Cloudflare's platform retains them and are not used to build a profile of you.

To have an entire organization erased — inboxes, mail, attachments, keys and account record — write to \`privacy@wzrd.tech\` from the account's owner address.

## Your choices

- Read, export or delete any message through the API, the CLI or the console.
- Revoke any API key, or disconnect any OAuth application, at any time from Settings → Connected apps. Revocation takes effect on the next request.
- Ask us what we hold about you, ask for a copy, or ask for deletion, at \`privacy@wzrd.tech\`.

**[THE STATUTORY RIGHTS SECTION — GDPR/UK GDPR/CCPA APPLICABILITY, LEGAL BASES, DATA-TRANSFER MECHANISM, DPO OR REPRESENTATIVE, AND COMPLAINT ROUTE — IS A PLACEHOLDER AND MUST BE WRITTEN BY COUNSEL.]**

## Children

The service is not directed at children and we do not knowingly create accounts for anyone under the age at which they can consent on their own. **[MINIMUM AGE — PLACEHOLDER, NEEDS LEGAL REVIEW.]**

## Security

API keys are stored as hashes; plaintext is never written down. Every request is authenticated and re-validated against the database, and every query is scoped to one tenant. Outbound sending is throttled per plan and unverified accounts can only email the address that created them. If you believe you have found a vulnerability, write to \`security@wzrd.tech\`.

## Changes

We will update this page when the service changes and move the last-updated date. Material changes will be announced to account owners by email.

## Contact

- Privacy questions and data requests: \`privacy@wzrd.tech\`
- Legal notices: \`legal@wzrd.tech\`
- Abuse reports: \`abuse@wzrd.tech\`
- Everything else: \`support@wzrd.tech\`

See also the [Terms of Service](/legal/terms).
`
};

const terms: DocPage = {
  slug: "legal/terms",
  title: "Terms of Service",
  description:
    "The rules for using wzrdmail inboxes: acceptable use, sending limits, suspension, and liability. Draft pending legal review.",
  markdown: `# Terms of Service

## READ THIS FIRST — DRAFT PENDING LEGAL REVIEW

**This document has NOT been reviewed by a lawyer. The operating entity, the registered address, the governing law and the effective date below are PLACEHOLDERS. They must be filled in by a human and the whole document reviewed by counsel before wzrdmail is submitted to any app directory, including Meta's Muse Platform.** The descriptions of how the service behaves are accurate as of the last-updated date. The warranty, liability, indemnity and dispute sections below are marked as placeholders and form no agreement in their current state.

| Field | Status |
| --- | --- |
| Operating entity | **[ENTITY NAME — PLACEHOLDER, NEEDS LEGAL REVIEW]** |
| Registered address | **[REGISTERED ADDRESS — PLACEHOLDER, NEEDS LEGAL REVIEW]** |
| Governing law and venue | **[JURISDICTION — PLACEHOLDER, NEEDS LEGAL REVIEW]** |
| Effective date | **[EFFECTIVE DATE — PLACEHOLDER, NEEDS LEGAL REVIEW]** |
| Last updated | 2026-09-20 |

## 1. What you get

wzrdmail gives you one or more email addresses on the \`wzrd.tech\` domain and an API, MCP server, CLI and console for sending and receiving mail through them. Addresses are allocated first-come, first-served. You may use them for yourself or for software agents acting on your behalf; either way, you are responsible for everything sent from them.

## 2. Your account

You need a working email address to create an account, and you verify it with a one-time code. Keep your API keys secret: anyone holding a key can act as you. Revoke a key the moment you think it has leaked, from the console or with \`DELETE /v0/api-keys/{key_id}\`.

Addresses are shared infrastructure. A short list of local parts — including \`admin\`, \`abuse\`, \`billing\`, \`legal\`, \`postmaster\`, \`privacy\`, \`security\` and \`support\` — is reserved and cannot be claimed, and usernames that impersonate a well-known person or brand are refused.

## 3. Acceptable use

Because every address you create carries the reputation of \`wzrd.tech\`, these rules are enforced strictly and without notice.

You must not use the service to:

- Send unsolicited bulk email, spam, or messages to addresses you did not obtain consent from.
- Phish, impersonate a person or organization, or forge headers to disguise where a message came from.
- Distribute malware, or link to it.
- Harass, threaten, or abuse anyone.
- Break the law in your jurisdiction or the recipient's.
- Evade the limits below — for example, by creating many accounts to raise your effective sending cap.
- Resell raw sending capacity, or operate the service as an open relay for third parties you do not control.

If you send on behalf of an agent, you are still the sender. "The model did it" is not a defence.

## 4. Limits

Limits are enforced server-side and are part of the agreement, not a soft target.

| Limit | Value |
| --- | --- |
| Free plan inboxes | 3 |
| Free plan sending | 100 emails per day, 3,000 per month |
| Free plan storage | 3 GB |
| Recipients per message | 50 |
| Outbound message size | 5 MiB including attachments |

Until you verify your email address, your account is sandboxed and can only send to the address it signed up with. Paid plans raise the per-plan numbers; the per-message ceilings apply to everyone. We may lower a limit for a specific account if its sending pattern threatens the domain's deliverability.

## 5. Your content

Your mail is yours. You grant us only the permissions needed to run the service: to receive, store, transmit, index for your own search, and deliver your messages, and to process them as described in the [Privacy Policy](/legal/privacy). We do not read your mail to train models and we do not sell it.

You are responsible for having the right to send what you send.

## 6. Suspension and termination

We may suspend or terminate an inbox, an account, or a specific API key — immediately and without prior notice where the harm is ongoing — if it is being used in breach of section 3, if it threatens the deliverability or reputation of \`wzrd.tech\`, if it is not paid for, or if we are required to by law. Where it is safe to do so we will tell you what happened and why.

You may close your account at any time. On closure we delete your inboxes and their stored mail as described in the [Privacy Policy](/legal/privacy).

Report abuse originating from a \`wzrd.tech\` address to \`abuse@wzrd.tech\`.

## 7. Availability

The service is provided on a best-effort basis and there is no uptime commitment on the free plan. **[SERVICE LEVEL COMMITMENTS FOR PAID PLANS — PLACEHOLDER, NEEDS LEGAL REVIEW.]** Email is a store-and-forward system with many parties in the path; we cannot guarantee that a message you send will be accepted, or not filtered, by its recipient.

## 8. Fees

Free plan accounts pay nothing. Paid plans, when enabled, are billed in advance and are non-refundable except where the law requires otherwise. **[BILLING, RENEWAL, PRICE-CHANGE, TAX AND REFUND TERMS — PLACEHOLDER, NEEDS LEGAL REVIEW.]**

## 9. Warranties, liability and indemnity

**[THE ENTIRE WARRANTY DISCLAIMER, LIMITATION OF LIABILITY AND INDEMNITY SECTION IS A PLACEHOLDER AND MUST BE DRAFTED BY COUNSEL. Nothing in this section is currently in force, and no disclaimer or limitation should be assumed to apply.]**

## 10. Changes

We may change these terms as the service changes. We will move the last-updated date and, for material changes, email account owners. Continuing to use the service after a change takes effect means you accept it.

## 11. Governing law and disputes

**[GOVERNING LAW, VENUE AND DISPUTE-RESOLUTION PROCEDURE — PLACEHOLDER, NEEDS LEGAL REVIEW. No jurisdiction has been chosen.]**

## 12. Contact

- Legal notices: \`legal@wzrd.tech\`
- Abuse reports: \`abuse@wzrd.tech\`
- Security reports: \`security@wzrd.tech\`
- Support: \`support@wzrd.tech\`

See also the [Privacy Policy](/legal/privacy).
`
};

export const PAGES: readonly DocPage[] = [
  quickstart,
  agent,
  auth,
  inboxes,
  messages,
  threads,
  webhooks,
  integrations,
  migrate,
  mcp,
  muse,
  privacy,
  terms
];

export function findPage(slug: string): DocPage | undefined {
  return PAGES.find((p) => p.slug === slug);
}

export const INDEX_MARKDOWN = `# wzrdmail docs

Email for AI agents — real, persistent, two-way inboxes at \`@wzrd.tech\`, driven over REST, MCP, CLI, SDKs, webhooks, and WebSockets.

If you are an AI agent: fetch [/llms.txt](/llms.txt) for the index or [/llms-full.txt](/llms-full.txt) for the full corpus. Every page here also serves raw markdown via \`Accept: text/markdown\` or a \`.md\` suffix.

## Pages

${PAGES.map((p) => `- [${p.title}](/${p.slug}) — ${p.description}`).join("\n")}
`;

export function llmsTxt(): string {
  return `# wzrdmail

> Email for AI agents. Real, persistent, two-way inboxes at @wzrd.tech over REST, MCP, CLI, SDKs, webhooks, and WebSockets.

## Docs

${PAGES.map(
    (p) => `- [${p.title}](https://docs.mail.wzrd.tech/${p.slug}.md): ${p.description}`
  ).join("\n")}

## Optional

- [Full corpus](https://docs.mail.wzrd.tech/llms-full.txt): every docs page as one markdown file
`;
}

export function llmsFullTxt(): string {
  return PAGES.map((p) => p.markdown.trim()).join("\n\n---\n\n") + "\n";
}
