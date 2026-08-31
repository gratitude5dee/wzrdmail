from __future__ import annotations

import os
from types import TracebackType
from typing import Any

import httpx

from ._http import DEFAULT_BASE_URL, HttpClient, encode_path
from .types import (
    AgentSignUpResponse,
    AgentVerifyResponse,
    Domain,
    DomainList,
    Inbox,
    InboxList,
    Message,
    MessageList,
    SendAttachment,
    Thread,
    ThreadList,
    Webhook,
    WebhookList,
)

__all__ = ["WzrdMail", "DEFAULT_BASE_URL"]


def _clean(body: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in body.items() if v is not None}


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
        reply_to: str | None = None,
        headers: dict[str, str] | None = None,
        attachments: list[SendAttachment] | None = None,
        labels: list[str] | None = None,
        client_id: str | None = None,
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
                }
            ),
        )
        return Message(**data)

    def list(
        self,
        inbox_id: str,
        *,
        limit: int | None = None,
        page_token: str | None = None,
        labels: list[str] | None = None,
        before: str | None = None,
        after: str | None = None,
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
            },
        )
        return MessageList(**data)

    def get(self, inbox_id: str, message_id: str) -> Message:
        data = self._http.request(
            "GET",
            f"/v0/inboxes/{encode_path(inbox_id)}/messages/{encode_path(message_id)}",
        )
        return Message(**data)


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

    def get(self, inbox_id: str, thread_id: str) -> Thread:
        data = self._http.request(
            "GET",
            f"/v0/inboxes/{encode_path(inbox_id)}/threads/{encode_path(thread_id)}",
        )
        return Thread(**data)


class _Inboxes:
    def __init__(self, http: HttpClient) -> None:
        self._http = http
        self.messages = _Messages(http)
        self.threads = _Threads(http)

    def create(
        self,
        *,
        username: str | None = None,
        domain: str | None = None,
        display_name: str | None = None,
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
                    "client_id": client_id,
                }
            ),
        )
        return Webhook(**data)

    def list(
        self, *, limit: int | None = None, page_token: str | None = None
    ) -> WebhookList:
        data = self._http.request(
            "GET", "/v0/webhooks", query={"limit": limit, "page_token": page_token}
        )
        return WebhookList(**data)

    def delete(self, webhook_id: str) -> None:
        self._http.request("DELETE", f"/v0/webhooks/{encode_path(webhook_id)}")


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

    def verify(self, domain_id: str) -> Domain:
        data = self._http.request("POST", f"/v0/domains/{encode_path(domain_id)}/verify")
        return Domain(**data)


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
