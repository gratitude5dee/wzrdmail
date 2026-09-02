# Python SDK (`wzrdmail`, `sdk-python`)

```python
from wzrdmail import WzrdMail

client = WzrdMail()                                  # WZRDMAIL_API_KEY, WZRDMAIL_BASE_URL
client = WzrdMail(api_key="wm_live_...", base_url="https://api.wzrd.tech")

with WzrdMail() as client:                           # closes the httpx client
    ...
```

Path parameters are positional; everything else is a keyword argument. Responses are typed dataclasses with the wire field names.

## Inboxes

```python
inbox = client.inboxes.create(username="support", domain="wzrd.tech", display_name="Support", client_id="support-v1")
page = client.inboxes.list(limit=50, page_token=None)      # page.inboxes, page.next_page_token
inbox = client.inboxes.get("support@wzrd.tech")
```

## Messages

```python
m = client.inboxes.messages
m.send(inbox_id, to=["a@example.com"], subject="Hi", text="…", html=None, cc=None, bcc=None,
       reply_to=None, headers=None, attachments=None, labels=None, client_id=None)
page = m.list(inbox_id, limit=20, page_token=None, labels=["unread"])   # page.messages
msg = m.get(inbox_id, message_id)                    # msg.text, msg.html, msg.extracted_text, msg.attachments
```

Replies, forwards, drafts, and label updates are not yet wrapped in the Python SDK; call the REST endpoints directly with the same base URL and `Authorization: Bearer wm_…` header, or use the TypeScript SDK / CLI:

```python
import httpx, os
r = httpx.post(
    f"https://api.wzrd.tech/v0/inboxes/{inbox_id}/drafts",
    headers={"Authorization": f"Bearer {os.environ['WZRDMAIL_API_KEY']}"},
    json={"to": ["a@example.com"], "subject": "Pending approval", "text": "…"},
)
r.raise_for_status(); draft_id = r.json()["draft_id"]
```

## Threads

```python
page = client.inboxes.threads.list(inbox_id, limit=20)   # page.threads
thread = client.inboxes.threads.get(inbox_id, thread_id) # thread.messages
```

## Webhooks, domains, agent

```python
hook = client.webhooks.create(url="https://example.com/webhooks", event_types=["message.received"], inbox_id=None, client_id=None)
# hook.secret (whsec_…) is returned once
client.webhooks.list(); client.webhooks.delete(hook.webhook_id)

client.domains.create(domain="example.com"); client.domains.verify(domain_id); client.domains.list()

signup = WzrdMail().agent.sign_up(human_email="you@example.com", username="my-agent")
WzrdMail(api_key=signup.api_key).agent.verify(otp_code="123456")
```

## Errors

```python
from wzrdmail.errors import WzrdmailError

try:
    client.inboxes.messages.send(inbox_id, to=[...], text="…")
except WzrdmailError as e:
    e.status, e.name, e.message      # e.g. 403, "forbidden", "key lacks send permission"
```

`429` responses are retried honoring `Retry-After`.
