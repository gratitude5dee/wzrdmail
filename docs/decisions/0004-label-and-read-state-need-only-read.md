# ADR 0004 — Labelling and marking read require `read`, not `admin`

Date: 2026-09-20 · Status: accepted · Implements: [muse.md](../../muse.md) §6.4

## Context

`PATCH` on a message or thread — which is how labels and read state are
changed — required the `admin` permission. Deleting and restoring share those
routes' neighbourhood and legitimately need it.

OAuth grants never carry `admin` (ADR 0002). A connected agent could therefore
read its own mail but not mark it read, which makes the polling workflow
degrade: every poll re-reports messages the agent has already handled, and the
agent has no way to record that it handled them.

## Decision

Label and read-state mutations require `read`, on the single-message PATCH, the
thread PATCH and the batch update alike — they are the same mutation, and a key
that can label one message should not be stopped at five. Delete and restore
stay `admin`.

Marking your own mail read is mailbox hygiene, not administration. The API's
existing scoping is unchanged: a key still only reaches inboxes inside its own
organization, pod and — for inbox-scoped keys — its one inbox.

## Consequences

- Existing read-only keys gain the ability to change labels and read state.
  That is a widening of what an already-issued credential can do, so it is
  called out in the changelog rather than shipped silently.
- Paths, request shapes and response shapes do not change, so the API-shape
  parity rule in `goal.md` §2 holds.
- Any test that asserted the `admin` requirement on those two routes is updated
  in the same change.
