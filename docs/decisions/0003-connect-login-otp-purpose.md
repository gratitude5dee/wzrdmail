# ADR 0003 — A third one-time-code purpose for connector sign-in

Date: 2026-09-20 · Status: accepted · Implements: [muse.md](../../muse.md) §7.3

## Context

The consent page signs a user in with an emailed one-time code. `otp_codes` is
keyed `(org_id, purpose)` with a closed `CHECK` allowing `agent_verify` and
`console_login`. Issuing upserts that single row and a successful check deletes
it.

Reusing `console_login` would therefore let a console sign-in started in
another tab silently invalidate a code issued for a connector authorization,
and vice versa. `agent_verify` is the agent self-signup slot and is not a human
login.

The consent page could instead have reused the federated sign-in the console
actually ships. That was rejected: the MCP Worker has no bundler, and a sign-in
page is the wrong place to start loading a third-party script.

## Decision

Add `connect_login` as a third purpose. SQLite cannot widen a `CHECK` in place,
so migration 0015 rebuilds the table, preserving rows, and the code union gains
the value.

A user who has no account yet has no `org_id` to key a row on, so their pending
signup lives in KV under its own prefix — the same mechanism console signup
already uses, under a different prefix so the two cannot clobber each other.

## Consequences

- One more forward-only migration; rows are preserved and new columns default,
  so rolling code back without rolling the migration back is safe.
- In staging and production the codes themselves are delivered and verified by
  the upstream identity provider, keyed by email address. Two flows started for
  the same address within a minute can still invalidate each other's code there,
  regardless of the purpose split. The user retries. Fixing it would mean
  bringing delivery in-house.
