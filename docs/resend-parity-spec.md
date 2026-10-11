# Spec — wzrdmail updates derived from the Resend API reference

Status: proposal (analysis + spec only, no implementation)
Source: Resend OpenAPI 3.1 spec `resend.yaml` v1.5.1 (https://github.com/resend/resend-openapi) + https://resend.com/docs/api-reference/
Analyzed: 2026-10-10 against `wzrdmail` @ f67e305

## 1. Method and framing

Resend is a **send-centric** email API: the unit is an outbound `email`, org-scoped, address-agnostic. wzrdmail is **inbox-centric**: the unit is a persistent two-way inbox (`user@wzrd.tech`) scoped to an org/pod, with inbound = first-class. The reference product contract is AgentMail v0 shape (goal.md §2: "Do not improve paths, casing, pagination, or error envelopes away from AgentMail's shape. Additive extensions live under `x_` prefixed fields or new endpoints").

So this spec does **not** transplant Resend's resource tree. It maps each Resend capability onto the wzrdmail domain model and keeps only what strengthens the agent-inbox loop. Everything proposed is additive: new endpoints, new optional request fields, new `x_*` response fields, new enum values. No mirrored field changes.

Resend surface reviewed (105 operations, 16 groups): emails (+batch, +receiving, +metrics, share), domains (+claim), api-keys, oauth/grants, templates, audiences, contacts (+imports), segments, topics, contact-properties, broadcasts, webhooks (+events/attempts/rotate), suppressions, logs, automations, events, usage.

## 2. What wzrdmail already has (verified parity)

| Resend capability | wzrdmail equivalent |
|---|---|
| `POST /emails` + `Idempotency-Key` | `POST /v0/inboxes/:id/messages/send` + `Idempotency-Key` header and `client_id` body idempotency (`idempotency_keys` table) |
| `scheduled_at` send | `send_at` on send/reply/forward/drafts; `scheduled` state + guarded `scheduled→queued` cron sweep (`egress/scheduled.ts`), incl. abandoned-claim recovery and dispatch-time suppression re-check |
| `POST /emails/:id/cancel` (semantic) | Trashing a scheduled message cancels delivery; `POST .../restore` re-arms `send_at` if still in the future |
| Sent/received email objects | `messages` + `threads` (richer: extracted_text/html, labels, batch ops, search, trash) |
| Attachments on inbound | `attachments` table + `GET .../messages/:id/attachments/:att_id`, `content_id` on output schema |
| `GET /emails/receiving` | The whole product — inbound pipeline (Email Routing → queue → parse → thread/lists policy → R2 raw) |
| Domains CRUD + verify | `domains` routes + `POST /domains/:id/verify` with per-record DNS checks |
| API keys CRUD | `api-keys` create/list/delete, pod-scoped keys, `permissions` array (`read,drafts` etc.), `last_used_at`, `key_preview` |
| Webhooks CRUD + deliveries + attempts + replay | `webhooks` org + inbox-scoped CRUD, custom headers, `pod_ids` filter, `webhook_deliveries` w/ attempts + `redeliver`, Svix-compatible `whsec_` signing |
| Suppression-on-bounce/complaint | `suppressions` table auto-inserted from DSN ingress (`ingress/dsn.ts`), enforced at send (`suppressed_recipient` 400) and at scheduled dispatch |
| `GET /emails/metrics`, `GET /usage` | `GET /v0/metrics` (totals + bucketed series), `GET /v0/metrics/usage`, `GET /v0/usage` (plan counters) |
| allow/block policy | `lists` (org + inbox scoped, `receive/block`) — inbound-side |
| Contacts/store for correspondents | not applicable — see §7 non-goals |

## 3. Gap analysis → proposed changes

Priorities: **P0** small/cheap high-value, **P1** deliverability surface, **P2** observability, **P3** tracking pipeline (goal.md already reserves it for V1.1), **Decide** = conflicts with goal.md §3 non-goals, needs your call.

### P0 — send lifecycle parity

| # | Change | Wire/API | Notes |
|---|---|---|---|
| 1 | **Batch send** | `POST /v0/inboxes/:inbox_id/messages/batch-send` → `{messages: SendMessageInput[]}` (max 100, Resend parity) → `{results: [{index, message_id? , error?}]}` | Per-item validation; each item flows through the same `sendMessage` path (idempotency via per-item `client_id`; header `Idempotency-Key` dedupes the batch itself). Meter once per accepted item in `usage_counters`. |
| 2 | **Cancel scheduled without trashing** | `POST /v0/inboxes/:inbox_id/messages/:msg_id/cancel` → message | Guard: only when `state = 'scheduled'` and `deleted_at IS NULL` (else 409 `conflict`). Sets state `cancelled`, keeps row visible in list. New enum value `cancelled` on `MessageState` — additive; SDKs must tolerate unknown states (note in SDK changelog). Trash-cancel keeps working unchanged. |
| 3 | **Reschedule** | `PATCH .../messages/:msg_id` gains `send_at` (ISO, future) | Only valid while `state ∈ {scheduled, cancelled}`; `cancelled → scheduled` un-cancels. 409 otherwise. |
| 4 | **`reply_to` as array** | widen to `string | string[]` on send/reply/reply-all/forward/drafts | Additive widening; `ReplyMessageInput.reply_to` currently single `z.string().email()`. Render `Reply-To:` with all addresses. |
| 5 | **Attachment `path` + `content_id`** | `SendAttachmentInput` += `content_id` (inline cid), `path` (https URL fetched server-side at send) | `content` or `path` required (oneOf). Fetch guards: http(s) only, no private/loopback ranges, ≤3 redirects, ≤5 MiB post-fetch (existing `message_too_large`). `content_id` enables `cid:` inline images — already on the output schema, just missing on input. |
| 6 | **List attachments** | `GET .../messages/:msg_id/attachments` → `{attachments: Attachment[]}` | Metadata only; single-get exists. |
| 7 | **API key rename** | `PATCH /v0/api-keys/:key_id` `{name}` | Resend parity; console rename. |
| 8 | **New event types** | `EventType` += `message.scheduled`, `message.failed`, `message.cancelled` | Cheap enum additions; `message.failed` fires when dispatch settles `failed` (currently silent). |

### P1 — deliverability surface (suppressions + domains)

| # | Change | Wire/API | Notes |
|---|---|---|---|
| 9 | **Suppressions resource** (the table + enforcement already exist) | `GET /v0/suppressions?reason=bounce|complaint|manual` → `{suppressions:[{address, reason, source_msg_id, created_at}]}`; `POST /v0/suppressions` `{address}` (reason=manual); `DELETE /v0/suppressions/:address`; `POST /v0/suppressions/batch` `{add: [], remove: []}` | Org-scoped like `lists`. Send-time check already in `egress/send.ts`; manual entries reuse it. Resend's `origin` = our existing `reason` column. |
| 10 | **Suppression events** | `EventType` += `suppression.added`, `suppression.removed` | Emit from DSN ingest path + manual API. Resend: `suppression.added/removed` — same names. |
| 11 | **Domain update** | `PATCH /v0/domains/:domain_id` `{custom_return_path?, client_id?}` | Resend also offers `open_tracking/click_tracking/tls/tracking_subdomain` — wzrdmail puts tracking on the **inbox** (goal.md §3: "V1.1 flag per inbox"), so domain PATCH only gets `custom_return_path` now; TLS/tracking-subdomain deferred to §5 when CF Email Service supports it. |
| 12 | **Domain events** | `EventType` += `domain.created`, `domain.deleted`, `domain.failed` | `domain.verified` exists. |

### P2 — observability

| # | Change | Wire/API | Notes |
|---|---|---|---|
| 13 | **Per-message event timeline** | `GET .../messages/:msg_id/events` → `{events: EventEnvelope[]}` | `events` table is immutable already; add indexed `msg_id` column (new migration) populated from emit sites so the query isn't `json_extract` scans. Powers console timeline + agent debugging. |
| 14 | **Webhook secret rotation** | `POST /v0/webhooks/:webhook_id/rotate-secret` → `{secret}` shown once | Resend `/signing-secret/rotate` equivalent. Hash stored, plaintext once. |
| 15 | **Webhook events view** | `GET /v0/webhooks/:webhook_id/events` (+ `/events/:event_id`) | List `events` rows matching the webhook's org + `pod_ids`/`inbox_id`/`event_types` filter. `deliveries` stays canonical for attempts/redeliver — this adds the event-payload view Resend exposes. |
| 16 | **Share link** | `POST .../messages/:msg_id/share` `{expires_in?: seconds (default 86400, max 7d)}` → `{share_url}` | Renders the same CSP-sanitized HTML the console uses, snapshotted at mint time (immutable even if message is edited/restored). Token = unguessable id; no auth on fetch; expiry enforced at read. Public URL e.g. `https://api.wzrd.tech/v0/share/:share_id`. |
| 17 | **Metrics filters** | `GET /v0/metrics` += `since`, `until`, `granularity=hour|day`, `type` (event/state filter), `inbox_id`, `pod_id` | Additive query params over existing series/totals shape. |
| 18 | `GET /v0/logs` request log | *(optional, defer)* | API request log per org (method/path/status/key/latency). Needs Queue→D1 or Analytics Engine pipeline. Recommend deferring until someone asks for it — see §8. |

### P3 — open/click tracking (goal.md already plans it for V1.1, per-inbox flag)

| # | Change | Notes |
|---|---|---|
| 19 | Inbox flags: `UpdateInboxInput` += `x_open_tracking?: bool`, `x_click_tracking?: bool`; `Inbox` += same | Per goal.md "V1.1 flag per inbox" — inbox-scoped, not Resend's domain-scoped. `x_` fields per §2 additive rule. |
| 20 | Egress injection | On send with html: append 1px `<img src="https://t.wzrd.tech/o/{msg_id}/{tok}">` (open); rewrite `href` → `https://t.wzrd.tech/c/{msg_id}/{sig}?u={enc}` (click, HMAC-signed URL — no link table needed; store link rows only if we want a clicked-links API later). |
| 21 | Tracking endpoints on the API worker | `GET /o/...` → 1×1 gif, records event (dedupe window e.g. 15 min per msg+UA); `GET /c/...` → verify sig → record → 302. |
| 22 | `EventType` += `message.opened`, `message.clicked`; `Message` += `x_open_count`, `x_last_opened_at`, `x_click_count` | Click `data` carries the URL. |
| 23 | Console: tracking toggles in inbox settings; open/click badges + timeline rows on outbound messages | |

### Decide — Resend features that conflict with goal.md §3 non-goals

| Feature | goal.md status | Recommendation |
|---|---|---|
| Templates (CRUD + publish + `template:{id,variables}` on send) | "templates-as-product → never, most likely" | **Decide.** A narrow, non-marketing version (org-owned reusable bodies for transactional sends, no campaigns) may still be worth it — agents send structured mail often. If yes: spec `templates` resource + `template` field on SendMessageInput (mutually exclusive w/ html/text, Resend-style). |
| Broadcasts / contacts / audiences / segments / topics / contact-properties | marketing-blast → never | Skip permanently. Note `topic_id`/opt-in send semantics only make sense with contacts; skip. |
| Custom `events` API + `automations` (workflow sequences) | not in model | Skip — out of product scope. |
| `oauth/grants` | n/a | Skip. |
| Domain claim flow (`/domains/claim`) | multi-tenant nicety | Defer — only matters when two orgs fight over one zone; rare. |
| Multi-region sending | Cloudflare single-region | Skip. |
| SMTP/IMAP bridge, >5 MiB attachments, semantic search | already non-goals w/ stated paths | Unchanged (V2 bridge, SES adapter, V1.1 Vectorize). |

## 4. API deltas (normative)

New routes under `services/api/src/routes/`:

```
messages.ts
  POST /inboxes/:inbox_id/messages/batch-send
  POST /inboxes/:inbox_id/messages/:msg_id/cancel
  GET  /inboxes/:inbox_id/messages/:msg_id/attachments
  GET  /inboxes/:inbox_id/messages/:msg_id/events
  POST /inboxes/:inbox_id/messages/:msg_id/share
  PATCH (extend) messages/:msg_id → send_at
suppressions.ts (new)
  GET    /suppressions
  POST   /suppressions
  DELETE /suppressions/:address
  POST   /suppressions/batch
keys.ts
  PATCH /api-keys/:key_id
domains.ts
  PATCH /domains/:domain_id
webhooks.ts
  POST /webhooks/:webhook_id/rotate-secret
  GET  /webhooks/:webhook_id/events
  GET  /webhooks/:webhook_id/events/:event_id
tracking.ts (new, P3)
  GET /o/:msg_id/:tok      (pixel, no auth)
  GET /c/:msg_id/:sig     (redirect, no auth)
share.ts (new)
  GET /share/:share_id    (sanitized HTML snapshot, no auth)
```

Schema deltas (`packages/core/src/schemas.ts`): `MessageState` += `cancelled`; `EventType` += `message.scheduled|failed|cancelled|opened|clicked`, `domain.created|deleted|failed`, `suppression.added|removed`; `SendMessageInput`/`ReplyMessageInput`/`CreateDraftInput` widen `reply_to` to `string|string[]`, attachments += `content_id`/`path`; `SendMessageInput` unchanged otherwise; `UpdateMessageInput` += `send_at`; `UpdateInboxInput` += `x_open_tracking`/`x_click_tracking`; `Suppression`, `CreateSuppressionInput`, `BatchSuppressionInput`, `UpdateDomainInput`, `UpdateApiKeyInput`, `ShareMessageInput`, new `Suppression`/`ShareLink`/`MessageEvent` objects.

New D1 migrations (forward-only): `events` += `msg_id` column + index (suppressions needs none — `reason`/`source_msg_id`/scope index exist since 0001); `domains` += `custom_return_path`; `inboxes` += `x_open_tracking`, `x_click_tracking` (P3); `messages` += `x_open_count`, `x_click_count`, `x_last_opened_at` (P3); `shares` table (`share_id, msg_id, org_id, html_snapshot, text_snapshot, expires_at, created_at`).

Permissions: batch-send/cancel/reschedule/share require the existing `send` scope (same as `messages/send`); attachments/events list → `read`; suppressions + domain PATCH + key rename + rotate-secret → `admin`. Public `/o/*`, `/c/*`, `/share/*` are unauthenticated by design (unguessable ids, expiry, no tenant data beyond the rendered body).

## 5. SDK changes

### TypeScript (`packages/sdk-ts`) — additive

```ts
messages.batchSend(inboxId, SendMessageInput[]): Promise<BatchSendResult>
messages.cancel(inboxId, msgId): Promise<Message>
messages.reschedule(inboxId, msgId, sendAt): Promise<Message>   // PATCH send_at
messages.listAttachments(inboxId, msgId): Promise<Attachment[]>
messages.events(inboxId, msgId): Promise<MessageEvent[]>
messages.share(inboxId, msgId, opts?): Promise<ShareLink>
suppressions.list(params?): Promise<ListResponse<'suppressions', Suppression>>
suppressions.add(address): Promise<Suppression>
suppressions.remove(address): Promise<void>
suppressions.batch({add?, remove?}): Promise<SuppressionBatchResult>
apiKeys.update(keyId, {name}): Promise<ApiKey>
domains.update(domainId, {custom_return_path?}): Promise<Domain>
webhooks.rotateSecret(webhookId): Promise<{secret: string}>
webhooks.events(webhookId, params?): Promise<ListResponse<'events', EventEnvelope>>
inboxes.update(inboxId, {display_name?, x_open_tracking?, x_click_tracking?})
```
Types: `BatchSendResult`, `Suppression`, `ShareLink`, `MessageEvent` (= EventEnvelope), `cancelled` in `MessageState`, new `EventType`s.

### Python (`sdk-python`) — parity pass + new

The Python SDK is behind the TS one today (no drafts, pods, api-keys, lists, counts, usage, search, batch ops, reply/forward/update/restore). Bring it level first, then mirror the §5-TS additions with Pythonic naming (`messages.batch_send`, `suppressions.add`, etc.). Same wire contract — no new surface invented client-side.

### CLI (`apps/cli`) — mirror

`messages batch-send|cancel|reschedule|share|events|attachments`, `suppressions list|add|remove|batch`, `api-keys update`, `domains update`, `inboxes update --open-tracking --click-tracking`, `webhooks rotate-secret|events`, `threads` unchanged.

### MCP (`services/mcp`) — mirror REST like the rest

`send_batch`, `cancel_message`, `reschedule_message`, `share_message`, `list_attachments`, `message_events`, `list_suppressions`, `add_suppression`, `remove_suppression`, `update_inbox` (incl. tracking flags), `update_domain`, `rename_api_key`, `rotate_webhook_secret`, `list_webhook_events`.

## 6. Console/UI changes (`apps/console`)

| Page | Change |
|---|---|
| `InboxDetail` | Scheduled folder rows: **Cancel** + **Reschedule** (datetime input) actions. Message detail: **Events** timeline (from `/events`, shows scheduled→sent→delivered/bounced/complained/opened/clicked + suppression notes), **Attachments** strip for outbound messages, **Share** button → modal (expiry select → copy link), open/click count badges on outbound rows (P3). |
| `Domains` | Edit drawer on a domain: `custom_return_path` input; verify-results table stays. (Tracking toggles live on inbox settings, not here — different from Resend, per goal.md.) |
| `Inboxes` / inbox settings panel | Tracking toggles `x_open_tracking`/`x_click_tracking` (P3). |
| `Webhooks` | **Rotate secret** action (new secret shown once); new event types added to the subscribe checklist; event-payload viewer row-expand on deliveries (uses `/events/:id`). |
| `ApiKeys` | Inline rename (PATCH). |
| `Lists` | Tabs: existing "Receive policy" (allow/block) + new **"Suppressions"** tab (list/add/remove/batch, origin badges bounce/complaint/manual). |
| `Metrics` | Range picker + granularity + inbox/pod/type filters (matches §4 metrics params). |
| New `Templates` | Only if the templates decision lands yes. |

## 7. Explicit non-goals (do not port from Resend)

Broadcasts, contacts/audiences/segments/topics/contact-properties, automations/workflows, custom events API, oauth grants, domain claim flow, multi-region, SMTP/IMAP, marketing templates-as-product, >5 MiB attachments, semantic search. Reasons: goal.md §3 non-goals, inbox-centric model, abuse surface, or already-planned-later with stated paths.

## 8. Suggested PR sequencing

| PR | Scope | Depends on |
|---|---|---|
| R-MAIL-01 | P0 send lifecycle: batch-send, cancel, reschedule, reply_to[], attachment path/content_id, attachments list, new event types | — |
| R-MAIL-02 | Suppressions API + events + console tab | — |
| R-MAIL-03 | Observability: message events endpoint+timeline, rotate-secret, webhook events view, share link, metrics params, api-keys PATCH, domain PATCH | events migration from -01 |
| R-MAIL-04 | Open/click tracking (inbox flags → egress injection → t endpoints → events + console) | R-MAIL-03 timeline |
| R-MAIL-05 | Python SDK parity + mirror of new surface | parallel w/ 01–04 |
| R-MAIL-06 | Templates (if approved) | decision |
| (defer) | `/v0/logs` request log | demand-driven |

## 9. Open questions for you

1. **Templates** — goal.md marks them "never, most likely". Add a narrow transactional-template resource anyway, or leave out entirely?
2. **`cancelled` state** — new `MessageState` value (my recommendation; matches Resend semantics and keeps cancelled items visible) vs. continuing to use trash-as-cancel. OK to widen the enum?
3. **Tracking scope** — per-inbox flags (goal.md's stated V1.1 path) confirmed, rather than Resend's per-domain?
4. **Batch cap** — 100 (Resend parity) or 50 (= current recipients cap)?
5. **`GET /v0/logs`** — build the request-log pipeline or defer?
6. **Batch idempotency** — one header key for the whole batch (Resend model) sufficient, or also require per-item `client_id`?
