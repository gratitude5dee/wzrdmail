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

Tools: \`list_inboxes\`, \`create_inbox\`, \`get_inbox\`, \`list_messages\`, \`get_message\`, \`send_message\`, \`reply_to_message\`, \`reply_all_to_message\`, \`forward_message\`, \`update_message\`, \`list_threads\`, \`get_thread\`, \`search_threads\`, \`list_drafts\`, \`create_draft\`, \`update_draft\`, \`send_draft\`, \`get_attachment\`, \`list_webhooks\`, \`create_webhook\`, \`list_domains\`, \`get_usage\`. Tools are filtered by the key's permissions: an inbox-scoped \`read,drafts\` key can \`create_draft\` but \`send_message\` / \`send_draft\` return \`forbidden\`.

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

export const PAGES: readonly DocPage[] = [
  quickstart,
  agent,
  auth,
  inboxes,
  messages,
  threads,
  webhooks,
  integrations,
  migrate
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
