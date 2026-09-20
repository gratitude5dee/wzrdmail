# ADR 0001 — Two transport lanes on one MCP path

Date: 2026-09-20 · Status: accepted · Implements: [muse.md](../../muse.md) §4

## Context

`services/mcp` serves Streamable HTTP through the Cloudflare Agents SDK's
`McpAgent`, which bridges each request into a Durable Object over a WebSocket.
Three properties of that path, all verified against the installed
`agents@0.21.0`, make it unusable for a hosted consumer agent such as Meta Muse:

- `McpAgent.serve()` accepts only `{binding, corsOptions, transport, jurisdiction}`.
  There is no response-format option, so JSON cannot be asked for.
- Its POST handler answers 406 unless `Accept` contains **both**
  `application/json` and `text/event-stream`, before auth or the DO is reached.
- Every request POST is answered `text/event-stream`, with a 25-second
  keepalive, over a bridge whose in-DO transport can only emit SSE frames.

Muse connects from a hosted runtime that will not hold an SSE stream and works
to a per-request ceiling of roughly twenty seconds. A pinning test written
before any change confirmed all three behaviours in workerd.

`McpAgent` is also marked deprecated and feature-frozen upstream.

## Decision

Add a second, Worker-resident, stateless lane on the same `/mcp` path using
`createLegacyMcpHandler` with `enableJsonResponse: true` and
`sessionIdGenerator: undefined`, and keep the Durable Object lane exactly as it
is. Lane choice is deterministic:

1. non-POST → streaming (GET/DELETE semantics unchanged);
2. OAuth principal → JSON, always;
3. `Accept` without `text/event-stream` → JSON;
4. `MCP-Response-Mode: json` → JSON;
5. otherwise → streaming.

Rule 3 is the zero-regression argument: the streaming lane answers exactly that
shape with a 406 today, so no working client can be relying on it. Rule 2
exists because a consumer agent's `Accept` header is not something we control,
and being streamed at is a failure it cannot recover from mid-request.

Inbound `Accept` is rewritten on the JSON lane because the SDK transport
rejects a JSON-only `Accept` before the JSON branch is reached. That is safe:
the response format is decided by `enableJsonResponse`, not by the request.

## Alternatives rejected

**Replace the DO lane outright.** Simpler in the end state, but it moves every
shipped client — editors, CLIs, the plugin — onto new code in the same change
that chases a listing deadline. Deferred to its own milestone after the JSON
lane has run in production.

**Migrate to MCP SDK v2 (`createMcpHandler`).** Its modern lane answers JSON,
but the 2025-era compatibility lane Muse would land in still builds an SSE
transport with no JSON mode, and the tool registry would have to be rewritten
against a different `McpServer`. The JSON lane is the seam to migrate through
later.

## Consequences

- The JSON lane has no sessions, no server-initiated notifications and no
  resumability. Nothing in the current toolset uses any of them.
- A future tool needing more than the request ceiling must be a start/poll
  pair, not a held request.
- Two lanes is more surface than one. ADR 0004's successor should remove the
  streaming lane once the JSON lane has proven itself.
