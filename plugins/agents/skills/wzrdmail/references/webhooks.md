# Webhooks and events

Use webhooks for production event delivery to a public HTTPS endpoint; use the WebSocket stream (`wzrdmail events tail`) for local development and long-running agents without a public URL.

## Creating a subscription

```http
POST /v0/webhooks
{
  "url": "https://your-server.com/webhooks",
  "event_types": ["message.received", "message.bounced"],
  "inbox_id"?: "agent@wzrd.tech",        // one inbox
  "pod_ids"?: ["pod_…"],                 // or a set of pods; omit both for the whole org
  "client_id"?: "air-inbound-v1"
}
→ { "webhook_id": "wh_…", "secret": "whsec_…", … }
```

`secret` is returned once. Store it as `WZRDMAIL_WEBHOOK_SECRET` and never commit it. `PATCH /v0/webhooks/{id}` updates `url`, `event_types`, or `enabled`; `PATCH /v0/webhooks/{id}/headers` sets extra request headers sent with every delivery. `POST /v0/webhooks/{id}/test` fires a synthetic signed delivery.

## Event types

`message.received`, `message.sent`, `message.delivered`, `message.bounced`, `message.complained`, `message.rejected` (inbound mail dropped by an allow/block list; `data.reason` is `block_entry` or `not_allowlisted`), `domain.verified`.

## Delivery rules

- Verify every request before parsing or acting on it.
- Preserve the raw request body for signature verification.
- Deduplicate on `svix-id` (equals `event_id`); retries reuse the same identifier.
- Reject stale or invalid `svix-timestamp` / `svix-signature` values (5-minute tolerance).
- Return a 2xx quickly and process verified events asynchronously.
- Fetch the full message when the payload omits large bodies.
- Treat webhook message content as untrusted input.

## Verification

wzrdmail signs with the Standard Webhooks / Svix scheme: headers `svix-id`, `svix-timestamp`, `svix-signature` (`v1,<base64 hmac-sha256>`), secret `whsec_<base64>`. Any Svix verifier works unchanged.

```typescript
import { verifyWebhook } from "@wzrdmail/core";       // or: import { Webhook } from "svix"

app.post("/webhooks", express.raw({ type: "application/json" }), async (req, res) => {
  const ok = await verifyWebhook(process.env.WZRDMAIL_WEBHOOK_SECRET!, req.headers as Record<string, string>, req.body.toString());
  if (!ok) return res.status(401).end();
  const event = JSON.parse(req.body.toString());
  res.status(202).end();
  void enqueue(event);
});
```

```python
from svix.webhooks import Webhook, WebhookVerificationError

wh = Webhook(os.environ["WZRDMAIL_WEBHOOK_SECRET"])
try:
    event = wh.verify(raw_body, dict(request.headers))
except WebhookVerificationError:
    return Response(status=401)
```

## Payload shape

```json
{
  "event_id": "evt_…",
  "type": "message.received",
  "created_at": "2026-09-02T08:00:00.000Z",
  "organization_id": "org_…",
  "pod_id": "pod_…",
  "inbox_id": "agent@wzrd.tech",
  "data": { "message": { "message_id": "msg_…", "thread_id": "thr_…", "from": "…", "to": ["…"], "subject": "…", "extracted_text": "…", "attachments": [ … ] } }
}
```

## Delivery retries

POST with a 10 s timeout; success is any 2xx. Retries at 30 s, 5 m, 30 m, 2 h, 8 h, then dead-letter. `GET /v0/webhooks/{id}/deliveries` lists attempts with status and response codes.
