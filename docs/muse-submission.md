# Muse Platform submission packet

Paste-ready values for the connector listing form at `muse.ai/platform`, plus
the runbook that has to be green before submitting. Everything here was taken
from the code, not from the spec: the limits come from
`packages/core/src/plans.ts`, the scopes from `services/mcp/src/scopes.ts`, the
challenge string from a live response.

This file is the operator's checklist. The user-facing page is
`https://docs.mail.wzrd.tech/mcp/muse`.

---

## 1. Blockers — none of this can be submitted until these are done

| Blocker | Why it blocks | Who |
| --- | --- | --- |
| Legal review of `/legal/privacy` and `/legal/terms` | Both pages open with a draft warning and carry `[PLACEHOLDER]` for operating entity, registered address, governing law and effective date. A reviewer reads these. | counsel |
| `support@wzrd.tech` routed to a real mailbox | Cited on the form, both legal pages, the connector page and all four plugin manifests. Only `noreply@` exists in code today. | operator |
| Production deploy | Nothing below can be verified against a URL that does not answer. | operator |

The icon is done: `services/www/src/assets/icon-512.png`, 512×512, served at
`https://mail.wzrd.tech/icon-512.png`.

---

## 2. Deploy runbook

Order matters. The API must carry migration 0015 and the shared secret before
the MCP Worker can authorize anything against it.

```bash
# 0. One-time: fill scripts/config.toml (gitignored) from config.example.toml.
#    The [connect] secret must be the SAME value for both Workers:
openssl rand -hex 32          # paste into [connect] secret

# 1. Provision + migrate + set secrets, per environment.
#    This now also creates the MCP Worker's OAuth KV namespace and puts
#    CONNECT_SECRET on both Workers.
just setup staging

# 1b. Confirm each env block got its OWN namespace id. The three ids must all
#     differ; two blocks sharing one means a bad patch, not a saving.
grep -A1 '"binding": "OAUTH_KV"' services/mcp/wrangler.jsonc

# 2. Deploy, API first.
just deploy staging
just deploy-docs staging
just deploy-mcp staging

# 3. Verify the transport and discovery surface before any human touches it.
npx tsx scripts/muse-smoke.ts https://staging.mcp.mail.wzrd.tech <wm_live_key>

# 4. Repeat for production.
just setup prod && just deploy prod && just deploy-docs prod && just deploy-mcp prod
npx tsx scripts/muse-smoke.ts https://mcp.mail.wzrd.tech <wm_live_key>
```

`just setup` is idempotent and is also the disaster-recovery script. If the
`[connect]` secret is absent it warns and carries on: the OAuth lane simply
stays dark and the Worker keeps serving API-key clients, so a partial rollout
never takes the server down.

---

## 3. Form values

### Connection type

**Existing MCP.**

### Hosted MCP endpoint

```
https://mcp.mail.wzrd.tech/mcp
```

### API or MCP documentation

```
https://docs.mail.wzrd.tech/mcp/muse
```

Public, no login. Also serves as markdown at `/mcp/muse.md` and via
`Accept: text/markdown`, and is listed in `https://docs.mail.wzrd.tech/llms.txt`.

### Authentication methods

- [x] **OAuth with PKCE** — authorization code with PKCE S256, dynamic client
      registration, no pre-shared client id needed.
- [x] **API keys** — header `x-api-key: wm_live_…`, minted in the console.
- [ ] Other

### Access requirements

```
Free wzrdmail account; one is created during connection if you do not have one
(email address plus a one-time code). Free plan: 3 inboxes, 100 sends per day,
3,000 emails per month, 3 GB of storage. Platform limits: 50 recipients per
message, 5 MiB outbound, 25 MiB inbound stored.

Sending to outside addresses is enabled once the emailed code is verified,
which happens inside the connection flow, so a new account can send
immediately after connecting.

An OAuth connection is pinned to exactly one inbox and never carries admin, so
it cannot create inboxes, webhooks or domains, or mint keys. Those need an API
key minted in the console.

No regional restrictions. Every tool call is a single HTTPS request answered as
JSON; the server's own upstream timeout is 15 seconds. There is no push
notification for new mail: agents poll check_new_mail with a cursor.
```

### Overview

| Field | Value |
| --- | --- |
| Name | WZRD Mail |
| Short description (≤80) | `Give your agent its own email inbox at @wzrd.tech: send, read, reply, poll.` |
| Long description (≤120) | `Real two-way email for AI agents. Muse gets an address on wzrd.tech and can send, read, reply and check for new mail.` |
| Category | Productivity |
| Website | `https://mail.wzrd.tech` |
| Privacy policy | `https://mail.wzrd.tech/legal/privacy` |
| Terms of service | `https://mail.wzrd.tech/legal/terms` |
| Support email | `support@wzrd.tech` |
| Icon | `https://mail.wzrd.tech/icon-512.png` (512×512 PNG) |

---

## 4. What a reviewer will find

**The 401 challenge**, verbatim from a running server:

```
WWW-Authenticate: Bearer realm="OAuth",
  resource_metadata="https://mcp.mail.wzrd.tech/.well-known/oauth-protected-resource/mcp",
  scope="mail:read mail:drafts mail:send"
```

**Discovery documents**

- `https://mcp.mail.wzrd.tech/.well-known/oauth-protected-resource/mcp`
- `https://mcp.mail.wzrd.tech/.well-known/oauth-authorization-server`

The second advertises `code_challenge_methods_supported: ["S256"]` and a
`registration_endpoint`, so a client with no prior relationship can connect.

**Scopes**

| Scope | Grants |
| --- | --- |
| `mail:read` | Read mail, threads, drafts and usage. Always required. |
| `mail:drafts` | Write drafts. Never sends. |
| `mail:send` | Send, reply and forward. |

`admin` is never issued over OAuth.

**Transport.** A POST whose `Accept` omits `text/event-stream` is answered
`application/json` with no session id, which is the shape a hosted agent sends.
Streaming clients that ask for an event stream keep getting one.

---

## 5. End-to-end acceptance (needs a real Muse account)

Run these in order against production. This is the MU6 exit condition.

1. From a Muse account with **no** wzrdmail account, connect to
   `https://mcp.mail.wzrd.tech/mcp`.
2. The sign-in page asks for an email, then a username, then the emailed code.
   Confirm the consent screen names the client, shows the three scopes with
   `mail:read` locked, and names the inbox.
3. Approve. Confirm Muse reports a successful connection.
4. Have Muse call `whoami`. It must return `<username>@wzrd.tech`.
5. Have Muse `send_message` to a probe address you control. Confirm it arrives.
6. Reply to it from that address.
7. Have Muse call `check_new_mail`. Confirm the reply is returned and
   `next_since` is non-empty.
8. In the wzrdmail console, Settings → Connected apps: confirm the connection
   is listed, then Disconnect. Confirm Muse's next tool call fails.

Paste the transcript into the PR. While the review runs, watch
`npx wrangler tail wzrdmail-mcp --env production` and confirm every response to
Meta's egress is `application/json` and there are no 406s — a 406 means a
client reached the streaming lane and the lane rules need revisiting.

---

## 6. If the review comes back with findings

Map each finding to a fix PR rather than patching production directly. The two
most likely asks, and where they land:

- **A token revocation endpoint (RFC 7009).** The provider handles revocation
  on its token endpoint; if an explicit, separately documented endpoint is
  wanted, it is a route addition on the MCP Worker.
- **Deleting the grant when a key is revoked.** Today revoking in the console
  kills the key and the token then fails at the API, but the grant record
  survives until it expires. Closing that means a console endpoint calling the
  provider's `revokeGrant`. Recorded as an open question in `muse.md` §11.
