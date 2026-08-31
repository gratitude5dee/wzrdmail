from __future__ import annotations

from pydantic import BaseModel, ConfigDict


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
