from __future__ import annotations

import os
from types import TracebackType
from typing import Any

import httpx

from ._http import DEFAULT_BASE_URL, HttpClient, encode_path
from .types import (
    AgentSignUpResponse,
    AgentVerifyResponse,
    ApiKey,
    ApiKeyList,
    AttachmentList,
    AuthMe,
    BatchSendResult,
    BatchUpdateResult,
    Counts,
    Domain,
    DomainList,
    Draft,
    DraftList,
    EventEnvelope,
    EventList,
    Inbox,
    InboxList,
    ListEntry,
    ListEntryList,
    Message,
    MessageList,
    Metrics,
    PlanUsage,
    Pod,
    PodList,
    ReplyTo,
    SendAttachment,
    SendMessage,
    ShareLink,
    Suppression,
    SuppressionBatchResult,
    SuppressionList,
    Template,
    TemplateList,
    TemplateRef,
    TemplateVariable,
    Thread,
    ThreadList,
    Usage,
    Webhook,
    WebhookList,
    WebhookSecret,
    WebhookTestResult,
)

__all__ = ["WzrdMail", "DEFAULT_BASE_URL"]


def _clean(body: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in body.items() if v is not None}


def _idem_header(idempotency_key: str | None) -> dict[str, str] | None:
    """`Idempotency-Key` header for send/batch-send (resend-parity §3.1)."""
    return {"Idempotency-Key": idempotency_key} if idempotency_key else None


class _Messages:
    def __init__(self, http: HttpClient) -> None:
        self._http = http

    def send(
        self,
        inbox_id: str,
        *,
        to: list[str],
        subject: str = "",
        text: str | None = None,
        html: str | None = None,
        cc: list[str] | None = None,
        bcc: list[str] | None = None,
        reply_to: ReplyTo | None = None,
        headers: dict[str, str] | None = None,
        attachments: list[SendAttachment] | None = None,
        labels: list[str] | None = None,
        client_id: str | None = None,
        send_at: str | None = None,
        template: TemplateRef | dict[str, Any] | None = None,
        idempotency_key: str | None = None,
    ) -> Message:
        data = self._http.request(
            "POST",
            f"/v0/inboxes/{encode_path(inbox_id)}/messages/send",
            body=_clean(
                {
                    "to": to,
                    "subject": subject,
                    "text": text,
                    "html": html,
                    "cc": cc,
                    "bcc": bcc,
                    "reply_to": reply_to,
                    "headers": headers,
                    "attachments": (
                        [dict(a) for a in attachments] if attachments is not None else None
                    ),
                    "labels": labels,
                    "client_id": client_id,
                    "send_at": send_at,
                    "template": dict(template) if template is not None else None,
                }
            ),
            headers=_idem_header(idempotency_key),
        )
        return Message(**data)

    def batch_send(
        self,
        inbox_id: str,
        *,
        messages: list[SendMessage | dict[str, Any]],
        idempotency_key: str | None = None,
    ) -> BatchSendResult:
        """`POST /inboxes/:id/messages/batch-send` — max 100 items, per-item results."""
        data = self._http.request(
            "POST",
            f"/v0/inboxes/{encode_path(inbox_id)}/messages/batch-send",
            body={"messages": [dict(m) for m in messages]},
            headers=_idem_header(idempotency_key),
        )
        return BatchSendResult(**data)

    def search(
        self,
        inbox_id: str,
        *,
        query: str,
        limit: int | None = None,
        page_token: str | None = None,
    ) -> MessageList:
        data = self._http.request(
            "GET",
            f"/v0/inboxes/{encode_path(inbox_id)}/messages/search",
            query={"query": query, "limit": limit, "page_token": page_token},
        )
        return MessageList(**data)

    def batch_get(self, inbox_id: str, *, message_ids: list[str]) -> MessageList:
        data = self._http.request(
            "POST",
            f"/v0/inboxes/{encode_path(inbox_id)}/messages/batch-get",
            body={"message_ids": message_ids},
        )
        return MessageList(**data)

    def batch_update(
        self,
        inbox_id: str,
        *,
        message_ids: list[str],
        add_labels: list[str] | None = None,
        remove_labels: list[str] | None = None,
        read: bool | None = None,
    ) -> BatchUpdateResult:
        data = self._http.request(
            "PATCH",
            f"/v0/inboxes/{encode_path(inbox_id)}/messages/batch-update",
            body=_clean(
                {
                    "message_ids": message_ids,
                    "add_labels": add_labels,
                    "remove_labels": remove_labels,
                    "read": read,
                }
            ),
        )
        return BatchUpdateResult(**data)

    def get(self, inbox_id: str, message_id: str) -> Message:
        data = self._http.request(
            "GET",
            f"/v0/inboxes/{encode_path(inbox_id)}/messages/{encode_path(message_id)}",
        )
        return Message(**data)

    def _reply_input(
        self,
        *,
        to: list[str] | None,
        cc: list[str] | None,
        bcc: list[str] | None,
        text: str | None,
        html: str | None,
        reply_to: ReplyTo | None,
        headers: dict[str, str] | None,
        attachments: list[SendAttachment] | None,
        labels: list[str] | None,
        client_id: str | None,
        send_at: str | None,
    ) -> dict[str, Any]:
        return _clean(
            {
                "to": to,
                "cc": cc,
                "bcc": bcc,
                "text": text,
                "html": html,
                "reply_to": reply_to,
                "headers": headers,
                "attachments": (
                    [dict(a) for a in attachments] if attachments is not None else None
                ),
                "labels": labels,
                "client_id": client_id,
                "send_at": send_at,
            }
        )

    def reply(
        self,
        inbox_id: str,
        message_id: str,
        *,
        to: list[str] | None = None,
        cc: list[str] | None = None,
        bcc: list[str] | None = None,
        text: str | None = None,
        html: str | None = None,
        reply_to: ReplyTo | None = None,
        headers: dict[str, str] | None = None,
        attachments: list[SendAttachment] | None = None,
        labels: list[str] | None = None,
        client_id: str | None = None,
        send_at: str | None = None,
    ) -> Message:
        data = self._http.request(
            "POST",
            f"/v0/inboxes/{encode_path(inbox_id)}/messages/{encode_path(message_id)}/reply",
            body=self._reply_input(
                to=to,
                cc=cc,
                bcc=bcc,
                text=text,
                html=html,
                reply_to=reply_to,
                headers=headers,
                attachments=attachments,
                labels=labels,
                client_id=client_id,
                send_at=send_at,
            ),
        )
        return Message(**data)

    def reply_all(
        self,
        inbox_id: str,
        message_id: str,
        *,
        to: list[str] | None = None,
        cc: list[str] | None = None,
        bcc: list[str] | None = None,
        text: str | None = None,
        html: str | None = None,
        reply_to: ReplyTo | None = None,
        headers: dict[str, str] | None = None,
        attachments: list[SendAttachment] | None = None,
        labels: list[str] | None = None,
        client_id: str | None = None,
        send_at: str | None = None,
    ) -> Message:
        data = self._http.request(
            "POST",
            f"/v0/inboxes/{encode_path(inbox_id)}/messages/{encode_path(message_id)}/reply-all",
            body=self._reply_input(
                to=to,
                cc=cc,
                bcc=bcc,
                text=text,
                html=html,
                reply_to=reply_to,
                headers=headers,
                attachments=attachments,
                labels=labels,
                client_id=client_id,
                send_at=send_at,
            ),
        )
        return Message(**data)

    def forward(
        self,
        inbox_id: str,
        message_id: str,
        *,
        to: list[str],
        cc: list[str] | None = None,
        bcc: list[str] | None = None,
        text: str | None = None,
        html: str | None = None,
        reply_to: ReplyTo | None = None,
        headers: dict[str, str] | None = None,
        attachments: list[SendAttachment] | None = None,
        labels: list[str] | None = None,
        client_id: str | None = None,
        send_at: str | None = None,
    ) -> Message:
        data = self._http.request(
            "POST",
            f"/v0/inboxes/{encode_path(inbox_id)}/messages/{encode_path(message_id)}/forward",
            body=self._reply_input(
                to=to,
                cc=cc,
                bcc=bcc,
                text=text,
                html=html,
                reply_to=reply_to,
                headers=headers,
                attachments=attachments,
                labels=labels,
                client_id=client_id,
                send_at=send_at,
            ),
        )
        return Message(**data)

    def update(
        self,
        inbox_id: str,
        message_id: str,
        *,
        labels: list[str] | None = None,
        add_labels: list[str] | None = None,
        remove_labels: list[str] | None = None,
        read: bool | None = None,
        send_at: str | None = None,
    ) -> Message:
        """PATCH a message; `send_at` reschedules `scheduled`/`cancelled` sends."""
        data = self._http.request(
            "PATCH",
            f"/v0/inboxes/{encode_path(inbox_id)}/messages/{encode_path(message_id)}",
            body=_clean(
                {
                    "labels": labels,
                    "add_labels": add_labels,
                    "remove_labels": remove_labels,
                    "read": read,
                    "send_at": send_at,
                }
            ),
        )
        return Message(**data)

    def reschedule(self, inbox_id: str, message_id: str, *, send_at: str) -> Message:
        """Reschedule a `scheduled` (or re-arm a `cancelled`) send."""
        return self.update(inbox_id, message_id, send_at=send_at)

    def delete(self, inbox_id: str, message_id: str) -> None:
        """Move a message to trash (trashing a scheduled message cancels it)."""
        self._http.request(
            "DELETE",
            f"/v0/inboxes/{encode_path(inbox_id)}/messages/{encode_path(message_id)}",
        )

    def restore(self, inbox_id: str, message_id: str) -> Message:
        data = self._http.request(
            "POST",
            f"/v0/inboxes/{encode_path(inbox_id)}/messages/{encode_path(message_id)}/restore",
        )
        return Message(**data)

    def cancel(self, inbox_id: str, message_id: str) -> Message:
        """Cancel a scheduled send without trashing it (resend-parity §3.2)."""
        data = self._http.request(
            "POST",
            f"/v0/inboxes/{encode_path(inbox_id)}/messages/{encode_path(message_id)}/cancel",
        )
        return Message(**data)

    def list_attachments(self, inbox_id: str, message_id: str) -> AttachmentList:
        data = self._http.request(
            "GET",
            f"/v0/inboxes/{encode_path(inbox_id)}/messages/{encode_path(message_id)}/attachments",
        )
        return AttachmentList(**data)

    def download_attachment(
        self,
        inbox_id: str,
        message_id: str,
        attachment_id: str,
        *,
        disposition: str | None = None,
    ) -> bytes:
        """Raw attachment bytes; `disposition="inline"` only for raster images."""
        return self._http.request_bytes(
            "GET",
            f"/v0/inboxes/{encode_path(inbox_id)}/messages/{encode_path(message_id)}"
            f"/attachments/{encode_path(attachment_id)}",
            query={"disposition": disposition},
        )

    def events(
        self,
        inbox_id: str,
        message_id: str,
        *,
        limit: int | None = None,
        page_token: str | None = None,
    ) -> EventList:
        """Per-message event timeline (resend-parity §3.13)."""
        data = self._http.request(
            "GET",
            f"/v0/inboxes/{encode_path(inbox_id)}/messages/{encode_path(message_id)}/events",
            query={"limit": limit, "page_token": page_token},
        )
        return EventList(**data)

    def share(
        self, inbox_id: str, message_id: str, *, expires_in: int | None = None
    ) -> ShareLink:
        """Mint a public, expiring share link for a rendered message snapshot."""
        data = self._http.request(
            "POST",
            f"/v0/inboxes/{encode_path(inbox_id)}/messages/{encode_path(message_id)}/share",
            body=_clean({"expires_in": expires_in}),
        )
        return ShareLink(**data)

    def list(
        self,
        inbox_id: str,
        *,
        limit: int | None = None,
        page_token: str | None = None,
        labels: list[str] | None = None,
        before: str | None = None,
        after: str | None = None,
        folder: str | None = None,
    ) -> MessageList:
        data = self._http.request(
            "GET",
            f"/v0/inboxes/{encode_path(inbox_id)}/messages",
            query={
                "limit": limit,
                "page_token": page_token,
                "labels": ",".join(labels) if labels is not None else None,
                "before": before,
                "after": after,
                "folder": folder,
            },
        )
        return MessageList(**data)


class _Drafts:
    def __init__(self, http: HttpClient) -> None:
        self._http = http

    def create(
        self,
        inbox_id: str,
        *,
        to: list[str] | None = None,
        cc: list[str] | None = None,
        bcc: list[str] | None = None,
        subject: str | None = None,
        text: str | None = None,
        html: str | None = None,
        reply_to: ReplyTo | None = None,
        headers: dict[str, str] | None = None,
        labels: list[str] | None = None,
        in_reply_to: str | None = None,
        client_id: str | None = None,
    ) -> Draft:
        data = self._http.request(
            "POST",
            f"/v0/inboxes/{encode_path(inbox_id)}/drafts",
            body=_clean(
                {
                    "to": to,
                    "cc": cc,
                    "bcc": bcc,
                    "subject": subject,
                    "text": text,
                    "html": html,
                    "reply_to": reply_to,
                    "headers": headers,
                    "labels": labels,
                    "in_reply_to": in_reply_to,
                    "client_id": client_id,
                }
            ),
        )
        return Draft(**data)

    def get(self, inbox_id: str, draft_id: str) -> Draft:
        data = self._http.request(
            "GET",
            f"/v0/inboxes/{encode_path(inbox_id)}/drafts/{encode_path(draft_id)}",
        )
        return Draft(**data)

    def update(
        self,
        inbox_id: str,
        draft_id: str,
        *,
        to: list[str] | None = None,
        cc: list[str] | None = None,
        bcc: list[str] | None = None,
        subject: str | None = None,
        text: str | None = None,
        html: str | None = None,
        reply_to: ReplyTo | None = None,
        headers: dict[str, str] | None = None,
        labels: list[str] | None = None,
        in_reply_to: str | None = None,
    ) -> Draft:
        data = self._http.request(
            "PATCH",
            f"/v0/inboxes/{encode_path(inbox_id)}/drafts/{encode_path(draft_id)}",
            body=_clean(
                {
                    "to": to,
                    "cc": cc,
                    "bcc": bcc,
                    "subject": subject,
                    "text": text,
                    "html": html,
                    "reply_to": reply_to,
                    "headers": headers,
                    "labels": labels,
                    "in_reply_to": in_reply_to,
                }
            ),
        )
        return Draft(**data)

    def delete(self, inbox_id: str, draft_id: str) -> None:
        self._http.request(
            "DELETE",
            f"/v0/inboxes/{encode_path(inbox_id)}/drafts/{encode_path(draft_id)}",
        )

    def send(self, inbox_id: str, draft_id: str, *, send_at: str | None = None) -> Message:
        data = self._http.request(
            "POST",
            f"/v0/inboxes/{encode_path(inbox_id)}/drafts/{encode_path(draft_id)}/send",
            body=_clean({"send_at": send_at}),
        )
        return Message(**data)

    def list(
        self,
        inbox_id: str,
        *,
        limit: int | None = None,
        page_token: str | None = None,
    ) -> DraftList:
        data = self._http.request(
            "GET",
            f"/v0/inboxes/{encode_path(inbox_id)}/drafts",
            query={"limit": limit, "page_token": page_token},
        )
        return DraftList(**data)


class _Threads:
    def __init__(self, http: HttpClient) -> None:
        self._http = http

    def list(
        self,
        inbox_id: str,
        *,
        limit: int | None = None,
        page_token: str | None = None,
    ) -> ThreadList:
        data = self._http.request(
            "GET",
            f"/v0/inboxes/{encode_path(inbox_id)}/threads",
            query={"limit": limit, "page_token": page_token},
        )
        return ThreadList(**data)

    def search(
        self,
        inbox_id: str,
        *,
        query: str,
        limit: int | None = None,
        page_token: str | None = None,
    ) -> ThreadList:
        data = self._http.request(
            "GET",
            f"/v0/inboxes/{encode_path(inbox_id)}/threads/search",
            query={"query": query, "limit": limit, "page_token": page_token},
        )
        return ThreadList(**data)

    def get(self, inbox_id: str, thread_id: str) -> Thread:
        data = self._http.request(
            "GET",
            f"/v0/inboxes/{encode_path(inbox_id)}/threads/{encode_path(thread_id)}",
        )
        return Thread(**data)


class _InboxLists:
    """Inbox-scoped allow/block entries (`/inboxes/:id/lists`)."""

    def __init__(self, http: HttpClient) -> None:
        self._http = http

    def list(
        self,
        inbox_id: str,
        *,
        kind: str | None = None,
        limit: int | None = None,
        page_token: str | None = None,
    ) -> ListEntryList:
        data = self._http.request(
            "GET",
            f"/v0/inboxes/{encode_path(inbox_id)}/lists",
            query={"kind": kind, "limit": limit, "page_token": page_token},
        )
        return ListEntryList(**data)

    def create(
        self,
        inbox_id: str,
        *,
        kind: str,
        pattern: str,
        client_id: str | None = None,
    ) -> ListEntry:
        data = self._http.request(
            "POST",
            f"/v0/inboxes/{encode_path(inbox_id)}/lists",
            body=_clean(
                {"kind": kind, "pattern": pattern, "client_id": client_id}
            ),
        )
        return ListEntry(**data)

    def get(self, inbox_id: str, entry_id: str) -> ListEntry:
        data = self._http.request(
            "GET",
            f"/v0/inboxes/{encode_path(inbox_id)}/lists/{encode_path(entry_id)}",
        )
        return ListEntry(**data)

    def delete(self, inbox_id: str, entry_id: str) -> None:
        self._http.request(
            "DELETE",
            f"/v0/inboxes/{encode_path(inbox_id)}/lists/{encode_path(entry_id)}",
        )


class _Lists:
    """Org-wide allow/block entries (`/v0/lists`); inbox entries via `inboxes.lists`."""

    def __init__(self, http: HttpClient) -> None:
        self._http = http

    def list(
        self,
        *,
        kind: str | None = None,
        inbox_id: str | None = None,
        limit: int | None = None,
        page_token: str | None = None,
    ) -> ListEntryList:
        data = self._http.request(
            "GET",
            "/v0/lists",
            query={
                "kind": kind,
                "inbox_id": inbox_id,
                "limit": limit,
                "page_token": page_token,
            },
        )
        return ListEntryList(**data)

    def create(
        self,
        *,
        kind: str,
        pattern: str,
        inbox_id: str | None = None,
        client_id: str | None = None,
    ) -> ListEntry:
        data = self._http.request(
            "POST",
            "/v0/lists",
            body=_clean(
                {
                    "kind": kind,
                    "pattern": pattern,
                    "inbox_id": inbox_id,
                    "client_id": client_id,
                }
            ),
        )
        return ListEntry(**data)

    def get(self, entry_id: str) -> ListEntry:
        data = self._http.request("GET", f"/v0/lists/{encode_path(entry_id)}")
        return ListEntry(**data)

    def delete(self, entry_id: str) -> None:
        self._http.request("DELETE", f"/v0/lists/{encode_path(entry_id)}")


class _Inboxes:
    def __init__(self, http: HttpClient) -> None:
        self._http = http
        self.messages = _Messages(http)
        self.threads = _Threads(http)
        self.drafts = _Drafts(http)
        self.lists = _InboxLists(http)

    def create(
        self,
        *,
        username: str | None = None,
        domain: str | None = None,
        display_name: str | None = None,
        pod_id: str | None = None,
        client_id: str | None = None,
    ) -> Inbox:
        data = self._http.request(
            "POST",
            "/v0/inboxes",
            body=_clean(
                {
                    "username": username,
                    "domain": domain,
                    "display_name": display_name,
                    "pod_id": pod_id,
                    "client_id": client_id,
                }
            ),
        )
        return Inbox(**data)

    def list(
        self, *, limit: int | None = None, page_token: str | None = None
    ) -> InboxList:
        data = self._http.request(
            "GET", "/v0/inboxes", query={"limit": limit, "page_token": page_token}
        )
        return InboxList(**data)

    def get(self, inbox_id: str) -> Inbox:
        data = self._http.request("GET", f"/v0/inboxes/{encode_path(inbox_id)}")
        return Inbox(**data)

    def update(
        self,
        inbox_id: str,
        *,
        display_name: str | None = None,
        x_open_tracking: bool | None = None,
        x_click_tracking: bool | None = None,
    ) -> Inbox:
        """PATCH inbox; `x_*_tracking` flags are resend-parity V1.1 additions."""
        data = self._http.request(
            "PATCH",
            f"/v0/inboxes/{encode_path(inbox_id)}",
            body=_clean(
                {
                    "display_name": display_name,
                    "x_open_tracking": x_open_tracking,
                    "x_click_tracking": x_click_tracking,
                }
            ),
        )
        return Inbox(**data)

    def delete(self, inbox_id: str) -> None:
        self._http.request("DELETE", f"/v0/inboxes/{encode_path(inbox_id)}")

    def counts(self, inbox_id: str) -> Counts:
        data = self._http.request(
            "GET", f"/v0/inboxes/{encode_path(inbox_id)}/counts"
        )
        return Counts(**data)


class _Webhooks:
    def __init__(self, http: HttpClient) -> None:
        self._http = http

    def create(
        self,
        *,
        url: str,
        event_types: list[str],
        inbox_id: str | None = None,
        pod_id: str | None = None,
        pod_ids: list[str] | None = None,
        enabled: bool | None = None,
        client_id: str | None = None,
    ) -> Webhook:
        data = self._http.request(
            "POST",
            "/v0/webhooks",
            body=_clean(
                {
                    "url": url,
                    "event_types": event_types,
                    "inbox_id": inbox_id,
                    "pod_id": pod_id,
                    "pod_ids": pod_ids,
                    "enabled": enabled,
                    "client_id": client_id,
                }
            ),
        )
        return Webhook(**data)

    def get(self, webhook_id: str) -> Webhook:
        data = self._http.request("GET", f"/v0/webhooks/{encode_path(webhook_id)}")
        return Webhook(**data)

    def update(
        self,
        webhook_id: str,
        *,
        url: str | None = None,
        event_types: list[str] | None = None,
        pod_ids: list[str] | None = None,
        enabled: bool | None = None,
    ) -> Webhook:
        data = self._http.request(
            "PATCH",
            f"/v0/webhooks/{encode_path(webhook_id)}",
            body=_clean(
                {
                    "url": url,
                    "event_types": event_types,
                    "pod_ids": pod_ids,
                    "enabled": enabled,
                }
            ),
        )
        return Webhook(**data)

    def delete(self, webhook_id: str) -> None:
        self._http.request("DELETE", f"/v0/webhooks/{encode_path(webhook_id)}")

    def test(self, webhook_id: str) -> WebhookTestResult:
        data = self._http.request(
            "POST", f"/v0/webhooks/{encode_path(webhook_id)}/test"
        )
        return WebhookTestResult(**data)

    def rotate_secret(self, webhook_id: str) -> WebhookSecret:
        """Rotate the signing secret; plaintext is returned once (resend-parity §3.14)."""
        data = self._http.request(
            "POST", f"/v0/webhooks/{encode_path(webhook_id)}/rotate-secret"
        )
        return WebhookSecret(**data)

    def events(
        self,
        webhook_id: str,
        *,
        limit: int | None = None,
        page_token: str | None = None,
    ) -> EventList:
        """Event payloads matching this webhook's scope filters (§3.15)."""
        data = self._http.request(
            "GET",
            f"/v0/webhooks/{encode_path(webhook_id)}/events",
            query={"limit": limit, "page_token": page_token},
        )
        return EventList(**data)

    def get_event(self, webhook_id: str, event_id: str) -> EventEnvelope:
        data = self._http.request(
            "GET",
            f"/v0/webhooks/{encode_path(webhook_id)}/events/{encode_path(event_id)}",
        )
        return EventEnvelope(**data)

    def list(
        self, *, limit: int | None = None, page_token: str | None = None
    ) -> WebhookList:
        data = self._http.request(
            "GET", "/v0/webhooks", query={"limit": limit, "page_token": page_token}
        )
        return WebhookList(**data)


class _Agent:
    def __init__(self, http: HttpClient) -> None:
        self._http = http

    def sign_up(self, *, human_email: str, username: str) -> AgentSignUpResponse:
        data = self._http.request(
            "POST",
            "/v0/agent/sign-up",
            body={"human_email": human_email, "username": username},
            auth=False,
        )
        return AgentSignUpResponse(**data)

    def verify(self, *, otp_code: str) -> AgentVerifyResponse:
        data = self._http.request("POST", "/v0/agent/verify", body={"otp_code": otp_code})
        return AgentVerifyResponse(**data)


class _Domains:
    def __init__(self, http: HttpClient) -> None:
        self._http = http

    def create(self, *, domain: str, client_id: str | None = None) -> Domain:
        data = self._http.request(
            "POST",
            "/v0/domains",
            body=_clean({"domain": domain, "client_id": client_id}),
        )
        return Domain(**data)

    def list(
        self, *, limit: int | None = None, page_token: str | None = None
    ) -> DomainList:
        data = self._http.request(
            "GET", "/v0/domains", query={"limit": limit, "page_token": page_token}
        )
        return DomainList(**data)

    def get(self, domain_id: str) -> Domain:
        data = self._http.request("GET", f"/v0/domains/{encode_path(domain_id)}")
        return Domain(**data)

    def update(
        self,
        domain_id: str,
        *,
        custom_return_path: str | None = None,
        client_id: str | None = None,
    ) -> Domain:
        data = self._http.request(
            "PATCH",
            f"/v0/domains/{encode_path(domain_id)}",
            body=_clean(
                {"custom_return_path": custom_return_path, "client_id": client_id}
            ),
        )
        return Domain(**data)

    def verify(self, domain_id: str) -> Domain:
        data = self._http.request("POST", f"/v0/domains/{encode_path(domain_id)}/verify")
        return Domain(**data)

    def delete(self, domain_id: str) -> None:
        self._http.request("DELETE", f"/v0/domains/{encode_path(domain_id)}")


class _Pods:
    def __init__(self, http: HttpClient) -> None:
        self._http = http

    def list(
        self, *, limit: int | None = None, page_token: str | None = None
    ) -> PodList:
        data = self._http.request(
            "GET", "/v0/pods", query={"limit": limit, "page_token": page_token}
        )
        return PodList(**data)

    def create(
        self, *, name: str | None = None, client_id: str | None = None
    ) -> Pod:
        data = self._http.request(
            "POST", "/v0/pods", body=_clean({"name": name, "client_id": client_id})
        )
        return Pod(**data)

    def get(self, pod_id: str) -> Pod:
        data = self._http.request("GET", f"/v0/pods/{encode_path(pod_id)}")
        return Pod(**data)

    def delete(self, pod_id: str) -> None:
        self._http.request("DELETE", f"/v0/pods/{encode_path(pod_id)}")


class _ApiKeys:
    def __init__(self, http: HttpClient) -> None:
        self._http = http

    def create(
        self,
        *,
        name: str | None = None,
        pod_id: str | None = None,
        inbox_id: str | None = None,
        permissions: list[str] | None = None,
        client_id: str | None = None,
    ) -> ApiKey:
        data = self._http.request(
            "POST",
            "/v0/api-keys",
            body=_clean(
                {
                    "name": name,
                    "pod_id": pod_id,
                    "inbox_id": inbox_id,
                    "permissions": permissions,
                    "client_id": client_id,
                }
            ),
        )
        return ApiKey(**data)

    def rename(self, api_key_id: str, *, name: str) -> ApiKey:
        """`PATCH /v0/api-keys/:key_id` (resend-parity §3.7)."""
        data = self._http.request(
            "PATCH", f"/v0/api-keys/{encode_path(api_key_id)}", body={"name": name}
        )
        return ApiKey(**data)

    def delete(self, api_key_id: str) -> None:
        self._http.request("DELETE", f"/v0/api-keys/{encode_path(api_key_id)}")

    def list(
        self, *, limit: int | None = None, page_token: str | None = None
    ) -> ApiKeyList:
        data = self._http.request(
            "GET", "/v0/api-keys", query={"limit": limit, "page_token": page_token}
        )
        return ApiKeyList(**data)


class _Auth:
    def __init__(self, http: HttpClient) -> None:
        self._http = http

    def me(self) -> AuthMe:
        data = self._http.request("GET", "/v0/auth/me")
        return AuthMe(**data)


class _Metrics:
    def __init__(self, http: HttpClient) -> None:
        self._http = http

    def get(
        self,
        *,
        period: str | None = None,
        inbox_id: str | None = None,
    ) -> Metrics:
        data = self._http.request(
            "GET",
            "/v0/metrics",
            query={"period": period, "inbox_id": inbox_id},
        )
        return Metrics(**data)

    def usage(self, *, month: str | None = None) -> Usage:
        data = self._http.request(
            "GET", "/v0/metrics/usage", query={"month": month}
        )
        return Usage(**data)


class _Usage:
    def __init__(self, http: HttpClient) -> None:
        self._http = http

    def get(self) -> PlanUsage:
        data = self._http.request("GET", "/v0/usage")
        return PlanUsage(**data)


class _Suppressions:
    """Org-wide bounce/complaint/manual suppressions (resend-parity §3.9)."""

    def __init__(self, http: HttpClient) -> None:
        self._http = http

    def add(self, *, address: str) -> Suppression:
        data = self._http.request("POST", "/v0/suppressions", body={"address": address})
        return Suppression(**data)

    def remove(self, address: str) -> None:
        self._http.request("DELETE", f"/v0/suppressions/{encode_path(address)}")

    def batch(
        self,
        *,
        add: list[str] | None = None,
        remove: list[str] | None = None,
    ) -> SuppressionBatchResult:
        data = self._http.request(
            "POST",
            "/v0/suppressions/batch",
            body=_clean({"add": add, "remove": remove}),
        )
        return SuppressionBatchResult(**data)

    def list(
        self,
        *,
        reason: str | None = None,
        limit: int | None = None,
        page_token: str | None = None,
    ) -> SuppressionList:
        data = self._http.request(
            "GET",
            "/v0/suppressions",
            query={"reason": reason, "limit": limit, "page_token": page_token},
        )
        return SuppressionList(**data)


class _Templates:
    """Org-owned reusable message bodies (resend-parity §5 templates)."""

    def __init__(self, http: HttpClient) -> None:
        self._http = http

    def create(
        self,
        *,
        name: str,
        html: str | None = None,
        text: str | None = None,
        alias: str | None = None,
        from_: str | None = None,
        subject: str | None = None,
        reply_to: ReplyTo | None = None,
        variables: list[TemplateVariable] | None = None,
        client_id: str | None = None,
    ) -> Template:
        data = self._http.request(
            "POST",
            "/v0/templates",
            body=_clean(
                {
                    "name": name,
                    "html": html,
                    "text": text,
                    "alias": alias,
                    "from": from_,
                    "subject": subject,
                    "reply_to": reply_to,
                    "variables": (
                        [dict(v) for v in variables] if variables is not None else None
                    ),
                    "client_id": client_id,
                }
            ),
        )
        return Template(**data)

    def get(self, template_id: str) -> Template:
        data = self._http.request("GET", f"/v0/templates/{encode_path(template_id)}")
        return Template(**data)

    def update(
        self,
        template_id: str,
        *,
        name: str | None = None,
        html: str | None = None,
        text: str | None = None,
        alias: str | None = None,
        from_: str | None = None,
        subject: str | None = None,
        reply_to: ReplyTo | None = None,
        variables: list[TemplateVariable] | None = None,
    ) -> Template:
        data = self._http.request(
            "PATCH",
            f"/v0/templates/{encode_path(template_id)}",
            body=_clean(
                {
                    "name": name,
                    "html": html,
                    "text": text,
                    "alias": alias,
                    "from": from_,
                    "subject": subject,
                    "reply_to": reply_to,
                    "variables": (
                        [dict(v) for v in variables] if variables is not None else None
                    ),
                }
            ),
        )
        return Template(**data)

    def delete(self, template_id: str) -> None:
        self._http.request("DELETE", f"/v0/templates/{encode_path(template_id)}")

    def publish(self, template_id: str) -> Template:
        data = self._http.request(
            "POST", f"/v0/templates/{encode_path(template_id)}/publish"
        )
        return Template(**data)

    def duplicate(self, template_id: str) -> Template:
        data = self._http.request(
            "POST", f"/v0/templates/{encode_path(template_id)}/duplicate"
        )
        return Template(**data)

    def list(
        self, *, limit: int | None = None, page_token: str | None = None
    ) -> TemplateList:
        data = self._http.request(
            "GET", "/v0/templates", query={"limit": limit, "page_token": page_token}
        )
        return TemplateList(**data)


class WzrdMail:
    """AgentMail-shape-compatible client (goal.md §0.2, §11).

    >>> client = WzrdMail(api_key="wm_live_...")
    >>> client.inboxes.messages.send("scout@wzrd.tech", to=["a@b.com"], subject="hi", text="yo")
    """

    def __init__(
        self,
        api_key: str | None = None,
        base_url: str | None = None,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        if api_key is None:
            api_key = os.environ.get("WZRDMAIL_API_KEY")
        if base_url is None:
            base_url = os.environ.get("WZRDMAIL_BASE_URL")
        http = HttpClient(api_key=api_key, base_url=base_url, transport=transport)
        self._http = http
        self.inboxes = _Inboxes(http)
        self.webhooks = _Webhooks(http)
        self.agent = _Agent(http)
        self.domains = _Domains(http)
        self.pods = _Pods(http)
        self.api_keys = _ApiKeys(http)
        self.lists = _Lists(http)
        self.suppressions = _Suppressions(http)
        self.templates = _Templates(http)
        self.auth = _Auth(http)
        self.metrics = _Metrics(http)
        self.usage = _Usage(http)

    def close(self) -> None:
        self._http.close()

    def __enter__(self) -> WzrdMail:
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        self.close()
