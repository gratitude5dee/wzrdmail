# wzrdmail (Python SDK)

Email for AI agents — Python client for `api.wzrd.tech` (goal.md §11). Sync-first, httpx + pydantic v2, AgentMail-shape-compatible.

```python
from wzrdmail import WzrdMail

client = WzrdMail(api_key="wm_live_...")  # or WZRDMAIL_API_KEY env var

inbox = client.inboxes.create(client_id="my-agent")
client.inboxes.messages.send(
    inbox.inbox_id,
    to=["human@gmail.com"],
    subject="Hello from an agent",
    text="It works.",
)
threads = client.inboxes.threads.list(inbox.inbox_id)
```

Surface: `inboxes` (+ `.messages`, `.threads`, `.drafts`, `.lists`, `.counts`), `webhooks`, `agent`, `domains`, `pods`, `api_keys`, `lists`, `suppressions`, `templates`, `auth`, `metrics`, `usage`. Message send/reply/forward/draft inputs take `reply_to` as `str | list[str]`, `send_at`, attachments as inline `content` or hosted `path` (+ `content_id` for `cid:` images), and `template={"id": ..., "variables": {...}}` on `send`.

Errors raise `WzrdmailError` with `.status`, `.name`, `.message` (the §7 envelope). 429s retry up to 3 times honoring `Retry-After` (delay-seconds or HTTP-date) with exponential fallback.

## Development

```sh
uv sync
uv run pytest
uv run ruff check .
uv run mypy
```
