# WZRD Mail Muse Connector — specification of record

Hostname: **`mcp.mail.wzrd.tech`** (staging: `staging.mcp.mail.wzrd.tech`).
Listing: Meta's Muse Platform (`muse.ai/platform`), connection type **Existing MCP**.

This supersedes two things in `goal.md`: the hostname `mcp.wzrd.tech` in §9 and §15
(the deployed Worker is routed to `mcp.mail.wzrd.tech`, `services/mcp/wrangler.jsonc:38`),
and the sentence in §9 that defers OAuth — OAuth 2.1 ships here. It does not change
§2. Every non-negotiable in `goal.md` §2 still binds: API-shape parity, structural
tenant isolation, secrets discipline, forward-only migrations, server-side limits.
If an implementation choice conflicts with §2, the implementation is wrong.

The connector lets a Meta Muse user give their agent a real `@wzrd.tech` inbox and
then send, read, reply to and poll email through it. A user who has no wzrdmail
account gets one inside the connect flow. The work is a transport lane, an OAuth
authorization server, a consent page, three API endpoints, one migration, two tools
and a docs page — no change to the mail engine and no change to any existing `/v0`
response shape.

**Last verified** 2026-09-20 against `wzrdmail` @ `954b02d` (branch `main`),
with `node_modules` installed from `pnpm-lock.yaml`. Every `node_modules` line
number below was read from the installed tree and must be re-read after any
dependency bump. Muse's own behaviour is reported from Meta's public docs and
third-party developer submissions (§10); nothing about Muse was verified against
a live Muse account, and §9 MU6 is where that happens.

---

## 0. Definition of done

A Meta Muse user can, in one sitting:

1. Say "connect to `https://mcp.mail.wzrd.tech/mcp`" in Muse and be taken to a
   wzrdmail sign-in page.
2. Sign in with an email one-time code — or, having no wzrdmail account, choose a
   username and come out of the flow owning `<username>@wzrd.tech`.
3. Approve a consent screen that names the client, the scopes and the one inbox
   the connection is pinned to.
4. Have Muse call `whoami` and be told its own address.
5. Have Muse send a message from that address, and have a scheduled Muse agent
   find the reply with `check_new_mail`.
6. Disconnect from the wzrdmail console (Settings → Connected apps), after which
   the next Muse tool call fails with a re-authorize error.

And, on the submission side: the Muse Platform form is filled with a hosted MCP
endpoint that answers JSON, a documentation URL that loads without a login, and
privacy and terms URLs that resolve.

No client regressions: Claude Code, Cursor, Codex and Hermes keep working through
`x-api-key` on the same URL, byte-for-byte, and `plugins/agents/.mcp.json` does not
change.

---

## 1. Architecture

```
  Meta Muse (Secure VM, "Hatch" egress)
        │  HTTP/1.1, Connection: close, ~20 s ceiling, JSON
        ▼
  services/mcp — mcp.mail.wzrd.tech  ────────────────────────────────┐
    /.well-known/oauth-protected-resource[/mcp]   RFC 9728           │
    /.well-known/oauth-authorization-server                          │
    /authorize  /token  /register     @cloudflare/workers-oauth-provider
    /authorize/{email,signup,verify,approve}   consent page (HTML)   │
    /mcp   ── lane A: McpAgent + MCP_OBJECT DO   (SSE, unchanged)    │
           └─ lane B: createLegacyMcpHandler     (JSON, stateless)   │
                                                                     │
        │ x-connect-secret (server-to-server, no cookie)             │ Bearer wm_
        ▼                                                            ▼
  services/api — api.wzrd.tech ─────────────────────────────────────────────
    /v0/connect/{start,signup,verify,complete}   (secret-gated, new)
    /v0/* everything else                        (unchanged)
    D1: organizations · api_keys · otp_codes · inboxes …
```

Three properties make this shape work:

- **The authorization server lives on the resource host.** RFC 9728 puts protected
  resource metadata on the resource, and `services/mcp` is the only Worker routed to
  `mcp.mail.wzrd.tech` (`services/mcp/wrangler.jsonc:31,38`). `apps/console` is a
  static-asset Worker with no server code (`apps/console/wrangler.jsonc:6-9`) and
  `services/api` mounts only `/v0` (`services/api/src/app.ts:55-71`), so neither can
  serve `/authorize`.
- **Nothing browser-side touches the API's cookie.** Every wzrdmail state change in
  the consent flow is a Worker-to-API fetch carrying a shared secret. Worker fetches
  carry no cookie, and the CSRF guard only fires when a `wm_session` cookie is present
  (`services/api/src/app.ts:44-45`), so `CONSOLE_ORIGINS` (`:19-23`) and the
  credentialed CORS callback (`:28-36`) are not edited.
- **An OAuth grant is an API key.** Consent mints one inbox-scoped `wm_live_` key
  through the same statement the console uses (`services/api/src/routes/keys.ts:94-115`).
  Every `/v0` route, `requirePermission` and `org_id` scoping then behaves exactly as
  it does for a key — `authenticate()` (`services/api/src/auth.ts:86-131`) is not
  touched.

---

## 2. Non-goals

| Non-goal | Why | Path later |
| --- | --- | --- |
| Push notification of new mail into Muse | Muse has no inbound API; nothing outside Muse can start a Muse turn | `check_new_mail` cursor polling (§6); revisit if Meta ships an inbound endpoint |
| Long-poll "wait for reply" tool | Meta's ~20 s request ceiling leaves no useful budget, and a held request is the one thing the JSON lane must never do | A bounded 12 s poll can be added once MU6 measures the real ceiling |
| `admin` scope over OAuth | Creating inboxes, webhooks and domains from a consumer agent is a blast-radius we are not taking in v1 | Console-minted key, documented on the Muse page |
| Retiring the `McpAgent` Durable Object | It is deprecated upstream, but removing it is a separate risk from shipping Muse | Its own PR after the JSON lane has run in production for a week (§9 MU7) |
| Migrating to MCP SDK v2 | The 2025-era lane in SDK v2 still answers SSE and would force a rewrite of `tools.ts` | Track the 2026-07-28 revision; the JSON lane is the migration seam |
| Federated (thirdweb) sign-in on the consent page | The consent page is server-rendered HTML in a Worker with no Vite build; shipping the thirdweb React bundle there is a project of its own | ADR-0003 records the option |
| `/v0/openapi.json` | Advertised at `services/mcp/src/resources.ts:45` but never implemented; Muse does not need it for an Existing MCP listing | The dangling URL is replaced, not fulfilled (§8) |

---

## 3. What Muse requires, and what the repo does today

| Muse requires | Repo today | This spec |
| --- | --- | --- |
| Hosted HTTPS MCP endpoint, Streamable HTTP | `https://mcp.mail.wzrd.tech/mcp` exists | unchanged URL |
| JSON responses, no long-lived SSE client | every request POST is answered `text/event-stream` over a WebSocket→DO bridge (`agents/dist/mcp/index.js:193-270`) | lane B (§4) |
| Tolerates a JSON-only `Accept` | POST 406s unless `Accept` contains **both** `application/json` and `text/event-stream` (`agents/dist/mcp/index.js:71-82`, verified) | lane selection + Accept normalisation (§4) |
| 401 with RFC 9728 resource metadata | 401 is a bare JSON envelope with no `WWW-Authenticate` (`services/mcp/src/index.ts:88-96`) | §5 |
| OAuth 2.1, PKCE S256, dynamic client registration | none anywhere in the repo | §5 |
| API key alternative | `x-api-key` / `Authorization: Bearer wm_…` (`services/mcp/src/auth.ts:1-10`) | unchanged |
| Docs URL readable without login | `docs.mail.wzrd.tech` serves any `DocPage` in `PAGES` (`services/docs/src/content.ts:576-586`) with no auth | one new page (§8) |
| Privacy and terms URLs | none exist; the Codex manifest already links `https://mail.wzrd.tech/legal/*` (`plugins/agents/.codex-plugin/plugin.json:24-25`), which 404s | two new pages + a 301 (§8) |
| Account and plan requirements stated | free-plan caps live in `packages/core/src/plans.ts:28-65` | copied verbatim into the form (§8) |

---

## 4. Transport: two lanes on one path

### 4.1 Lane A — `McpAgent`, unchanged

`WzrdmailMcp.serve("/mcp")` (`services/mcp/src/index.ts:113`) stays exactly as it is,
along with the Durable Object binding, the `fetch` override (`:53-66`), the
`/__verify-session-key` pre-check (`:97-111`) and `sessionKeyGuard`
(`services/mcp/src/auth.ts:12-32`). `McpAgent.serve` accepts only
`{ binding, corsOptions, transport, jurisdiction }`
(`services/mcp/node_modules/agents/dist/mcp/index.js:1600`, verified) — there is no
JSON switch to pass, which is why a second lane exists at all.

### 4.2 Lane B — stateless JSON, new

`services/mcp/src/json-lane.ts` exports one function:

```ts
export async function handleJsonLane(request, env, ctx, principal) {
  const api = new ApiClient({ apiKey: principal.apiKey, baseUrl: env.API_BASE_URL, timeoutMs: 15_000 });
  const server = buildServer(api, { permissions: principal.permissions, inboxId: principal.inboxId });
  return createLegacyMcpHandler(server, {
    route: "/mcp",
    enableJsonResponse: true,
    sessionIdGenerator: undefined,
    corsOptions: { origin: "*" },
  })(normalizeAccept(request), env, ctx);
}
```

Why each piece, all verified in the installed tree:

- `createLegacyMcpHandler` is Worker-resident (no Durable Object), defaults `route`
  to `/mcp`, builds a `WorkerTransport` per request and throws if the server is
  already connected — which is why a fresh `buildServer` per request is mandatory
  (`agents/dist/mcp/index.js:1228-1240`).
- `WorkerTransport` extends the SDK v1 `WebStandardStreamableHTTPServerTransport`
  and forwards every SDK option, `enableJsonResponse` included
  (`agents/dist/mcp/index.js:1056-1062`).
- With `enableJsonResponse` the POST response is `Content-Type: application/json`,
  and `mcp-session-id` is emitted only when a session id exists
  (`@modelcontextprotocol/sdk/dist/esm/server/webStandardStreamableHttp.js:73`,
  `:919-930`). With `sessionIdGenerator: undefined` none exists, so the response
  carries no session header and non-initialize POSTs need none.
- `buildServer` already returns a fresh SDK v1 `McpServer` per call
  (`services/mcp/src/server.ts:7-12`).

**Accept normalisation is not optional.** Even in JSON mode the SDK transport 406s a
POST whose `Accept` lacks `text/event-stream`
(`webStandardStreamableHttp.js:464-471`, verified — the check runs before the JSON
branch). `normalizeAccept` clones the request with
`Accept: application/json, text/event-stream` when the header is absent or lacks
either value. The response format is decided by `_enableJsonResponse`, not by
`Accept`, so the client still gets JSON.

### 4.3 Lane selection — deterministic, in `services/mcp/src/index.ts`

Evaluated after the principal is resolved and before lane A's session pre-check:

1. `request.method !== "POST"` → lane A (GET and DELETE keep today's semantics).
2. **Principal came from an OAuth token → lane B, always.** Muse arrives this way, so
   Muse gets JSON no matter what `Accept` it sends. This rule is what removes the risk
   that Muse sends both `Accept` values, lands on lane A, and meets a 25 s SSE
   keepalive (`agents/dist/mcp/index.js:228`) inside Meta's ~20 s ceiling.
3. POST whose `Accept` is absent or lacks `text/event-stream` → lane B. Lane A answers
   exactly this shape with a 406 today, so no shipped client can depend on it. This is
   the zero-regression argument, and it also covers an API-key-lane Muse.
4. POST carrying `MCP-Response-Mode: json` → lane B (documented escape hatch).
5. Otherwise → lane A (Claude Code, Cursor, Codex, Hermes: both `Accept` values plus a
   session id).

### 4.4 Protocol, timeouts, CORS

`SUPPORTED_PROTOCOL_VERSIONS` is `['2025-11-25','2025-06-18','2025-03-26','2024-11-05','2024-10-07']`
(`@modelcontextprotocol/sdk/dist/esm/types.js:4`, verified), so Muse's `2025-06-18`
is accepted on both lanes and echoed by `initialize`.

`ApiClient` gains `timeoutMs` → `signal: AbortSignal.timeout(ms)` on the upstream
fetch (`services/mcp/src/api.ts:38-50` has none today). Lane B passes 15 000 so a hung
upstream becomes a JSON-RPC error inside Meta's ceiling; lane A passes nothing.

`CORS_HEADERS` (`services/mcp/src/index.ts:17-24`) gains `MCP-Response-Mode` in
`Access-Control-Allow-Headers` and `WWW-Authenticate` in
`Access-Control-Expose-Headers`.

---

## 5. Auth

### 5.1 The authorization server

`@cloudflare/workers-oauth-provider@0.10.3`, pinned exactly. It is **not** in the
repo today; the citations below were read from the published npm tarball and **must
be re-verified in the first commit of MU4** against the installed copy. It provides
the metadata documents (`dist/oauth-provider.js:1455-1462`), the RFC 9728
`WWW-Authenticate` builder (`:2907-2915`), and bearer parsing (`:2664-2667`).

```ts
new OAuthProvider({
  apiRoute: "/mcp",
  apiHandler: McpApiHandler,          // reads ctx.props → lane selection
  defaultHandler: ConsentHandler,     // /authorize* pages
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
  scopesSupported: ["mail:read", "mail:drafts", "mail:send"],
  accessTokenTTL: 3600,
  resourceMetadata: { resource: `${env.MCP_PUBLIC_ORIGIN}/mcp`, resource_name: "WZRD Mail" },
})
```

**Credential dispatch runs before the provider.** The provider 401s any request
without a `Bearer` header and parses every bearer as a three-part
`userId:grantId:secret` token (`:2660-2667`). A `wm_live_` key contains no colon, so
the two credential spaces cannot collide — but the key lane must still be checked
first, in `services/mcp/src/index.ts`:

1. `OPTIONS` → 204; `GET /health` → `{ok:true}` (both unchanged).
2. `/mcp` with `x-api-key`, or `Authorization: Bearer wm_…` → key lane → §4.3.
3. everything else → `provider.fetch(...)`: the two well-knowns, `/token`,
   `/register`, `/authorize*`, and `/mcp` with an OAuth bearer (provider validates,
   decrypts `ctx.props`, calls `McpApiHandler` → §4.3).

### 5.2 The 401

`buildWwwAuthenticateHeader` emits `realm`, then `resource_metadata`, then `error`,
then `scope`, then `error_description` (`dist/oauth-provider.js:2910-2915`, verified
in the tarball). A credential-less `POST /mcp` therefore answers:

```
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer realm="OAuth", resource_metadata="https://mcp.mail.wzrd.tech/.well-known/oauth-protected-resource/mcp", scope="mail:read mail:drafts mail:send"
```

An invalid or revoked token adds `error="invalid_token"` after `resource_metadata`.
The body keeps today's envelope (`{name:"unauthorized", message:…}`,
`services/mcp/src/index.ts:90-95`) so the published fallback text in
`plugins/agents/skills/wzrdmail-mcp/SKILL.md:73` stays true for key-only clients.

Muse's client omits `scope` at registration and reads it from this challenge, so the
`scope` member is load-bearing, not decorative.

### 5.3 Scopes

Three scopes, mapping onto the permission vocabulary the API already enforces
(`services/api/src/auth.ts:16-30`: `admin` implies all, `send` implies `drafts`):

| Scope | Permission | Tools it unlocks |
| --- | --- | --- |
| `mail:read` | `read` | every `list_*`, `get_*`, `search_threads`, `get_usage`, `whoami`, `check_new_mail` |
| `mail:drafts` | `drafts` | `create_draft`, `update_draft` |
| `mail:send` | `send` | `send_message`, `reply_to_message`, `reply_all_to_message`, `forward_message`, `send_draft` |

`admin` is never issued over OAuth. `mail:read` is mandatory; unticking it denies the
authorization. The consent page may narrow the rest.

### 5.4 Token → key

On approval the Worker mints one key through the API and calls
`completeAuthorization({ userId: organization_id, scope, metadata: { key_id, inbox_id, client_name }, props: { apiKey, keyId, orgId, inboxId, permissions } })`.
Props are encrypted so only the presented bearer token can unwrap them; `OAUTH_KV`
never holds a readable key, and D1 holds only the SHA-256 hash and the 12-char prefix
(`services/api/src/routes/keys.ts:94-115`). `goal.md` §2 secrets discipline holds:
the plaintext is shown once, to nobody, and stored nowhere legible.

Every grant is **inbox-scoped** (`api_keys.inbox_id`, migration `0012`), so
`requireInbox` (`services/api/src/lib/http.ts:97-126`) confines the connection to one
mailbox and refuses org-level resources outright.

### 5.5 Revocation

Three paths, two of them already shipped:

1. Console → Settings → Connected apps → Disconnect calls the existing
   `DELETE /v0/api-keys/:key_id` (`services/api/src/routes/keys.ts:130-151`). The
   next tool call gets `unauthorized` from the API (`auth.ts:118`); lane B turns that
   into a tool error naming reconnection.
2. `POST /token` with a `token=` parameter is the provider's revocation request
   (`dist/oauth-provider.js:1463-1466`).
3. Token expiry: access 1 h, refresh rotating.

Revoking the key does not delete the grant in `OAUTH_KV`; tokens keep validating at
the provider and fail at the API. That is acceptable (the user sees a clear error)
and is recorded as an open question in §11.

---

## 6. Tools

### 6.1 Annotations

Every registration moves from the 4-arg `server.tool(name, description, shape, cb)`
to the 5-arg overload with annotations
(`@modelcontextprotocol/sdk/dist/esm/server/mcp.js:678-682`; stored at `:605-613`,
emitted in `tools/list` at `:84`). Muse's planner keys confirmation prompts off these.

- read-only (`readOnlyHint: true, openWorldHint: false`): `list_inboxes`, `get_inbox`,
  `list_messages`, `get_message`, `list_threads`, `get_thread`, `search_threads`,
  `list_drafts`, `get_attachment`, `list_webhooks`, `list_domains`, `get_usage`,
  `whoami`, `check_new_mail`.
- sending (`readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true`):
  `send_message`, `reply_to_message`, `reply_all_to_message`, `forward_message`,
  `send_draft`. Mail leaving the system is irreversible; `client_id` makes replay safe
  but the hint tells Muse to confirm.
- writing (`destructiveHint: false`): `create_draft`, `create_inbox`, `create_webhook`
  (`idempotentHint: false`); `update_draft`, `update_message` (`idempotentHint: true`).

### 6.2 Permission-aware catalogue

`registerTools(server, api, opts?: { permissions?, inboxId? })`. When the principal's
permissions are known (the OAuth lane), a tool is registered only if its permission is
granted, so Muse never sees a tool it would get a 403 from. The key lane keeps
registering everything (unchanged). When `inboxId` is known, `inbox_id` becomes
optional on every tool and defaults to it.

### 6.3 Two new tools (22 → 24)

- **`whoami`** — no input; returns `{inbox_id, organization_id, permissions, plan, verified}`.
  Description: "Call first: tells you which @wzrd.tech address you are and what you may do."
  This is how Muse learns its own address.
- **`check_new_mail`** — `{inbox_id?, since?: ISO-8601, limit?: 1-100}` →
  `GET /v0/inboxes/{id}/messages?after=…&limit=…` (the `after` filter already exists,
  `services/api/src/routes/messages.ts:95-111`) → `{messages, count, next_since}`.
  `next_since` is the newest `created_at` seen, or the input when empty. A scheduled
  Muse agent persists it between runs. This is the poll primitive that stands in for
  the push wzrdmail cannot do.

### 6.4 Mark-as-read

`PATCH /v0/inboxes/:id/messages/:msg_id` requires `admin` today
(`services/api/src/routes/messages.ts:272`, verified), which would leave a Muse
connection unable to mark its own mail read. That check drops to `read` for
label and read-state mutations; delete and restore stay `admin`. Recorded in ADR-0004
and announced in the changelog, since it also widens what existing read-only keys can
do. Paths and shapes do not change, so `goal.md` §2 API-shape parity holds.

### 6.5 Mirrors to update

The tool count is hard-coded in four places that must move to 24:
`services/mcp/test/server.test.ts:41-63` (`EXPECTED_TOOLS`),
`plugins/agents/skills/wzrdmail-mcp/SKILL.md:90`, `docs/integrations.md:29`, and
`services/docs/src/content.ts:537-548`.

---

## 7. API changes

### 7.1 New route group `services/api/src/routes/connect.ts`

Mounted under `/v0` beside the others (`services/api/src/app.ts:55-67`). None of
these call `authenticate()`. Each first compares `x-connect-secret` against
`env.CONNECT_SECRET` in constant time and answers the generic `not_found` 404 when the
secret is unset or wrong, so the surface is invisible until provisioned.

| Route | Body | Returns |
| --- | --- | --- |
| `POST /v0/connect/start` | `{email}` | `{registered}` — for an existing org, claims the cooldown row and issues a `connect_login` OTP, mirroring `/console/login` (`services/api/src/routes/console.ts:62-126`) |
| `POST /v0/connect/signup` | `{email, username, org_name?}` | `{message}` — mirrors `/console/signup` (`:162-215`) with KV prefix `connect_pending:` so console and connector sign-ups cannot clobber each other |
| `POST /v0/connect/verify` | `{email, otp_code}` | `{connect_token, organization_id, inboxes[]}` — `checkOtp` (`services/api/src/lib/otp.ts:208-250`) then `verified=1`, or completes the pending signup via `completeSignup` (`console.ts:217-247`) |
| `POST /v0/connect/complete` | `{connect_token, inbox_id, permissions[], name, client_id}` | `201 {api_key, key_id, inbox_id, organization_id, permissions}` — single-use token, inbox must belong to the org, `admin` rejected |

`connect_token` is 32 random bytes; the API stores only its SHA-256 in `CACHE` KV
with a 600 s TTL and deletes it before minting. It never reaches the browser.

### 7.2 Refactors and additive fields

- `mintApiKey()` extracted from `services/api/src/routes/keys.ts:94-115` into
  `services/api/src/lib/keys.ts`, used by both `POST /v0/api-keys` and
  `/v0/connect/complete`.
- `api_keys` rows gain `source` (`'console' | 'agent' | 'oauth'`) and `client_id`,
  surfaced additively in `GET /v0/api-keys` so the console can render Connected apps.
  `POST /v0/agent/sign-up` sets `source='agent'`.
- `OtpPurpose` (`services/api/src/lib/otp.ts:12`) gains `"connect_login"`;
  `sendCodeEmail` (`:120-130`) gets a branch for it (local-dev delivery only —
  staging and production route OTPs through thirdweb, `:157-169`).
- `Env` (`services/api/src/env.ts:1-11`) gains `CONNECT_SECRET?: string`.
- `POST /v0/agent/sign-up` gains a 5-per-hour-per-IP throttle. It has none today
  (`services/api/src/routes/agent.ts:29-101`) while creating a real org, key and inbox
  on an unauthenticated call. Shipping a consumer connector without closing that is
  indefensible at review.

### 7.3 Migration `0015_connect_login.sql`

Forward-only, next after `0014`. SQLite cannot widen a `CHECK` in place, so the table
is rebuilt; rows are preserved and the new columns default, which makes a code
rollback safe without a migration rollback.

```sql
-- Comments go on their own line: the migration runner splits on ';', so a
-- trailing comment becomes a statement-less chunk and the migration fails.
-- 0015_connect_login: third OTP purpose for the MCP OAuth consent flow (muse.md §5);
-- api_keys provenance so the console can list "Connected apps".
CREATE TABLE otp_codes_new (
  org_id     TEXT NOT NULL REFERENCES organizations(org_id),
  purpose    TEXT NOT NULL CHECK (purpose IN ('agent_verify','console_login','connect_login')),
  code_hash  TEXT NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (org_id, purpose)
);
INSERT INTO otp_codes_new (org_id, purpose, code_hash, attempts, expires_at, created_at)
  SELECT org_id, purpose, code_hash, attempts, expires_at, created_at FROM otp_codes;
DROP TABLE otp_codes;
ALTER TABLE otp_codes_new RENAME TO otp_codes;

-- source: console | agent | oauth
ALTER TABLE api_keys ADD COLUMN source TEXT NOT NULL DEFAULT 'console';
-- client_id: the OAuth client_id when source='oauth'
ALTER TABLE api_keys ADD COLUMN client_id TEXT;
```

**Why a new purpose.** `otp_codes` is keyed `(org_id, purpose)` with a closed CHECK
(`services/api/migrations/0004_m2_api.sql:3-11`), `issueOtp` upserts that single row
(`services/api/src/lib/otp.ts:186-200`) and `checkOtp` deletes it on success
(`:246-248`). Reusing `console_login` would let a console sign-in silently invalidate
an in-flight Muse code. `agent_verify` is the agent self-signup slot.

### 7.4 The consent flow, step by step

All browser traffic stays on `https://mcp.mail.wzrd.tech` (same-origin forms).

0. Muse discovers the AS from the 401, registers dynamically, and opens
   `/authorize?response_type=code&client_id&redirect_uri&state&code_challenge&code_challenge_method=S256&scope=…`.
1. `GET /authorize` — `parseAuthRequest` + `lookupClient`; the Worker stores the
   parsed request in `OAUTH_KV` under `consent:<sid>` (600 s TTL) with a CSRF nonce and
   sets `wm_consent=<sid>; HttpOnly; Secure; SameSite=Lax; Path=/authorize`. It renders
   a console-themed page (string template modelled on `services/docs/src/html.ts:152`)
   asking for an email. Per-IP throttle in `OAUTH_KV`, 30/hour.
2. `POST /authorize/email` → `/v0/connect/start`. Known email → code sent. Unknown →
   the page asks for a username.
3. `POST /authorize/signup` → `/v0/connect/signup`. Copy: "Give Muse its own address:
   `____@wzrd.tech`."
4. `POST /authorize/verify` → `/v0/connect/verify`. The org comes back verified,
   because the OTP proved ownership of `human_email` — which is exactly the gate the
   unverified sandbox checks (`services/api/src/egress/send.ts:160-168`), so the new
   inbox can email the outside world immediately.
5. Consent screen: client name, scope checkboxes (`mail:read` locked), inbox picker.
   `POST /authorize/approve` → `/v0/connect/complete` → `completeAuthorization` → 302
   back to Muse. Deny → 302 with `error=access_denied`.
6. Muse exchanges the code at `/token` with its PKCE verifier and calls `/mcp`.

### 7.5 Rate limits

Best-effort KV counters in `CACHE`, the pattern already used by `throttleSignup`
(`services/api/src/routes/console.ts:141-160`); the API has no general limiter today.
`/connect/start` and `/connect/signup`: 5 per email per hour, 20 per IP per hour, plus
the existing 60 s resend cooldown. `/connect/verify`: 5 attempts per code
(`OTP_MAX_ATTEMPTS`). `/connect/complete`: single-use token, 10-minute TTL.
`/register` and `GET /authorize` on the MCP Worker: 30 per IP per hour.
`/v0/agent/sign-up`: 5 per IP per hour (§7.2). Plan caps stay the usage limit and are
enforced server-side as always.

---

## 8. Docs, legal and the listing

### 8.1 Pages

Appended to `PAGES` (`services/docs/src/content.ts:576-586`), which generates the HTML
page, the `.md` variant, the sidebar entry and the `llms.txt` line automatically
(`services/docs/src/app.ts:54-99`, `content.ts:603-616`):

- **`mcp`** — the hosted MCP reference: endpoint, both auth methods, the 401 challenge,
  lane behaviour and the `MCP-Response-Mode: json` escape hatch, all 24 tools with
  their scopes, polling with `check_new_mail`, limits, revocation.
- **`mcp/muse`** — the Muse connector page: what the user sees, the new-account flow,
  scopes, how to disconnect. **This is the form's documentation URL:**
  `https://docs.mail.wzrd.tech/mcp/muse`.
- **`legal/privacy`** and **`legal/terms`** — the first legal pages in the repo. Data
  retention (raw mail in R2, deletion on inbox delete), sub-processors (Cloudflare,
  thirdweb for one-time codes, Stripe reserved), contact addresses. `legal@` and
  `privacy@wzrd.tech` are already reserved local parts (`packages/core/src/reserved.ts:11,15`).
  **Placeholders will fail Meta's legal review — these need a human before MU6.**

`services/www/src/app.ts` gains `app.all("/legal")` and `app.all("/legal/*")` 301s to
the docs host, copied from the `/docs` redirect at `:58-68`, so the URLs the Codex
manifest already advertises finally resolve.

### 8.2 Form values

**Technical specs.** Connection type: Existing MCP. Hosted MCP endpoint:
`https://mcp.mail.wzrd.tech/mcp`. Documentation: `https://docs.mail.wzrd.tech/mcp/muse`.
Authentication methods: ☑ OAuth with PKCE ☑ API keys ☐ Other.

Access requirements:

> Free wzrdmail account, created inside the connect flow if you don't have one (email
> one-time code). Free plan: 3 inboxes, 100 sends/day, 3,000 emails/month; at most 50
> recipients per message; 5 MiB outbound. Sending to outside addresses is enabled once
> the email code is verified, which happens during connection. No regional
> restrictions. OAuth connections are pinned to one inbox; creating inboxes or
> webhooks needs an API key minted in the console. Each tool call is one HTTPS request
> answered as JSON within 20 seconds; new mail is polled with check_new_mail.

**Overview.** Name: WZRD Mail. Short description (≤80): "Give your agent its own
email inbox at @wzrd.tech: send, read, reply, poll." Long (≤120): "Real two-way email
for AI agents. Muse gets an address on wzrd.tech and can send, read, reply and check
for new mail." Category: Productivity. Website: `https://mail.wzrd.tech`. Privacy:
`https://mail.wzrd.tech/legal/privacy`. Terms: `https://mail.wzrd.tech/legal/terms`.
Support: `support@wzrd.tech` — **must be a real routed mailbox before submission**;
only `noreply@wzrd.tech` exists in code today (`services/api/src/lib/otp.ts:110-149`).
Icon: a new 512×512 PNG served from the www Worker, whose wrangler config already
registers `**/*.png` as a Data module (`services/www/wrangler.jsonc:9`).

### 8.3 Plugin and spec text

`plugins/agents/.mcp.json` does not change — the validator requires that exact shape
(`plugins/agents/scripts/validate_repo.py:171-177`). `plugins/agents/README.md:18` and
`skills/wzrdmail-mcp/SKILL.md:73` change from "OAuth is not yet available" to OAuth
being live at the bare URL with header keys still working; both tool lists go to 24;
`compatibility.json` `verifiedAt` and a `CHANGELOG.md` `## 0.2.0` entry follow the
existing format. `services/mcp/src/resources.ts:42-45` and
`services/www/src/llms.ts:36` gain the OAuth line and drop the `/v0/openapi.json` URL
that no route serves. `goal.md` §9 gets a pointer here and the hostname correction,
§15 gains a Meta Muse row, §18 gains the rows in §9.2 below; `goal-console.md` §3.9
gains Connected apps.

---

## 9. Milestones

**Implementation status (2026-09-20, branch `claude/muse-connector-spec`).**
MU0 through MU5 have landed with tests: the Workers harness, the JSON lane, the
connect endpoints and migration 0015, the authorization server and consent
flow, and the docs, legal and listing surface. `pnpm check` is green across all
26 tasks (303 tests). MU6 and MU7 are open: MU6 needs production deploys and a
live Muse account, MU7 waits a week of the JSON lane in production. Three
non-code items block MU6 — legal review of the two placeholder pages, a routed
`support@wzrd.tech`, and the 512×512 icon.

Two corrections this file owes its own readers, found while executing it:
the migration DDL in §7.3 had trailing comments after the semicolons, which the
migration runner cannot parse (comments now sit on their own lines); and §6.4
named only the single-message and thread PATCH routes, while the batch update
performs the identical mutation and is now relaxed with them (ADR 0004).


Each lands as its own PR with its Verify block executed and pasted in, per
`goal.md:539`. Do not start one with the previous Verify failing.

- **MU0 — Spec and ADRs.** This file, plus `docs/decisions/` (the directory does not
  exist yet): ADR-0001 dual lane, ADR-0002 OAuth provider on the MCP host, ADR-0003
  `connect_login` purpose and why not thirdweb, ADR-0004 PATCH permission relaxation.
  Pointers added to `goal.md` §9/§15/§18.
  **Verify:** `pnpm check` still green; every `file:line` cited here opens at the
  quoted text; `docs/decisions/` exists with four ADRs.

- **MU1 — Workers test harness for `services/mcp`.** Add
  `@cloudflare/vitest-pool-workers@0.12.21` (wrangler 4 inside; peer vitest 2.0–3.2 so
  the package's vitest 2.1.9 stays). The repo-wide `0.6.16` pool cannot load
  `agents/mcp`: that entry imports `../index.js`, which statically imports
  `cloudflare:email`, and miniflare 3 provides no `cloudflare-internal:email`. Pools
  ≥0.13 would force vitest ^4.1 repo-wide. Add `vitest.config.ts` in the shape of
  `services/www/vitest.config.ts:1-12`, `test/env.d.ts` after
  `services/api/test/env.d.ts:4-9`, and `@cloudflare/vitest-pool-workers` to
  `tsconfig.json` types. Write `test/http.test.ts` pinning **today's** behaviour before
  anything changes.
  **Verify:** `pnpm --filter @wzrdmail/mcp test` runs `SELF.fetch` inside workerd with
  the Durable Object loaded; the pinned cases are initialize → `text/event-stream` +
  `mcp-session-id`, keyless POST → the current 401 envelope, and Accept-less POST → 406.

- **MU2 — JSON lane and tools.** `json-lane.ts`, `selectLane()`, credential
  canonicalisation, `ApiClient` timeout, annotations on all tools, `whoami` and
  `check_new_mail`, permission-aware registration, the four 24-name mirrors.
  **Verify:** against staging with an API key, a POST carrying `Accept: application/json`
  returns 200 `application/json` with no `mcp-session-id` in under 2 s, and the same
  request with both Accept values returns `text/event-stream` with a session id exactly
  as before; the `StreamableHTTPClientTransport` script in
  `.agents/skills/testing-sdk-cli` lists 24 tools.

- **MU3 — API connect endpoints.** Migration `0015`, `routes/connect.ts`,
  `lib/keys.ts`, the `connect_login` purpose, `source`/`client_id`, rate limits
  including the sign-up throttle, `CONNECT_SECRET`.
  **Verify:** `pnpm --filter @wzrdmail/api test` green including `test/connect.test.ts`
  (secret gate 404; existing-org and new-user paths; `connect_login` and
  `console_login` codes coexisting for one org; single-use token; 429 with
  `Retry-After`); `GET /v0/health` on staging reports `migration_head` `0015`.

- **MU4 — OAuth provider and consent page.** Pin
  `@cloudflare/workers-oauth-provider@0.10.3` and **re-verify every citation in §5
  against the installed copy in the first commit**. Bindings, `setup.ts` multi-service
  provisioning, `consent.ts`, router dispatch, `test/oauth.test.ts`.
  **Verify:** a credential-less `curl -i -X POST https://staging.mcp.mail.wzrd.tech/mcp`
  prints the exact `WWW-Authenticate` string from §5.2; both well-known documents parse
  and advertise S256 and `registration_endpoint`; the MCP Inspector completes
  registration → consent with a fresh email → username → code → token → `tools/call` on
  the new inbox; revoking the key in the console makes the next call fail with a
  reconnect error.

- **MU5 — Docs, legal, listing assets.** The four docs pages, the `/legal/*` 301, the
  icon, plugin and skill text, `llms.txt`, Connected apps in the console, Justfile
  `deploy-mcp` and `deploy-docs` recipes.
  **Verify:** logged-out fetches of `https://docs.mail.wzrd.tech/mcp/muse` and
  `https://mail.wzrd.tech/legal/privacy` return 200 (HTML and, with
  `Accept: text/markdown`, markdown); `python3 plugins/agents/scripts/validate_repo.py`
  passes; the icon is 512×512; a message to `support@wzrd.tech` arrives.

- **MU6 — Production rollout and submission.** Deploy in order: API (migration first)
  → console → docs and www → MCP. Then submit the form with §8.2 verbatim.
  **Verify:** from a Meta test account with no wzrdmail account, connecting WZRD Mail
  creates `<username>@wzrd.tech`, `whoami` returns it, `send_message` to a probe address
  lands, and a scheduled `check_new_mail` returns the reply with a non-empty
  `next_since`. `wrangler tail wzrdmail-mcp` shows only `application/json` responses to
  the Meta egress and no 406s. The transcript goes in the PR. Each review finding maps
  to a fix PR.

- **MU7 — Durable Object retirement (only after a week of MU2 in production).** Remove
  the `MCP_OBJECT` bindings, the `McpAgent` class and `sessionKeyGuard`, and add the
  deletion migration tag — **confirm the exact key (`deleted_classes` vs
  `deleted_sqlite_classes`) against `services/mcp/node_modules/wrangler/config-schema.json`
  before writing it.** Lane B becomes the only lane.
  **Verify:** deploy succeeds, no Durable Object namespace remains for
  `wzrdmail-mcp`, and every MU2 check still passes.

### 9.1 Deploy and rollback

Deploy: `just setup <env>` (extended to provision `OAUTH_KV` and upload
`CONNECT_SECRET` to both Workers) → API with `0015` applied → MCP. The connect routes
stay dark until the secret exists, so the API can ship first safely.

Rollback: `wrangler rollback` on the MCP Worker restores the key-only build; lane A
never changed and `OAUTH_KV` contents go inert. The API's connect routes are additive
and dark without the secret. `0015` stays applied — forward-only, and its additions are
inert to older code. After MU7 a rollback needs a new migration tag re-declaring the
class, which is why MU7 is last and separate.

### 9.2 Bindings, secrets, env

`services/mcp/wrangler.jsonc`: vars `WZRDMAIL_ENV` (also the anchor
`patchWranglerConfig` needs, `scripts/setup.ts:126-129`) and `MCP_PUBLIC_ORIGIN`;
`kv_namespaces` `OAUTH_KV` with the `placeholder-set-by-setup-script` sentinel at top
level and real ids per env, mirroring `services/api/wrangler.jsonc:31-36,55-57,76-78`.
Secret `CONNECT_SECRET` on **both** Workers.

`scripts/setup.ts` is hard-wired to `services/api` (`:21-22`, `:34-35`, `:167`). MU4
introduces a services table so the KV-create block (`:68-82`) and the
`secret put`-via-stdin loop (`:148-170`) run per service.
`scripts/config.example.toml` gains a `[connect]` section. Local dev uses each
service's `.dev.vars`, already gitignored (`.gitignore:6`).

`goal.md` §18 gains: `MCP_PUBLIC_ORIGIN` (var, mcp), `OAUTH_KV` (KV binding, mcp),
`CONNECT_SECRET` (secret, api + mcp).

---

## 10. Security and abuse model (additions to `goal.md` §16)

| Threat | Control |
| --- | --- |
| Stolen OAuth access token | 1 h TTL; props decryptable only with the presented token; revoke in the console kills the underlying key immediately; the API re-validates on every call (`services/api/src/auth.ts:86-131`) |
| Consent-page CSRF | Same-origin forms, `wm_consent` cookie double-submitted against a nonce in `OAUTH_KV`, `Origin` compared to `MCP_PUBLIC_ORIGIN` |
| Open dynamic registration | Muse registers on every login by design; 30/hour per IP; registration alone grants nothing; a daily purge of never-used clients if growth appears |
| Sign-up abuse through the connector | The flow creates real `@wzrd.tech` inboxes; per-email and per-IP KV limits, the 60 s OTP cooldown, 5 attempts per code, plus the new `/v0/agent/sign-up` throttle; free-plan caps and the suppression list bound the damage |
| Shared-secret compromise between Workers | `CONNECT_SECRET` gates only the four connect routes, is constant-time compared, rotates with one `wrangler secret put` per service, and never appears in a browser |
| Cross-tenant access through a grant | Grants are inbox-scoped; `requireInbox` (`services/api/src/lib/http.ts:97-126`) enforces org, pod and inbox; a foreign-org 404 test is mandatory per `goal.md` §16 |
| Plaintext key in a new place | Only inside the provider's encrypted grant props; D1 keeps the SHA-256 (`services/api/src/routes/keys.ts:94-115`); never logged, never shown |
| Prompt-injected mail driving Muse | Out of our control and inherent to email; mitigated by inbox scoping, no `admin`, destructive hints on every send tool so Muse confirms, and the free-plan send cap |

---

## 11. Open questions (decide during build, record as ADRs)

1. Muse's exact `Accept` header and whether it echoes `mcp-session-id`. Rule 2 of §4.3
   makes both irrelevant for OAuth connections, but MU6 should record what actually
   arrives, from `wrangler tail`.
2. Whether Meta's review demands an RFC 7009 revocation endpoint or token
   introspection beyond the provider's `/token` revocation. Answer with the console
   path first; add an endpoint if asked.
3. Whether revoking a key should also delete the grant in `OAUTH_KV`. Today it does
   not; the user sees a clear error instead. A console endpoint calling `revokeGrant`
   is the fix if the UX proves confusing.
4. thirdweb holds one-time codes per email address in staging and production
   (`services/api/src/lib/otp.ts:157-169`), so a console sign-in and a Muse connect
   started for the same address within a minute may invalidate each other's code even
   with separate purposes. Cannot be fixed in-repo without moving delivery in-house.
5. Whether the consent page should eventually offer the thirdweb sign-in the console
   uses. It would need a bundler in the MCP Worker; ADR-0003 records the trade.
6. Whether to keep both pool versions long-term. `services/mcp` runs
   `vitest-pool-workers@0.12.21` and the rest of the repo runs `0.6.16`; a future
   vitest 4 upgrade forces ≥0.13 everywhere at once.

---

## 12. References

- Muse Platform connector form and program (`muse.ai/platform`, opened to third
  parties 2026-09-18); Meta's Muse announcement and Secure VM / Sentinel / Secure
  Credentials Store write-up; Muse Code developer docs.
- Third-party connector submissions reporting Muse's MCP client behaviour — JSON-only
  Streamable HTTP, HTTP/1.1, ~20 s ceiling, `MCP-Protocol-Version: 2025-06-18`,
  registration on every login, scope taken from the `WWW-Authenticate` challenge,
  401 with RFC 9728 metadata expected. Observational, not a published checklist.
- MCP specification: `2025-06-18`, `2025-11-25` (client ID metadata documents),
  `2026-07-28` (dynamic registration deprecated in favour of CIMD, RFC 9207 issuer
  validation, stateless requests).
- `@cloudflare/workers-oauth-provider` 0.10.3; Cloudflare Agents SDK 0.21.0
  (`McpAgent` deprecated, `agents/dist/mcp/index.js:1290-1295`);
  `@modelcontextprotocol/sdk` 1.30.0.
- RFC 6749, RFC 6750 §3.1, RFC 7009, RFC 7591, RFC 9728, and OAuth 2.1 (PKCE S256).

---

End of specification. If reality contradicts this document, update it in the same PR
that ships the contradiction, with an ADR in `docs/decisions/`.
