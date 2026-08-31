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
claude mcp add --transport http wzrdmail https://mcp.wzrd.tech/mcp
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
  description: "Cut over from AgentMail by changing a base URL and a key prefix.",
  markdown: `# Migrate from AgentMail

wzrdmail is shape-compatible with AgentMail v0. Code written against AgentMail ports by changing a base URL and a key prefix — no schema change, no handler rewrite.

## What stays the same

- **Paths**: \`/v0/inboxes/{inbox_id}/messages/send\`, \`/v0/agent/sign-up\`, \`/v0/agent/verify\`, and the rest of the v0 surface keep AgentMail's path shape.
- **Field casing**: \`inbox_id\`, \`extracted_text\`, \`page_token\`, \`client_id\` — snake_case throughout.
- **Error envelope**: \`{"name": "…", "message": "…"}\` with the same HTTP statuses.
- **Webhook signing**: Standard Webhooks / Svix scheme (\`svix-id\`, \`svix-timestamp\`, \`svix-signature\`, \`whsec_\` secrets). Existing Svix verification code verifies wzrdmail deliveries unchanged.
- **Onboarding**: \`POST /v0/agent/sign-up\` → OTP → \`POST /v0/agent/verify\`, same contract.

## What changes

| AgentMail | wzrdmail |
| --- | --- |
| \`https://api.agentmail.to/v0\` | \`https://api.wzrd.tech/v0\` |
| \`AGENTMAIL_API_KEY\` | \`WZRDMAIL_API_KEY\` |
| Key prefix (AgentMail's) | \`wm_live_…\` / \`wm_test_…\` |
| \`whsec_\` secret from Svix | new \`whsec_\` secret from \`POST /v0/webhooks\` |

## Cutover steps

1. **Provision inboxes.** Create your inboxes under one wzrdmail organization via \`POST /v0/inboxes\` (use pods to separate environments). Pass \`client_id\` so re-runs are idempotent.
2. **Point a webhook at your existing endpoint.** \`POST /v0/webhooks\` with your current inbound-email handler URL and the \`message.*\` event types you consume. Swap the \`whsec_\` secret in your handler's config for the new one — the verification code itself does not change.
3. **Swap the env vars.** Replace \`AGENTMAIL_API_KEY\` with \`WZRDMAIL_API_KEY\` and change the SDK / HTTP client base URL to \`https://api.wzrd.tech/v0\`.
4. **Verify.** Send a message from a wzrdmail inbox, reply to it externally, and confirm your webhook receives \`message.received\` with a valid signature and an \`extracted_text\` field.

## Known divergences

Where wzrdmail cannot match an AgentMail capability yet, the API returns an honest, specific error — never a silent downgrade:

- Outbound attachments over 5 MiB are rejected with \`{"name": "message_too_large", "message": "…"}\`.
- No IMAP/SMTP bridge in v1.
- \`search\` endpoints do substring/field match (semantic search later).
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
    (p) => `- [${p.title}](https://docs.wzrd.tech/${p.slug}.md): ${p.description}`
  ).join("\n")}

## Optional

- [Full corpus](https://docs.wzrd.tech/llms-full.txt): every docs page as one markdown file
`;
}

export function llmsFullTxt(): string {
  return PAGES.map((p) => p.markdown.trim()).join("\n\n---\n\n") + "\n";
}
