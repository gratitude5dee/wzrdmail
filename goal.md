goal.md: wzrdmail (V1)
Field
Value
Status
Build specification
Product
wzrdmail — email for AI agents, self-hosted on Cloudflare at `wzrd.tech`
Target
Public beta: paying customers can provision agent inboxes, send/receive mail, and connect any coding agent via API, MCP, or CLI
Primary outcome
An agent with only `curl` can get an inbox at `@wzrd.tech` in under two minutes; a human can pay for it with Stripe
Reference product
AgentMail (`agentmail.to`) — wzrdmail mirrors its API shape, webhook signing, and onboarding flow
Runtime
Cloudflare only: Workers, Email Routing (inbound), Email Service (outbound), D1, R2, KV, Queues, Durable Objects
First customer
The Air platform (air 2.0) — currently on AgentMail; cutover is an env-var swap, not a rewrite
Last verified
2026-08-31
This document is the specification of record for the wzrdmail repository. It is written to be executed top-to-bottom by an autonomous engineer (Devin or equivalent). Where this specification names a Cloudflare limit or product status, it was verified against Cloudflare documentation on 2026-08-31; re-verify limits before relying on them in code, and record the number you observed in a code comment next to the enforcement.
Read §2 (non-negotiables) and §3 (non-goals) before writing any code. If an implementation choice conflicts with §2, the implementation is wrong.
0. The outcome
wzrdmail is a micro-SaaS: the AgentMail product category, self-hosted on our own Cloudflare account, under our own domain, with our own billing. Agents get real, persistent, two-way email inboxes (`somebot@wzrd.tech`) they can drive over REST, MCP, CLI, SDKs, webhooks, and WebSockets. Humans get a console to provision inboxes, mint API keys, watch usage, and pay.
It is not a mail sending API (SendGrid, Resend) and not a human-mailbox gateway (Gmail API, Nylas). The unit of the product is the inbox: created by API in milliseconds, addressable from the whole internet, threaded, searchable, evented.
0.1 The golden path
This is the release criterion. Every milestone in §20 exists to make one more step of this transcript real. A dashboard without this transcript working end-to-end is not done.
# 1. An agent with no credentials signs up (its developer's email receives an OTP)
curl -X POST https://api.wzrd.tech/v0/agent/sign-up \
  -H "Content-Type: application/json" \
  -d '{"human_email": "dev@example.com", "username": "scout"}'
# → { "api_key": "wm_live_…", "inbox_id": "scout@wzrd.tech", "organization_id": "org_…" }

# 2. The agent verifies with the OTP from the developer's inbox
curl -X POST https://api.wzrd.tech/v0/agent/verify \
  -H "Authorization: Bearer $WZRDMAIL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"otp_code": "482913"}'

# 3. It sends real mail to the outside world
curl -X POST https://api.wzrd.tech/v0/inboxes/scout@wzrd.tech/messages/send \
  -H "Authorization: Bearer $WZRDMAIL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"to": ["human@gmail.com"], "subject": "Report ready", "text": "Done. Reply to approve."}'

# 4. The human replies from Gmail. Within seconds the agent's webhook fires
#    (message.received, Svix-compatible signature) and the reply is queryable:
curl https://api.wzrd.tech/v0/inboxes/scout@wzrd.tech/threads \
  -H "Authorization: Bearer $WZRDMAIL_API_KEY"

# 5. Any MCP client gets the same power with one line
claude mcp add --transport http wzrdmail https://mcp.wzrd.tech/mcp

# 6. The CLI gets it too
npx wzrdmail --format json inboxes list

# 7. The developer opens https://console.wzrd.tech, sees the inbox and its usage,
#    hits the Free-tier email cap, clicks Upgrade, pays $20 via Stripe Checkout,
#    and the limit raise is live before the redirect back lands.
0.2 What "based on AgentMail" means, precisely
wzrdmail is shape-compatible with AgentMail v0, not byte-compatible and not import-compatible:
- Every endpoint in §7 uses AgentMail's path shape (`/v0/inboxes/{inbox_id}/messages/send`), field casing (`inbox_id`, `extracted_text`, `page_token`, `client_id`), and error envelope (`{"name": …, "message": …}`), so that code written against AgentMail ports by changing a base URL and a key prefix.
- Webhooks are signed with the Standard Webhooks scheme (`svix-id`, `svix-timestamp`, `svix-signature` headers, `whsec_` secrets) — the same scheme AgentMail uses via Svix — so existing Svix verification code (including Air's inbound email handler) works unchanged.
- The agent onboarding contract (`/v0/agent/sign-up` → OTP → `/v0/agent/verify`) matches AgentMail's, so agent-facing install instructions differ only in hostname and env var name (`WZRDMAIL_API_KEY`).
- Where we cannot match a capability yet (attachment size, IMAP/SMTP bridge, semantic search), the divergence is listed in §3 and the API returns an honest, specific error — never a silent downgrade.
1. Substrate: what we build on and what we fork
Three inputs. Keep their roles straight.
Input
Role
What we take
What we do not take
EmailFlare (`github.com/0xdps/emailflare`, MIT) — the project the team calls "mailflare"
Scaffold to fork
Worker + Hono + D1 + KV structure; the idempotent `just worker-setup` provisioning script pattern (create D1, create KV, patch `wrangler.jsonc`, migrate, set secrets, build admin, deploy); React admin SPA served as Worker static assets; scoped-API-key and send-log patterns; its Cloudflare Email Sending integration
Its product shape. EmailFlare is one-way sending with templates for a single operator. wzrdmail is multi-tenant, two-way, inbox-centric. Fork for bones, not behavior.
Cloudflare Email Service (public beta since 2026-04) + Email Routing
The mail engine
Outbound via the Workers `send_email` binding / REST API with automatic SPF/DKIM/DMARC on our zones; inbound via Email Routing catch-all delivering to an Email Worker (`email()` handler); the Agents SDK `onEmail` pattern as prior art
Nothing to avoid, but respect beta reality: daily send quota ramps with reputation; outbound message cap 5 MiB (25 MiB only to verified addresses); ≤50 recipients per message; 200 routing rules and 30 routed domains per zone. Enforce our own per-plan caps below the account ramp so one tenant cannot exhaust the platform.
AgentMail (`agentmail.to`, `docs.agentmail.to`)
Product reference
API surface (§7), webhook events and signing, pricing structure (§13), docs information architecture incl. `llms.txt` / `llms-full.txt` / the "If you are an AI agent" onboarding header, integration-page strategy (`/build/<tool>`), the OpenClaw plugin design
No code, no scraping their SDKs. We reimplement the shape from public documentation.
1.1 First customer: Air
The Air platform (`air 2.0` repo) already routes agent email through AgentMail: an Svix-verified webhook handler at `apps/web/app/api/inbound/email`, provisioning in `lib/provisioning/`, thread-scoped email as a channel. wzrdmail v1 is done only when Air can cut over by:
Provisioning its per-user inboxes via `POST /v0/inboxes` under one Air organization (pods per environment, §4).
Pointing one wzrdmail webhook (all `message.*` events) at the existing Air endpoint with a new `whsec_` secret.
Swapping `AGENTMAIL_API_KEY` → `WZRDMAIL_API_KEY` and the SDK base URL in Air's email client wrapper.
No Air schema change, no Air handler rewrite. Write a `docs/migrate-from-agentmail.md` in the wzrdmail repo that walks exactly this, generic to any AgentMail customer.
2. Non-negotiable constraints
Cloudflare-only runtime. Every service is a Worker (or Worker-attached: D1, R2, KV, Queues, Durable Objects, Email Routing, Email Service). No VPS, no containers, no third-party mail provider in v1. The only permitted external SaaS at runtime is Stripe.
Provider adapter seam. All mail egress goes through one `MailProvider` interface (§6.3) with a single Cloudflare implementation in v1. No call to a Cloudflare email API outside that module. This is the seam for an SES adapter later (larger attachments, custom-domain scale); build the seam, not the second adapter.
API-shape parity. §7 is the contract. Do not "improve" paths, casing, pagination, or error envelopes away from AgentMail's shape. Additive extensions live under `x_` prefixed fields or new endpoints, never mutations of the mirrored ones.
Tenant isolation is structural. Every D1 query on tenant data is written against a view or query helper that requires `org_id` (and `pod_id` where applicable). A raw table query on tenant data in route code is a review-blocking defect.
Secrets discipline. No secret in the repo, in `wrangler.jsonc`, or in D1. Worker Secrets only, set by the idempotent setup script from a gitignored `scripts/config.toml` (EmailFlare pattern). API keys and webhook secrets are stored hashed (SHA-256); plaintext is shown once at creation.
Idempotency everywhere agents write. All create operations accept `client_id` and return the prior result on replay (unique index on `(org_id, resource_type, client_id)`). Webhook deliveries and queue consumers are idempotent by event id.
Server-side limit enforcement. Every plan limit (§13) and platform limit (recipients ≤50, outbound size ≤5 MiB, inbound stored ≤25 MiB) is enforced in the API with a specific error, and metered in `usage_counters` — never enforced only in the console UI.
Forward-only migrations. Numbered D1 migrations, applied by the setup script; never edit an applied migration.
Deliverability is a feature. Unverified orgs can email only their own `human_email`. Bounces and complaints write to a suppression list that blocks future sends to that address. SPF, DKIM, DMARC are configured on every sending domain before the first external send.
Every webhook handler ships an idempotency test in the same PR, and structured logs carry `org_id` and `inbox_id` on every line that touches tenant mail.
3. Non-goals (V1)
Do not build these in v1. Each is either a later phase or deliberately out.
Non-goal
Why
Path later
IMAP/SMTP bridge for tenants
Workers cannot terminate arbitrary inbound TCP; a bridge needs Cloudflare Containers and real protocol work
V2 candidate: Go bridge on Cloudflare Containers translating IMAP/SMTP-submission to the REST API
Attachments >5 MiB outbound
Cloudflare Email Service outbound cap (5 MiB total message; 25 MiB only to verified destinations)
SES adapter behind `MailProvider`; until then the API rejects with `message_too_large` and the docs say so
Semantic search
Not needed for parity MVP; `search` params in §7 do substring/field match in v1
V1.1: Vectorize + Workers AI embeddings behind the same `/search` endpoints
Open/click tracking (`message.opened`)
Requires pixel/link rewriting infra and privacy posture
V1.1 flag per inbox
Browser credentials / agent identity keys (AgentMail's newer surface)
Orthogonal to mail; large auth surface
Revisit post-launch
White-label, EU-region pinning, SOC 2, HIPAA
Enterprise motions, not beta
Post-revenue
Custom domains where the customer keeps DNS elsewhere
Inbound requires the zone on Cloudflare Email Routing
V1 custom domains = zone (or delegated subdomain) added to our CF account, §6.6; SES adapter later relaxes the outbound half
Marketing-blast tooling (campaigns, templates-as-product)
We are agent infrastructure, not an ESP; also an abuse magnet
Never, most likely
4. Canonical domain model
One vocabulary, used identically in D1, API JSON, SDKs, MCP tool schemas, CLI output, and console copy.
Entity
Identity
Notes
`organization`
`org_<ulid>`
Billing + isolation root. Created by agent sign-up or console sign-up. Holds plan, Stripe customer id, verification state.
`user`
`user_<ulid>`
A human console login (email + OTP). Many users per org (seat-limited by plan).
`api_key`
`key_<ulid>`, secret `wm_live_…` / `wm_test_…`
Scoped: org-wide or pod-scoped; optional permission set (`read`, `send`, `admin`). Stored as SHA-256 of secret + 8-char lookup prefix.
`pod`
`pod_<ulid>`
Namespace inside an org for multi-tenant isolation (customer, project, or stage). Every mail resource carries `pod_id` (default pod created with the org). Keys may be pod-scoped.
`domain`
`dom_<ulid>`
A sending+receiving domain. `wzrd.tech` is the shared platform domain (org_id NULL). Customer domains belong to one org, §6.6.
`inbox`
`inbox_id` = the address, e.g. `scout@wzrd.tech`
The product's unit. `username@domain`, unique per domain. Has `display_name`, `client_id`, timestamps.
`thread`
`thread_<ulid>`
Conversation: ordered messages sharing RFC 5322 lineage (§6.5). Denormalized `subject`, `preview`, `last_message_at`, participant list, label set.
`message`
`msg_<ulid>`
One email in one inbox. Direction `inbound`/`outbound`; state `received`/`queued`/`sent`/`delivered`/`bounced`/`complained`/`rejected`/`failed`. Body fields: `text`, `html`, `extracted_text`, `extracted_html` (reply content with quoted history stripped). Raw MIME in R2 at `raw/{inbox_id}/{msg_id}.eml`.
`attachment`
`att_<ulid>`
Metadata row (filename, content type, size, content-id); bytes in R2 at `att/{inbox_id}/{msg_id}/{att_id}`.
`label`
string, per org
Free-form tags on messages and threads (`labels` JSON array + join table for query). System labels: `unread`, `sent`, `bounced`.
`list_entry`
`lst_<ulid>`
Allowlist/blocklist entry: scope (org, pod, or inbox), direction (`send`/`receive`), pattern (address or `@domain`), action (`allow`/`block`).
`webhook`
`wh_<ulid>`, secret `whsec_…`
Subscription: URL, event types, enabled flag, custom headers; scope org, pod, or inbox.
`webhook_delivery`
`whd_<ulid>`
One attempt log: event id, attempt #, status code, latency, next retry.
`event`
`evt_<ulid>`
Immutable event record (§8.1) — the source for webhooks, WebSockets, and `/events` endpoints.
`draft`
`draft_<ulid>`
Unsent message for human-in-the-loop; `send` transitions it into a `message`.
`otp_code`
row
6 digits, 10-minute TTL, 5 attempts, purpose (`agent_verify` / `console_login`).
`subscription`
row per org
Stripe subscription mirror: plan, status, period end, `stripe_customer_id`, `stripe_subscription_id`.
`usage_counter`
row per org × metric × month
Metrics: `emails_sent`, `emails_received`, `storage_bytes`, `inboxes`, `domains`, `seats`. Incremented transactionally with the action.
`idempotency_key`
row
`(org_id, resource_type, client_id)` unique → stored response.
`suppression`
row per org × address
Reason (`bounce`/`complaint`/`manual`), source message id, timestamp. Platform-level suppressions (org_id NULL) for hard bounces of shared-domain reputation.
Schema rules: ULIDs generated in the Worker; all timestamps ISO-8601 UTC; JSON columns for label arrays and participant lists with join tables only where queried; indexes on `(inbox_id, created_at)`, `(thread_id, created_at)`, `(org_id, month, metric)`, and the idempotency unique index. Message bodies over 64 KB store only in R2 with `text`/`html` truncated in D1 and a `body_truncated` flag (D1 row width discipline).
5. Names, domains, and DNS
Host
Serves
Implementation
`wzrd.tech`
Landing + agent-facing `/llms.txt` (§14.2)
`apps/www` Worker (static)
`api.wzrd.tech`
REST API v0 + WebSockets
`services/api` Worker
`mcp.wzrd.tech`
MCP server (Streamable HTTP)
`services/mcp` Worker
`console.wzrd.tech`
Customer dashboard SPA
`apps/console` static assets on the api Worker or its own Worker
`docs.wzrd.tech`
Documentation
`apps/docs` Worker (§14)
`*@wzrd.tech`
Agent inbox addresses on the shared domain
Email Routing catch-all → ingress Email Worker
DNS on the `wzrd.tech` zone (enable Email Routing and Email Service in the Cloudflare dashboard/API and accept the records they generate — do not hand-write values):
- MX records → Cloudflare Email Routing hosts.
- SPF TXT for both Routing and Email Service sending; DKIM keys as generated; DMARC starting at `p=quarantine; rua=mailto:dmarc-reports@wzrd.tech`, moving to `p=reject` after two clean weeks of warmup.
- Subdomain `A/AAAA`-less Worker custom domains for `api`, `mcp`, `console`, `docs`, `www`.
Reserved local-parts on `wzrd.tech` (rejected at inbox creation, routed to the founders' real mailboxes via explicit Email Routing rules that sit above the catch-all): `admin`, `abuse`, `billing`, `dmarc-reports`, `founders`, `hello`, `help`, `hostmaster`, `legal`, `mailer-daemon`, `noreply`, `postmaster`, `privacy`, `root`, `sales`, `security`, `support`, `team`, `webmaster`. Keep the list in one shared constant; add liberally.
Usernames: lowercase `[a-z0-9][a-z0-9._-]{2,63}`, no leading/trailing separator, uniqueness case-insensitive, profanity/impersonation denylist (`stripe`, `cloudflare`, `agentmail`, …) editable without deploy (KV).
6. Architecture
                         ┌────────────────────────────────────────────────┐
 Internet SMTP ─────────▶│ Email Routing (wzrd.tech + customer zones)     │
                         │   catch-all → ingress Email Worker email()     │
                         └──────────────┬─────────────────────────────────┘
                                        │ raw MIME → R2, parse (postal-mime)
                                        ▼
┌──────────────┐   HTTP   ┌────────────────────────┐   Queues   ┌──────────────────┐
│ Agents/SDKs/ │─────────▶│ services/api Worker    │───────────▶│ consumers:       │
│ CLI/Console/ │          │ Hono, /v0/*, auth,     │            │ webhook dispatch │
│ MCP server   │          │ limits, D1/R2/KV       │            │ outbound send    │
└──────────────┘          │ Durable Objects:       │            │ event fanout     │
                          │  WsHub (per-inbox WS)  │◀───────────│ (idempotent)     │
                          │  RateLimiter           │            └──────────────────┘
                          └───────────┬────────────┘                    │
                                      │ MailProvider.send()             │ send_email
                                      ▼                                 ▼
                          ┌────────────────────────────────────────────────┐
                          │ Cloudflare Email Service (outbound, DKIM/SPF)  │
                          └────────────────────────────────────────────────┘
Bindings owned by `services/api`: D1 `DB`, R2 `MAIL` (raw + attachments), KV `CACHE` (rate-limit state, denylists, config), Queues `events`, `sends`, `webhooks` (+ DLQs), DO namespaces `WS_HUB`, `RATE_LIMITER`, `send_email` binding `EMAIL`. The ingress Email Worker lives in the same deployment (one Worker, `fetch` + `email` + `queue` handlers) until size forces a split — prefer one deployable in v1.
6.1 Inbound pipeline (target: message.received webhook < 2 s p50 after SMTP accept)
`email()` receives the message; resolve recipient → inbox (D1). Unknown local-part on a customer domain with catch-all disabled, or a blocklisted sender → `message.setReject("550 …")` (this is the only place we reject at SMTP time; everything else accepts then labels).
Stream raw MIME to R2 first (source of truth), then parse with `postal-mime`: headers, text, html, attachments (each attachment streamed to R2), size cap 25 MiB.
Compute reply-extraction: `extracted_text` / `extracted_html` by stripping quoted history (port a mature quote-stripping heuristic; test corpus in `fixtures/emails/`).
Thread resolution (§6.5); insert `message` + `attachments`; bump thread denormalizations and `unread` label; increment `emails_received` and `storage_bytes`.
Emit `message.received` event → `events` queue → fanout consumer delivers to webhooks queue + WsHub DO + `/events` table. Ack SMTP only after the D1 insert commits (R2+D1 durable before accept; the queue fanout may lag, never lose).
DSN/bounce reports arriving inbound (from remote MTAs, RFC 3464) are detected in parse, matched to the original outbound message via `Message-ID`/references, and re-emitted as `message.bounced` + suppression insert, not stored as ordinary mail.
6.2 Outbound pipeline
`POST …/messages/send` validates: auth → org verified? → recipient count ≤50 → size ≤5 MiB → suppression check → allow/block lists → plan quota (`usage_counters` vs §13 limits) → per-org rate DO.
Insert `message` (state `queued`), enqueue to `sends`, and return the message object immediately. AgentMail's public event set has no `message.queued`; the first emitted event is `message.sent`, so `queued` is an internal state only.
`sends` consumer builds MIME (`mimetext`), sets `Message-ID: <msg_…@wzrd.tech>`, `In-Reply-To`/`References` for replies, DKIM handled by Email Service, calls `MailProvider.send()`. Success → state `sent`, event `message.sent`. Provider rejection → state `rejected` (event `message.rejected`) with the provider error preserved.
Delivery confirmation: Email Service does not stream per-message delivery events in beta; mark `delivered` on provider-accept (documented as accepted-by-provider) and reconcile `bounced`/`complained` from inbound DSN/ARF parsing (§6.1.6). Keep the event names AgentMail-compatible: `message.delivered`, `message.bounced`, `message.complained`.
Replies/reply-all/forward endpoints load the source message, construct headers and quoted body server-side, then follow the same path.
6.3 The `MailProvider` seam
// packages/core/src/mail-provider.ts
export interface MailProvider {
  send(env: Env, msg: OutboundMime): Promise<{ providerMessageId: string }>;
  verifyDomain(env: Env, domain: DomainRecord): Promise<DomainVerification>;
  requiredDnsRecords(domain: DomainRecord): DnsRecord[];
}
// v1: CloudflareEmailProvider (send_email binding; REST API fallback for
// non-Worker contexts). Nothing outside this module imports Cloudflare email APIs.
6.4 Rate limiting
Two layers: per-API-key token bucket (DO `RATE_LIMITER`, default 10 rps burst 50, per-plan overrides) returning `429` + `Retry-After`; and per-org daily send ceilings (§13) checked against `usage_counters`. Platform guard: a global daily send counter with an alarm at 80% of the current Cloudflare account quota — beyond it, queue sends and notify ops instead of burning reputation.
6.5 Threading
On insert: (1) if `In-Reply-To`/`References` matches a stored `Message-ID` in the same inbox → that thread; (2) else normalize subject (strip `Re:`/`Fwd:` etc.) and match `(inbox, normalized_subject, participant overlap)` within 30 days → that thread; (3) else new thread. Outbound messages thread by the same rules. Store every observed `Message-ID` in a lookup table per inbox. Property-test with shuffled fixture conversations.
6.6 Custom domains
v1 contract: a customer domain works only as a zone in the wzrdmail Cloudflare account (customer flips nameservers, or delegates a subdomain like `mail.customer.com` with NS records). Flow: `POST /v0/domains` → we create the zone via CF API → respond with the NS records to set (`GET /v0/domains/{id}` and the console show live status) → on activation, enable Email Routing + Email Service on the zone, install catch-all → ingress, mark `verified`, emit `domain.verified`. Per-zone routed-domain and rule limits (30 / 200) are per customer zone, so they don't aggregate across tenants; the shared `wzrd.tech` zone's own limits are why customer subdomain routing on `wzrd.tech` (e.g. `%anything%@acme.wzrd.tech`) is not offered in v1. Document the NS requirement bluntly in the console and docs.
7. API surface (v0)
Base `https://api.wzrd.tech/v0`. Auth: `Authorization: Bearer wm_…` or `x-api-key: wm_…`. Content type JSON. Errors: `{"name": "validation_error" | "forbidden" | "not_found" | "rate_limited" | "message_too_large" | …, "message": "human text"}` with correct HTTP status; `429` always carries `Retry-After`. Pagination: `limit` (default 20, max 100) + `page_token` → `{items…, "next_page_token"}` per collection. All creates accept `client_id`. Timestamps ISO-8601. IDs as in §4.
Implement exactly this table (mirrors AgentMail's public surface; org-level collections span all pods the key can see):
Area
Endpoints
Agent onboarding
`POST /agent/sign-up` (no auth; `{human_email, username}` → key + inbox + org, OTP emailed; fails if email already registered); `POST /agent/verify` (`{otp_code}`)
Auth
`GET /auth/me`
Organizations
`GET /organizations/{id}`
Inboxes
`GET /inboxes` · `POST /inboxes` (`{username?, domain?, display_name?, client_id?}`) · `GET /inboxes/{inbox_id}` · `PATCH /inboxes/{inbox_id}` · `DELETE /inboxes/{inbox_id}`
Messages
`GET /inboxes/{id}/messages` (filters: `labels`, `before/after`) · `GET /inboxes/{id}/messages/search?query=` · `GET /inboxes/{id}/messages/{msg_id}` · `GET …/{msg_id}/raw` (R2 stream) · `GET …/{msg_id}/attachments/{att_id}` · `POST /inboxes/{id}/messages/send` (`{to, cc?, bcc?, subject, text?, html?, reply_to?, headers?, attachments?[{filename, content_type, content(base64)}], labels?, client_id?}`) · `POST …/{msg_id}/reply` · `POST …/{msg_id}/reply-all` · `POST …/{msg_id}/forward` · `PATCH …/{msg_id}` (labels/read) · `DELETE …/{msg_id}` · `POST /inboxes/{id}/messages/batch-get` · `PATCH /inboxes/{id}/messages/batch-update`
Threads
`GET /inboxes/{id}/threads` · `GET /inboxes/{id}/threads/search` · `GET /inboxes/{id}/threads/{thread_id}` · `PATCH`/`DELETE` same · org-wide: `GET /threads`, `GET /threads/search`, `GET /threads/{id}`
Drafts
`GET/POST /inboxes/{id}/drafts` · `GET/PATCH/DELETE /inboxes/{id}/drafts/{draft_id}` · `POST …/drafts/{draft_id}/send` · org-wide `GET /drafts`, `GET /drafts/{id}`
Labels
`GET /labels` · label add/remove via message/thread `PATCH`
Lists
`GET/POST /inboxes/{id}/lists`, `GET/DELETE /inboxes/{id}/lists/{entry_id}` · org-wide `GET/POST /lists`, `GET/DELETE /lists/{id}`
Webhooks
org-wide `GET/POST /webhooks`, `GET/PATCH/DELETE /webhooks/{id}`, `GET/PATCH /webhooks/{id}/headers` · inbox-scoped mirrors under `/inboxes/{id}/webhooks…`
Domains
`GET/POST /domains` · `GET/PATCH/DELETE /domains/{id}` · `POST /domains/{id}/verify` · `GET /domains/{id}/zone-file`
Pods
`GET/POST /pods` · `GET/DELETE /pods/{id}` · pod-scoped listing via `pod_id` query param on the collections above
API keys
`GET/POST /api-keys` · `DELETE /api-keys/{id}`
Metrics
`GET /metrics/usage` (month, per metric vs plan limit) · `GET /metrics/events` · inbox-scoped mirrors
Events
`GET /inboxes/{id}/events` · `GET /events`
WebSocket
`GET /ws` (Upgrade; auth via `?api_key=` or header; subscribe message `{inbox_ids?: […]}`)
Health
`GET /health` (no auth; build sha + migration head)
Unverified-org behavior: all endpoints work, but `send` targets are restricted to the org's `human_email` until `/agent/verify` (or console email verification) succeeds — the same sandbox AgentMail applies. `403 {"name":"forbidden","message":"verify your account to email external recipients"}`.
OpenAPI 3.1 is generated from the route definitions (`hono-openapi` + zod schemas in `packages/core`) and served at `/v0/openapi.json`; it is the source for docs and SDK generation. The zod schemas are the single source of field truth shared by API, MCP, CLI, and SDKs.
8. Events, webhooks, WebSockets
8.1 Event envelope
Every state change emits exactly one immutable event:
{
  "event_id": "evt_01J…",
  "type": "message.received",
  "created_at": "2026-08-31T17:04:05Z",
  "organization_id": "org_…",
  "pod_id": "pod_…",
  "inbox_id": "scout@wzrd.tech",
  "data": { "message": { …full message object, extracted_text included… } }
}
Event types (v1, AgentMail-compatible names): `message.received`, `message.sent`, `message.delivered`, `message.bounced`, `message.complained`, `message.rejected`, `domain.verified`. Reserve but do not emit: `message.opened`.
8.2 Webhooks
- Signing: Standard Webhooks / Svix scheme. Headers `svix-id` (= event_id), `svix-timestamp`, `svix-signature` (`v1,` base64 HMAC-SHA256 over `{id}.{timestamp}.{payload}` with the `whsec_` secret). Existing AgentMail/Svix consumer code must verify unchanged — this is a conformance test, not an aspiration: vendor the payload-verification test vectors from the Standard Webhooks spec.
- Delivery: `webhooks` queue consumer, POST with 10 s timeout, custom headers merged; success = 2xx. Retries at 30 s, 5 m, 30 m, 2 h, 8 h, then DLQ + webhook auto-disable after 3 consecutive DLQ days (event logged, console badge, email to org owner). Every attempt writes `webhook_delivery`.
- SSRF guard: resolve and reject private/link-local/metadata IP targets and non-HTTPS URLs (allow `http://localhost` only when `WZRDMAIL_ENV=dev`).
- Replay: `POST /webhooks/{id}/deliveries/{whd_id}/redeliver` (console button; additive endpoint, `x_`-free since it's net-new, not a mutation of a mirrored one).
8.3 WebSockets
`wss://api.wzrd.tech/v0/ws` — Durable Object `WsHub`, hibernation API, one DO per org shard. Client subscribes with inbox filter; server pushes raw event envelopes. Heartbeat ping every 30 s; auth at upgrade; drop on key revocation (key id → DO broadcast). This is the OpenClaw plugin's fallback ingress, so it must survive Worker restarts without event loss: on reconnect the client sends `last_event_id` and the hub backfills from the `events` table (cap 500).
9. MCP server — `mcp.wzrd.tech`
`services/mcp`: Cloudflare Agents SDK (`McpAgent`) over Streamable HTTP at `/mcp`.
- Auth, both modes: (1) `x-api-key: wm_…` header for key-configured clients (Cursor, Devin, Hermes, Codex CLI configs); (2) OAuth 2.1 via `workers-oauth-provider` for OAuth clients (Claude Code, Claude Desktop, Claude.ai) — the authorize page is a minimal console-branded flow: email OTP login → org/key selection → consent → token maps to a scoped API key.
- Tools (names verb_noun, zod schemas imported from `packages/core`, descriptions written for agent consumption): `list_inboxes`, `create_inbox`, `get_inbox`, `list_messages`, `get_message`, `send_message`, `reply_to_message`, `reply_all_to_message`, `forward_message`, `update_message` (labels/read), `list_threads`, `get_thread`, `search_threads`, `list_drafts`, `create_draft`, `update_draft`, `send_draft`, `get_attachment` (returns R2-signed URL + text extraction when small), `list_webhooks`, `create_webhook`, `list_domains`, `get_usage`. ~22 tools; every tool result includes the ids an agent needs for the next call.
- Resources: `wzrdmail://docs/quickstart` and `wzrdmail://docs/llms.txt` exposing the onboarding doc (§14.2) so MCP-only agents can self-serve.
- Install lines to publish in docs (verify each against the client's current syntax at doc-writing time): `claude mcp add --transport http wzrdmail https://mcp.wzrd.tech/mcp`; Cursor/Devin/Codex/Hermes: endpoint + `x-api-key` header snippet.
10. CLI — `wzrdmail` on npm
`packages/cli`, published as `wzrdmail` (bin: `wzrdmail`, alias `wm`). Node ≥22, zero-config against prod.
- Auth: `wzrdmail auth login` (opens console device-code page; stores key in `~/.config/wzrdmail/config.json` chmod 600), `auth whoami`, `auth logout`; `WZRDMAIL_API_KEY` env always wins; `--api-key` flag for CI.
- Commands mirror the API nouns: `inboxes list|create|get|delete`, `messages list|get|send|reply|forward`, `threads list|get|search`, `drafts list|create|send`, `webhooks list|create|delete|test`, `domains list|add|verify|records`, `pods list|create`, `keys list|create|revoke`, `usage`, `events tail` (WebSocket follow), `login`.
- Output: human tables by default, `--format json` machine-clean (no spinners/logs on stdout; errors as JSON on stderr, exit codes 0/1/2=auth/3=limit). Every command's `--help` is written for agents reading help output at runtime (the OpenClaw plugin pattern: the skill drives `--help`, so new commands ship without a plugin release).
- Implementation: thin over `packages/sdk-ts`; `commander` or `clipanion`; single-file build via `tsup`; smoke-tested in CI against a staging org.
11. SDKs
- TypeScript `packages/sdk-ts` → npm `wzrdmail`. Method shape mirrors AgentMail's SDK so ports are mechanical: `new WzrdMailClient({ apiKey })`, `client.inboxes.create({ clientId })`, `client.inboxes.messages.send(inboxId, {…})`, `client.inboxes.messages.list(inboxId, {…})`, `client.inboxes.messages.reply(inboxId, messageId, {…})`, `client.threads.list(…)`, plus `client.ws.connect()`. Hand-rolled thin fetch client typed from the zod schemas (no codegen dependency in v1); throws on 4xx/5xx with `error.body.name/.message`; built-in 429 retry with `Retry-After` + expo backoff (max 3).
- Python `sdk-python/` → PyPI `wzrdmail`. Same shape: `WzrdMail(api_key=…)`, `client.inboxes.create(client_id=…)`, `client.inboxes.messages.send(inbox_id, to=…, subject=…, text=…)`. httpx, typed with pydantic v2, sync first (async wrapper later).
- Both ship the copy-paste quickstart from the docs as an executed test (the doc snippet is extracted and run in CI — docs that break fail the build).
12. Console — `console.wzrd.tech`
`apps/console`: React + Vite + TanStack Router SPA (EmailFlare admin heritage), served as Worker static assets; talks only to the public API plus a small `/console/*` session-auth route group (no second API).
- Auth: email + OTP via better-auth (D1 adapter, email-OTP plugin) issuing httpOnly session cookies scoped to `console.wzrd.tech`; the OTP email is sent through wzrdmail itself (dogfood; `noreply@wzrd.tech`). Org switcher; invite flow gated by seat limits.
- Pages: Onboarding (create org → verify email → first inbox → copy key → "connect your agent" panel with MCP/CLI/curl tabs); Inboxes (list/create, per-inbox thread viewer with rendered `extracted_html`, reply box for humans); Domains (add → NS records → live verification status → DNS record table copyable); API keys (create scoped, reveal-once, last-used); Webhooks (CRUD, recent deliveries with status + redeliver button, secret rotation); Pods; Usage (metric vs plan-limit bars, month picker); Billing (§13: current plan, upgrade/downgrade → Stripe Checkout, invoices → Stripe Portal); Settings (org name, members/seats, danger zone).
- Admin area (`/admin`, platform staff only, gated by `user.is_staff`): org search, plan overrides, suppression browser, global send counter vs account quota, webhook DLQ browser, domain queue.
- E2E: Playwright against a staging deploy — signup → inbox → send-to-self → see thread → upgrade with Stripe test card → limit raised.
13. Billing — Stripe
Tiers mirror AgentMail's structure; every number lives in `packages/core/src/plans.ts` (one file, no magic numbers elsewhere):
Plan
Price
Inboxes
Emails/mo
Storage
Custom domains
Seats
Extras
`free`
$0
3
3,000
3 GB
0
1
—
`developer`
$20/mo
10
10,000
10 GB
10
2
email support
`startup`
$200/mo
150
150,000
100 GB
150
10
priority support
`enterprise`
custom
custom
custom
custom
custom
custom
invoice billing; manual plan row
- Objects: one Stripe Product per paid plan, monthly Prices; `subscription` row mirrors Stripe state. Checkout Sessions for upgrade (customer created lazily), Billing Portal for card/invoice/cancel/downgrade. Prices referenced by env-provided ids (`STRIPE_PRICE_DEVELOPER`, `STRIPE_PRICE_STARTUP`) so test/live modes differ only in secrets.
- Webhook `/v0/stripe/webhook` (signature-verified with `constructEventAsync`, idempotent by Stripe event id): handle `checkout.session.completed`, `customer.subscription.created/updated/deleted`, `invoice.paid`, `invoice.payment_failed`. Subscription state machine: `active`/`trialing` → plan entitlements; `past_due` → 14-day grace (send works, banner); `canceled`/`unpaid` → drop to `free` entitlements (inboxes over the cap freeze receive-only, never deleted; data retained 90 days beyond plan storage before archival warning).
- Enforcement: middleware reads `subscription.plan` → `plans.ts` → checks `usage_counters` before inbox-create, send, domain-add, seat-invite. Over-limit → `403 {"name":"plan_limit_exceeded","message":"…upgrade at https://console.wzrd.tech/billing"}` (AgentMail-style hard stop, no overage billing in v1).
- Metering: counters incremented in the same transaction as the action; nightly Queues cron reconciles storage_bytes from R2 listings.
- Test with Stripe CLI fixtures + test clocks (renewal, failed payment, downgrade at period end) in CI against a mock; manually once against live test mode before launch.
14. Docs — `docs.wzrd.tech`
Self-hosted on Workers, in-repo: `apps/docs` using Astro Starlight (static output on Worker assets — no SSR needed; if the API-reference page wants interactivity, embed Scalar's OpenAPI viewer pointed at `/v0/openapi.json`).
14.1 Information architecture (mirror AgentMail's, which is the category's proven shape)
Quickstart · Concepts (Inboxes, Messages, Threads, Drafts, Attachments, Labels, Lists, Pods, Domains) · Realtime (Webhooks, WebSockets) · Deliverability guide · API reference (generated from OpenAPI) · SDKs (TS, Python) · CLI · MCP · Integrations: one page per tool — `claude-code`, `codex`, `cursor`, `devin`, `openclaw`, `hermes`, `grok` — each with install command, working code, and FAQ · Migrate from AgentMail (§1.1) · Pricing · Security.
14.2 Agent-facing plumbing (this is product, not marketing)
- `https://wzrd.tech/llms.txt` — the wzrdmail version of AgentMail's "If you are an AI agent" header: Step 0 check `WZRDMAIL_API_KEY`; Step 1 `POST /v0/agent/sign-up` + OTP verify; Step 2 ask your developer for a key from the console; Step 3 connect via MCP (`https://mcp.wzrd.tech/mcp`) or REST. Same file served as the response to `curl wzrd.tech` with `Accept: text/plain`-ish agents (serve it as the root page's alternate).
- `docs.wzrd.tech/llms.txt` (index) and `docs.wzrd.tech/llms-full.txt` (full corpus, built at docs build time).
- Markdown content negotiation: every docs page responds to `Accept: text/markdown` and a `.md` suffix with raw markdown (a tiny Worker middleware; Starlight pages keep their sources in the deploy).
- An `AGENTS.md`/skill block in the repo root of `wzrdmail-skills` (below) that mirrors `agentmail-to/agentmail-skills`.
15. Integrations (OpenClaw, Hermes, Codex, Devin, and friends)
The support matrix is one table in the docs; every row is a tested artifact, not a claim:
Client
Mechanism
Artifact
Claude Code / Claude Desktop / Claude.ai
MCP + OAuth
`claude mcp add --transport http wzrdmail https://mcp.wzrd.tech/mcp`; plugin `wzrdmail@wzrdmail` from our marketplace repo
Codex
MCP with `x-api-key` + plugin marketplace repo
`plugins/agents/` bundle
Cursor
MCP with `x-api-key`; marketplace listing later
docs page + `.cursor/mcp.json` snippet
Devin
MCP with `x-api-key`; docs page with setup + goal.md-style task snippet
docs `/build/devin`
Hermes
MCP config + skill file (Hermes reads skills; ship `wzrdmail` skill in `wzrdmail-skills`)
docs `/build/hermes`
OpenClaw
Official plugin (the flagship): `plugins/openclaw/` published to ClawHub as `@wzrd/wzrdmail`
see below
Grok Bot
Custom MCP connector with `x-api-key`
docs `/build/grok`
Any REST client
curl quickstart
docs Quickstart
OpenClaw plugin (port the AgentMail plugin's design 1:1, pointed at wzrdmail):
CLI-backed skill: bundles the `wzrdmail` CLI; the agent reads `--help` at runtime; passthrough `openclaw wzrdmail -- --format json inboxes list`.
Email channel: durable, allowlisted, reply-only. Webhook ingress when `WZRDMAIL_WEBHOOK_SECRET` (Svix-verified) is set; WebSocket ingress fallback. Config under `channels.wzrdmail`: `inboxId`, `dmPolicy` (default `allowlist`), `allowFrom`, `mediaMaxMb`. Inbound is committed durably before ack; replies bind to the triggering thread; no proactive sends from the channel.
Env: `WZRDMAIL_API_KEY` in the Gateway environment. Target OpenClaw ≥2026.7.2, Node ≥22.
Repos: `wzrd-tech/wzrdmail-plugins` (Claude Code/Codex/Cursor bundle + marketplace manifest), `wzrd-tech/wzrdmail-skills`, OpenClaw plugin in-monorepo at `plugins/openclaw` and published out.
16. Security and abuse model
wzrdmail hands strangers real email addresses on our domain. The reputation of `wzrd.tech` is the company; treat every control below as launch-blocking.
Threat
Control
Spam/phishing from tenant inboxes
Unverified sandbox (§7); per-plan daily send caps enforced below the Cloudflare account ramp; free tier throttled hardest (100 sends/day); global platform counter with 80% alarm (§6.4); denylist of impersonation usernames; terms + `abuse@wzrd.tech` + one-click org freeze in `/admin`
Reputation damage from bounces
Suppression list enforced pre-send (org-level; platform-level for hard bounces); DSN/ARF parsing (§6.1.6); DMARC ramp to `p=reject`; warmup runbook (§17)
Stolen API keys
Hashed at rest, prefix lookup, reveal-once; scoped and pod-scoped keys; `last_used_at`; revocation kills live WebSockets; `wm_test_` keys never touch external SMTP (test-mode sends loop back as received messages in a sandbox inbox)
Cross-tenant reads
§2.4 structural org scoping; every route handler test suite includes a foreign-org 404 case, generated for all routes from the route table
Webhook SSRF
§8.2 target validation
Inbound malice (bombs, spoofing)
25 MiB inbound cap; attachment count/type sanity limits; store don't execute; SPF/DKIM/DMARC verdicts from Email Routing recorded on the message and exposed in the API (`x_auth_results`); blocklists at SMTP time
OTP brute force
6 digits, 10-min TTL, 5 attempts then invalidate, per-email + per-IP rate limits
Payment abuse
Stripe Radar defaults; no card-on-file requirements for free tier but free tier cannot add domains
Secrets leakage
§2.5; log scrubber denies `wm_`, `whsec_`, `Bearer` patterns in structured logs (test asserts)
Data handling: raw MIME and attachments in R2 are tenant data — deleted within 30 days of org deletion; D1 rows cascade at deletion time; suppression addresses persist (legitimate interest). Publish a plain security page in docs; wire `security@wzrd.tech`.
17. Operations
- Environments: `dev` (local `wrangler dev` + local D1/KV/R2 simulators; `just dev`), `staging` (real CF account, `staging.api.wzrd.tech`, test-mode Stripe, its own subdomain zone `staging-mail.wzrd.tech` for routing tests), `prod`. One `wrangler.jsonc` with env blocks; deploys via `just deploy staging|prod` and CI on main (staging auto, prod tagged release with gradual rollout: `wrangler versions deploy --version-percentage` 10% → 100%).
- Setup script: `scripts/setup.ts` (EmailFlare's pattern, extended): verifies auth, creates D1/KV/R2/Queues/DO migrations, patches `wrangler.jsonc` ids, applies migrations, sets secrets from `scripts/config.toml`, enables Email Routing + Email Service on the zone, installs the catch-all route, prints the DNS/NS state. Idempotent; safe to re-run; this is also the disaster-recovery script.
- Observability: Workers Logs (structured JSON) + Analytics Engine counters (`sends`, `receives`, `webhook_failures`, `429s`, per-org top-N); `/health` exposes build sha + migration head; alarm rules (email to founders via wzrdmail itself + a fallback external address): global send counter at 80% quota, webhook DLQ > 100, queue backlog age > 5 min, D1 storage > 70%.
- Runbooks in `docs/runbooks/`: deliverability warmup (week-by-week volume schedule for the first 4 weeks; monitor Google Postmaster + `mail-tester.com` ≥ 9/10 before opening free-tier external sends), reputation stall (pause free tier, drain queue slowly), queue backlog, D1 growth (archive messages > 12 months to R2 JSONL), Stripe webhook outage (replay from Stripe dashboard; handlers idempotent).
- Backups: R2 raw MIME is the mail source of truth. Nightly cron Worker exports D1 (`wrangler d1 export` equivalent via API) to R2 `backups/`; restore drill is part of M8.
18. Environment variables and secrets
All server-side; set via `scripts/setup.ts`; names are exact.
Name
Kind
Used by
`WZRDMAIL_ENV`
var (`dev`/`staging`/`prod`)
all
`CF_ACCOUNT_ID` / `CF_API_TOKEN`
secret — token perms: Email Routing:Edit, Zone:Edit, DNS:Edit, Workers scripts as needed
setup script, domains module (zone create/verify)
`SESSION_SECRET`
secret (32B hex)
console auth
`OTP_PEPPER`
secret
OTP hashing
`API_KEY_PEPPER`
secret
key hashing
`STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET`
secret
billing
`STRIPE_PRICE_DEVELOPER` / `STRIPE_PRICE_STARTUP`
var
billing
`PLATFORM_ALERT_EMAIL`
var (external fallback address)
ops alarms
`SIGNUP_DENYLIST_KV` seedable list
KV
username checks
Bindings (not env): `DB` (D1), `MAIL` (R2), `CACHE` (KV), `EMAIL` (send_email), queues `events`/`sends`/`webhooks` + `-dlq`, DOs `WS_HUB`/`RATE_LIMITER`.
19. Repository layout (new repo: `wzrd-tech/wzrdmail`)
wzrdmail/
  goal.md                      ← this file
  README.md                    quickstart for contributors + the golden path
  Justfile                     install, dev, test, deploy, setup recipes
  package.json                 pnpm workspaces + turbo
  packages/
    core/                      zod schemas (single source of field truth), ids,
                               plans.ts, mail-provider seam, threading, quote-strip,
                               webhook signing — pure, no bindings, 100% unit-tested
    sdk-ts/                    npm `wzrdmail`
    cli/                       npm `wzrdmail` bin
  services/
    api/                       the Worker: Hono routes /v0/*, email() ingress,
                               queue consumers, DOs, static console assets
      migrations/              D1, numbered, forward-only
      src/routes/ src/ingress/ src/egress/ src/billing/ src/webhooks/ src/ws/
    mcp/                       McpAgent Worker → mcp.wzrd.tech
  apps/
    console/                   React SPA (built into services/api assets)
    docs/                      Astro Starlight → docs.wzrd.tech
    www/                       landing + /llms.txt → wzrd.tech
  sdk-python/                  PyPI `wzrdmail`
  plugins/
    openclaw/                  ClawHub `@wzrd/wzrdmail`
    agents/                    Claude Code / Codex / Cursor plugin bundle
  fixtures/emails/             MIME corpus: threading, quoting, DSN, ARF, bombs
  scripts/
    setup.ts  config.example.toml
  docs/ (repo-internal)        runbooks/, migrate-from-agentmail.md, decisions/
Conventions: TypeScript strict, no `any` in `packages/` or `services/`; vitest everywhere + `@cloudflare/vitest-pool-workers` for Worker-context tests; every PR green on `just check` (typecheck, lint, unit, worker tests); conventional commits; `decisions/` ADRs for anything that contradicts or extends this spec (spec wins until an ADR amends it).
20. Milestones
Dependency order. Each milestone ends with its Verify block executed and pasted into the PR. Do not start a milestone with the prior one's Verify failing.
M0 — Repo, deploy spine, zone
Monorepo scaffold per §19; `scripts/setup.ts` provisions D1/KV/R2/Queues/DOs; CI (typecheck/lint/test) green; `services/api` deploys to staging + prod; `wzrd.tech` zone: Email Routing enabled with catch-all → ingress (log-only), Email Service sending enabled, DMARC/SPF/DKIM live; Worker custom domains for `api`/`mcp`/`console`/`docs`/`www` respond.
Verify: `curl https://api.wzrd.tech/v0/health` returns build sha; `dig MX wzrd.tech` shows Cloudflare MX; a manual email to `probe@wzrd.tech` appears in ingress logs.
M1 — Mail engine core
Ingress pipeline complete (§6.1: R2 raw, parse, extract, thread, D1, events); egress pipeline complete (§6.2 + `MailProvider` CF impl); threading property tests green on `fixtures/emails/`; DSN/ARF → bounce events + suppression.
Verify: script `just demo:roundtrip` — creates inbox via SQL seed, sends to a real Gmail probe address, replies from Gmail, asserts thread has 2 messages with correct `extracted_text`, elapsed receive→row < 5 s.
M2 — API v0 parity
Every endpoint in §7 (auth, keys, idempotency, pagination, errors, rate limits, unverified sandbox, agent sign-up/verify with OTP delivered through wzrdmail); OpenAPI served; foreign-org 404 test generated for all routes.
Verify: `just test:conformance` — a fixture suite that runs the §0.1 transcript steps 1–4 against staging verbatim (plus 429 + `Retry-After` and `client_id` replay checks) and diffs response shapes against checked-in golden JSON.
M3 — Realtime
Events table + fanout; webhooks with Svix-compatible signing, retries, DLQ, delivery log, redeliver; WsHub with backfill.
Verify: `just demo:webhook` registers a webhook.site URL, sends a message, asserts signed delivery verifiable by the `standardwebhooks` reference library; `wzrdmail events tail` (or a ws test client) shows `message.received` < 2 s after Gmail reply.
M4 — Console
better-auth OTP login; all §12 customer pages against staging; admin area minimal (org search, freeze, DLQ browser).
Verify: Playwright suite green: signup → create inbox → send-to-self → read thread → create key → register webhook.
M5 — Billing
Stripe products/prices scripted (idempotent `just stripe:setup`); checkout, portal, webhook state machine, grace/downgrade behavior; enforcement middleware on inbox-create/send/domain/seat paths; metering + nightly reconcile.
Verify: Stripe test clock run: free org hits 3k send cap → `plan_limit_exceeded` → checkout upgrade → cap raised without redeploy → simulated `invoice.payment_failed` ×3 → grace → downgrade to free entitlements. All asserted by `just test:billing`.
M6 — MCP, CLI, SDKs
`mcp.wzrd.tech` with both auth modes and the §9 toolset; CLI published (npm dry-run + staging smoke); TS + Python SDKs with executed-quickstart tests.
Verify: `claude mcp add --transport http wzrdmail https://mcp.wzrd.tech/mcp` then, in a Claude Code session, list inboxes and send a message using only MCP tools; `npx wzrdmail --format json inboxes list | jq` round-trips; both SDK quickstarts run green in CI.
M7 — Docs + landing
`docs.wzrd.tech` full IA (§14.1), API reference from OpenAPI, integration pages with tested snippets; `wzrd.tech` landing + `/llms.txt`; `llms-full.txt`; markdown content negotiation; `migrate-from-agentmail.md`.
Verify: `curl -H "Accept: text/markdown" https://docs.wzrd.tech/quickstart` returns markdown; `curl https://wzrd.tech/llms.txt` returns the agent onboarding header; every code snippet in docs is extracted and executed by `just test:docs`.
M8 — Integrations, hardening, launch
OpenClaw plugin published to ClawHub and round-tripping (inbound email → agent turn → threaded reply) on a test Gateway; plugins/skills repos live; custom-domain flow (§6.6) verified with one real external domain end-to-end; load test (1k sends, 1k receives sustained over an hour on staging); restore drill from R2 backup; warmup runbook started for prod; `mail-tester.com` ≥ 9/10 from a paid-tier inbox; Air cutover executed on Air staging per §1.1.
Verify: the complete §0.1 golden-path transcript, run live against prod, pasted into the release notes — plus Air staging sending and receiving through wzrdmail with zero Air code changes beyond env.
21. Open questions (decide during build, record as ADRs)
Does Cloudflare Email Service beta expose programmatic sending-domain verification for zones, or only dashboard? If API gaps exist, drive it via the CF API the setup script already uses, and note the manual step in the runbook.
Per-message delivery receipts from Email Service (beyond provider-accept) — if the beta adds delivery/bounce webhooks before M3, wire them into `message.delivered`/`message.bounced` and demote DSN parsing to fallback.
`wm_test_` mode semantics: loopback-only sandbox (spec default) vs. Email Service verified-address sends. Keep loopback unless a strong reason emerges.
Console served from `services/api` assets vs. its own Worker — split only if bundle size or deploy cadence forces it.
Whether Startup-tier "150 custom domains" needs relaxing given NS-transfer friction (§6.6); pricing page can say "150 domains (nameserver delegation required)" honestly either way.
22. References
- AgentMail product + docs (API shape source): `https://www.agentmail.to` · `https://docs.agentmail.to` · `https://docs.agentmail.to/llms-full.txt`
- Cloudflare Email Service (public beta announcement, 2026-04): `https://blog.cloudflare.com/email-for-agents/` · docs: `https://developers.cloudflare.com/email-service/` · limits: `https://developers.cloudflare.com/email-service/platform/limits/` · Workers send API: `https://developers.cloudflare.com/email-service/api/send-emails/workers-api/`
- Cloudflare Email Routing + Email Workers: `https://developers.cloudflare.com/email-routing/`
- EmailFlare (fork base, MIT): `https://github.com/0xdps/emailflare` · `https://www.emailflare.dev`
- Standard Webhooks spec (Svix-compatible signing): `https://www.standardwebhooks.com`
- Cloudflare Agents SDK / MCP on Workers: `https://developers.cloudflare.com/agents/`
- AgentMail OpenClaw plugin (design reference for ours): `https://clawhub.ai/agentmail` · `https://www.agentmail.to/build/openclaw`
- Stripe: Checkout, Billing Portal, webhooks, test clocks: `https://docs.stripe.com/billing`
End of specification. If reality contradicts this document, update this document in the same PR that ships the contradiction, with an ADR in `docs/decisions/`.