# TypeScript SDK (`wzrdmail`, `packages/sdk-ts`)

```typescript
import { WzrdMailClient, WzrdmailError } from "wzrdmail";

const client = new WzrdMailClient({
  apiKey: process.env.WZRDMAIL_API_KEY,   // default: WZRDMAIL_API_KEY
  baseUrl: "https://api.wzrd.tech"        // default; override for staging
});
```

All request and response fields are snake_case, matching the wire format. Every resource method returns the parsed JSON body; collections come back as `{ <plural>: T[], next_page_token?: string }`.

## Inboxes

```typescript
await client.inboxes.create({ username: "support", domain: "wzrd.tech", display_name: "Support", client_id: "support-v1" });
const { inboxes, next_page_token } = await client.inboxes.list({ limit: 50 });
const inbox = await client.inboxes.get("support@wzrd.tech");
await client.inboxes.delete("support@wzrd.tech");   // destructive — confirm first
```

## Messages

```typescript
const m = client.inboxes.messages;
await m.send(inboxId, { to: ["a@example.com"], subject: "Hi", text: "…", html: "…", cc: [], bcc: [], reply_to: "…", headers: {}, labels: [], attachments: [{ filename: "a.pdf", content_type: "application/pdf", content: base64 }], client_id: "…", send_at: "2026-01-01T00:00:00Z" });
const { messages } = await m.list(inboxId, { limit: 20, page_token, labels: ["unread"], before, after });
const full = await m.get(inboxId, messageId);   // text, html, extracted_text, attachments[]
await m.reply(inboxId, messageId, { text: "…" });
await m.replyAll(inboxId, messageId, { text: "…" });
await m.forward(inboxId, messageId, { to: ["b@example.com"], text: "FYI" });
await m.update(inboxId, messageId, { add_labels: ["processed"], remove_labels: ["unread"], read: true });
```

## Threads

```typescript
const t = client.inboxes.threads;
const { threads } = await t.list(inboxId, { limit: 20 });
const thread = await t.get(inboxId, threadId);               // thread.messages[]
const hits = await t.search(inboxId, { query: "invoice", limit: 10 });
```

## Drafts

```typescript
const d = client.inboxes.drafts;
const draft = await d.create(inboxId, { to: ["a@example.com"], subject: "Pending approval", text: "…", in_reply_to: messageId });
await d.update(inboxId, draft.draft_id, { text: "revised" });
const { drafts } = await d.list(inboxId);
await d.get(inboxId, draft.draft_id);
await d.send(inboxId, draft.draft_id);     // requires `send` permission → Message
await d.delete(inboxId, draft.draft_id);
```

## Webhooks, domains, pods, API keys, auth, usage

```typescript
const hook = await client.webhooks.create({ url, event_types: ["message.received"], inbox_id, pod_ids: ["pod_…"], client_id });
// hook.secret (whsec_…) is returned once
await client.webhooks.list(); await client.webhooks.test(hook.webhook_id); await client.webhooks.delete(hook.webhook_id);

await client.domains.create({ domain: "example.com" }); await client.domains.verify(domainId); await client.domains.list();
await client.pods.create({ name: "prod" }); await client.pods.list();
await client.apiKeys.create({ name: "box", inbox_id: inboxId, permissions: ["read", "drafts"] });
await client.apiKeys.list(); await client.apiKeys.delete(keyId);
await client.auth.me();                         // organization_id, pod_id, api_key_id, human_email, verified
await client.metrics.usage({ month: "2026-09" });
```

## Errors and retries

```typescript
try {
  await client.inboxes.messages.send(inboxId, input);
} catch (err) {
  if (err instanceof WzrdmailError) {
    err.status;   // HTTP status
    err.name;     // "forbidden" | "not_found" | "plan_limit" | "message_too_large" | …
    err.message;  // human-readable, safe to surface
  }
}
```

`429` responses are retried with `Retry-After`; `5xx` on idempotent requests are retried with backoff. Pass `client_id` so a retried create cannot duplicate.
