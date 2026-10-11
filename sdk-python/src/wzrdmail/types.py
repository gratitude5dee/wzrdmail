from __future__ import annotations

from typing import Any, TypedDict

from pydantic import BaseModel, ConfigDict


class _SendAttachmentBase(TypedDict):
    filename: str
    content_type: str


class SendAttachment(_SendAttachmentBase, total=False):
    """Outbound attachment (core SendAttachmentInput).

    Exactly one of `content` (base64) or `path` (https URL fetched
    server-side) is required; `content_id` marks an inline `cid:` part.
    """

    content: str
    path: str
    content_id: str


# `str` renders one Reply-To address; a list renders them all (resend-parity §3.4).
ReplyTo = str | list[str]


class TemplateVariable(TypedDict, total=False):
    """Template variable declaration (Resend-parity §5)."""

    key: str
    type: str  # string | number | boolean | object | list
    fallback_value: Any


class _TemplateRefBase(TypedDict):
    id: str


class TemplateRef(_TemplateRefBase, total=False):
    """`template` field on SendMessageInput: `{id, variables?}`."""

    variables: dict[str, Any]


class SendMessage(TypedDict, total=False):
    """One item of a `messages.batch_send` body (SendMessageInput)."""

    to: list[str]
    cc: list[str]
    bcc: list[str]
    subject: str
    text: str
    html: str
    reply_to: ReplyTo
    headers: dict[str, str]
    attachments: list[SendAttachment]
    labels: list[str]
    client_id: str
    send_at: str
    template: TemplateRef


class _Model(BaseModel):
    model_config = ConfigDict(extra="allow")


class Inbox(_Model):
    inbox_id: str
    organization_id: str | None = None
    pod_id: str | None = None
    username: str | None = None
    display_name: str | None = None
    client_id: str | None = None
    created_at: str | None = None
    updated_at: str | None = None


class Attachment(_Model):
    attachment_id: str
    filename: str | None = None
    content_type: str | None = None
    size: int | None = None
    inline: bool | None = None


class Message(_Model):
    message_id: str
    inbox_id: str
    thread_id: str | None = None
    direction: str | None = None
    state: str | None = None
    from_: str | None = None
    to: list[str] = []
    cc: list[str] = []
    bcc: list[str] = []
    subject: str = ""
    text: str | None = None
    html: str | None = None
    extracted_text: str | None = None
    labels: list[str] = []
    attachments: list[Attachment] = []
    in_reply_to: str | None = None
    send_at: str | None = None
    deleted_at: str | None = None
    created_at: str | None = None
    updated_at: str | None = None

    model_config = ConfigDict(extra="allow", populate_by_name=True)

    def __init__(self, **data: object) -> None:
        if "from" in data and "from_" not in data:
            data["from_"] = data.pop("from")
        super().__init__(**data)


class Thread(_Model):
    thread_id: str
    inbox_id: str | None = None
    subject: str | None = None
    message_count: int | None = None
    last_message_at: str | None = None
    labels: list[str] = []
    created_at: str | None = None
    updated_at: str | None = None


class Webhook(_Model):
    webhook_id: str
    url: str
    event_types: list[str] = []
    enabled: bool | None = None
    inbox_id: str | None = None
    pod_id: str | None = None
    secret: str | None = None
    created_at: str | None = None
    updated_at: str | None = None


class DnsRecord(_Model):
    type: str
    name: str
    value: str


class Domain(_Model):
    domain_id: str
    domain: str
    organization_id: str | None = None
    status: str | None = None
    nameservers: list[str] = []
    dns_records: list[DnsRecord] = []
    created_at: str | None = None
    updated_at: str | None = None


class AgentSignUpResponse(_Model):
    api_key: str
    inbox_id: str
    organization_id: str


class AgentVerifyResponse(_Model):
    verified: bool


class InboxList(_Model):
    inboxes: list[Inbox] = []
    next_page_token: str | None = None


class MessageList(_Model):
    messages: list[Message] = []
    next_page_token: str | None = None


class ThreadList(_Model):
    threads: list[Thread] = []
    next_page_token: str | None = None


class WebhookList(_Model):
    webhooks: list[Webhook] = []
    next_page_token: str | None = None


class DomainList(_Model):
    domains: list[Domain] = []
    next_page_token: str | None = None


class Draft(_Model):
    draft_id: str
    inbox_id: str | None = None
    to: list[str] = []
    cc: list[str] = []
    bcc: list[str] = []
    subject: str = ""
    text: str | None = None
    html: str | None = None
    reply_to: ReplyTo | None = None
    headers: dict[str, str] = {}
    labels: list[str] = []
    in_reply_to: str | None = None
    client_id: str | None = None
    sent_message_id: str | None = None
    created_at: str | None = None
    updated_at: str | None = None


class DraftList(_Model):
    drafts: list[Draft] = []
    next_page_token: str | None = None


class Pod(_Model):
    pod_id: str
    name: str | None = None
    organization_id: str | None = None
    client_id: str | None = None
    created_at: str | None = None


class PodList(_Model):
    pods: list[Pod] = []
    next_page_token: str | None = None


class ApiKey(_Model):
    """API key record; `key` (the secret) is only present on create."""

    api_key_id: str | None = None
    name: str | None = None
    key: str | None = None
    pod_id: str | None = None
    inbox_id: str | None = None
    permissions: list[str] = []
    last_used_at: str | None = None
    created_at: str | None = None


class ApiKeyList(_Model):
    api_keys: list[ApiKey] = []
    next_page_token: str | None = None


class ListEntry(_Model):
    """Allow/block list entry (`kind` ∈ {"allow", "block"})."""

    entry_id: str
    organization_id: str | None = None
    inbox_id: str | None = None
    kind: str | None = None
    pattern: str | None = None
    created_at: str | None = None


class ListEntryList(_Model):
    list_entries: list[ListEntry] = []
    next_page_token: str | None = None


class Counts(_Model):
    """Folder badge counts for an inbox (`GET /inboxes/:id/counts`)."""

    unread: int = 0
    spam: int = 0
    drafts: int = 0
    trash: int = 0


class UsageMetric(_Model):
    metric: str
    used: int = 0
    limit: int | None = None


class Usage(_Model):
    """`GET /v0/metrics/usage` — month + flat metric list vs plan limits."""

    month: str | None = None
    metrics: list[UsageMetric] = []


class UsageCounter(_Model):
    used: int = 0
    limit: int | None = None


class PlanUsage(_Model):
    """`GET /v0/usage` — plan counters for the current month."""

    plan: str | None = None
    month: str | None = None
    usage: dict[str, UsageCounter] = {}


class MetricsPoint(_Model):
    bucket: str
    type: str
    count: int = 0


class Metrics(_Model):
    """`GET /v0/metrics` — event-count aggregates bucketed for charts."""

    period: str | None = None
    since: str | None = None
    totals: dict[str, int] = {}
    series: list[MetricsPoint] = []


class AuthMe(_Model):
    """`GET /v0/auth/me` — the identity behind the presented key."""

    organization_id: str | None = None
    pod_id: str | None = None
    api_key_id: str | None = None
    human_email: str | None = None
    verified: bool | None = None


class WebhookTestResult(_Model):
    webhook_id: str | None = None
    delivered: bool | None = None
    status_code: int | None = None
    error: str | None = None


class WebhookSecret(_Model):
    """`POST /v0/webhooks/:id/rotate-secret` — plaintext shown once."""

    secret: str


class BatchSendItem(_Model):
    """Per-item outcome: message fields on success, `error` on failure."""

    index: int
    message_id: str | None = None
    error: dict[str, Any] | None = None


class BatchSendResult(_Model):
    results: list[BatchSendItem] = []


class BatchUpdateResult(_Model):
    updated: list[str] = []


class AttachmentList(_Model):
    attachments: list[Attachment] = []


class Suppression(_Model):
    address: str
    reason: str | None = None  # bounce | complaint | manual
    source_msg_id: str | None = None
    created_at: str | None = None


class SuppressionList(_Model):
    suppressions: list[Suppression] = []
    next_page_token: str | None = None


class SuppressionBatchResult(_Model):
    added: list[Any] = []
    removed: list[Any] = []


class ShareLink(_Model):
    """`POST .../messages/:id/share` — public, expiring rendered snapshot."""

    share_url: str
    share_id: str | None = None
    expires_at: str | None = None


class EventEnvelope(_Model):
    event_id: str | None = None
    type: str | None = None
    created_at: str | None = None
    organization_id: str | None = None
    pod_id: str | None = None
    inbox_id: str | None = None
    data: dict[str, Any] = {}


class EventList(_Model):
    events: list[EventEnvelope] = []
    next_page_token: str | None = None


class Template(_Model):
    """Reusable org-owned message body (Resend-parity §5)."""

    template_id: str | None = None
    id: str | None = None
    name: str | None = None
    alias: str | None = None
    status: str | None = None  # draft | published
    subject: str | None = None
    from_: str | None = None
    text: str | None = None
    html: str | None = None
    variables: list[Any] = []
    published_at: str | None = None
    created_at: str | None = None
    updated_at: str | None = None

    model_config = ConfigDict(extra="allow", populate_by_name=True)

    def __init__(self, **data: object) -> None:
        if "from" in data and "from_" not in data:
            data["from_"] = data.pop("from")
        super().__init__(**data)


class TemplateList(_Model):
    templates: list[Template] = []
    next_page_token: str | None = None
