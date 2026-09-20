# ADR 0002 — The OAuth authorization server runs on the MCP Worker

Date: 2026-09-20 · Status: accepted · Implements: [muse.md](../../muse.md) §5

## Context

Listing the MCP server in a consumer-agent connector directory requires OAuth
2.1 with PKCE, dynamic client registration, and a 401 carrying RFC 9728
protected-resource metadata. `goal.md` §9 anticipated this and named
`workers-oauth-provider`, but nothing was built.

Three hosting options existed:

- **The MCP Worker.** It is the only Worker routed to the MCP hostname, which
  is where RFC 9728 requires the resource metadata to live. It has no database.
- **The API Worker.** It owns D1 and can mint keys directly, but it is not the
  resource host and mounts only `/v0`.
- **The console.** A static-asset Worker with no server code at all.

## Decision

Run the authorization server on the MCP Worker with
`@cloudflare/workers-oauth-provider`, pinned to 0.10.3, and have its consent
page reach the database through four secret-gated server-to-server endpoints on
the API (ADR 0003).

Credential dispatch runs *before* the provider: the provider 401s anything
without a `Bearer` header and parses every bearer as its own three-part token,
so an existing `wm_` key would be turned away. A `wm_` key contains no colon,
so the two credential spaces cannot collide.

Each grant maps to exactly one inbox-scoped API key. The key's plaintext lives
only inside the provider's encrypted grant props, which only the presented
bearer token can unwrap; the database keeps the hash, as it does for every key.

Scopes are `mail:read`, `mail:drafts`, `mail:send`, mapping onto the permission
vocabulary the API already enforces. `admin` is never issued over OAuth.

## Alternatives rejected

**Hand-rolled authorization server in the API.** It would sit next to the data
and need no shared secret, but it means writing PKCE, registration, token
rotation and revocation ourselves — security-critical code that a connector
review will scrutinise — and it still leaves the resource metadata on the wrong
host.

**Browser-side calls from the consent page to the API.** Would require adding
the MCP origin to the API's credentialed-CORS allowlist and widening the CSRF
guard. Server-to-server calls avoid touching either.

## Consequences

- The MCP Worker gains a KV binding and a shared secret it did not have.
- OAuth stays dark until all three of KV, the secret and the public origin are
  provisioned, so the Worker deploys safely ahead of the API.
- Revoking the key in the console does not delete the grant in KV; tokens keep
  validating at the provider and fail at the API. The user sees a clear error.
  A console endpoint calling `revokeGrant` would close this.
- `global_fetch_strictly_public` is set on deployed environments (it enables
  client ID metadata documents and silences a module-scope warning) but not in
  dev, where fetching the local API needs private hosts.
