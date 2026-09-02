# Administration: domains, lists, pods, keys, usage

All examples are raw `/v0` HTTP; the TypeScript SDK and CLI wrap each one. Authenticate with `Authorization: Bearer wm_…`.

## Domains

```http
POST /v0/domains              { "domain": "example.com" }          → domain_id, status: "pending", records[]
GET  /v0/domains
GET  /v0/domains/{domain_id}                                        → records (DKIM/SPF/MX/DMARC) with expected values
POST /v0/domains/{domain_id}/verify                                 → status: "verified" | "failed"
```

- Add every returned DNS record verbatim; verification checks all of them.
- Inboxes default to `@wzrd.tech`, which is pre-verified. Pass `domain` on inbox create to use a verified custom domain.
- Sending from an unverified domain is refused with a `forbidden` error naming the domain.

## Allow / block lists

One entry per call; there is no bulk update.

Native shape (inbox-, pod-, or org-level):

```http
POST   /v0/inboxes/{inbox_id}/lists      { "kind": "allow" | "block", "pattern": "spam@example.com" | "@example.com" }
GET    /v0/inboxes/{inbox_id}/lists?kind=block
DELETE /v0/inboxes/{inbox_id}/lists/{entry_id}
POST   /v0/lists                          { "kind": "block", "pattern": "@junk.example", "inbox_id" | "pod_id" | (none = org) }
```

AgentMail-compatible receive/block alias (identical rows underneath):

```http
POST   /v0/inboxes/{inbox_id}/lists/receive/block          { "pattern": "spam@example.com" }   # or { "address": … } / { "domain": "junk.example" }
GET    /v0/inboxes/{inbox_id}/lists/receive/block
DELETE /v0/inboxes/{inbox_id}/lists/receive/block/{entry}   # entry = lst_… id or the exact pattern
```

Patterns are lowercased; `@domain` matches every address at that domain. Blocked inbound mail is dropped before storage and emits `message.rejected` (with `data.reason` and `data.pattern`) instead of `message.received`. When an allow list exists for a scope, only allowed senders are delivered.

## Pods

Pods partition an organization (one per tenant / environment). Inboxes belong to exactly one pod; the default pod is created with the org.

```http
POST /v0/pods        { "name": "customer-42", "client_id": "user_42" }
GET  /v0/pods
```

## API keys

```http
POST /v0/api-keys  { "name": "box", "pod_id"?: "pod_…", "inbox_id"?: "agent@wzrd.tech", "permissions"?: ["read","drafts"], "client_id"? }
GET  /v0/api-keys?pod_id=…&inbox_id=…
DELETE /v0/api-keys/{key_id}
```

- `api_key` (`wm_live_…`) is returned once on create.
- `permissions` default to the creating key's; a key can never mint broader permissions than its own.
- `inbox_id` makes the key inbox-scoped: it sees only that inbox, inherits the inbox's `pod_id`, and cannot create inboxes, pods, domains, or webhooks. An inbox-scoped key can only mint further keys for the same inbox.
- `pod_id` makes the key pod-scoped; `pod_id` and `inbox_id` must agree.
- `read,drafts` without `send` is the draft-only shape: `create_draft` works, every send/reply/forward path returns `403 forbidden`.

## Usage

```http
GET /v0/usage?month=2026-09    → per-metric used / limit for the plan
```

Plan caps return `403 plan_limit_exceeded`; the console's Upgrade flow lifts them.
