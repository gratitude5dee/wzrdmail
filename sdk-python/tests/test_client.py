from __future__ import annotations

import json
from typing import Any

import httpx
import pytest

from wzrdmail import WzrdMail, WzrdmailError

API_KEY = "wm_live_test"


class Recorder:
    def __init__(self, responses: list[httpx.Response] | None = None) -> None:
        self.requests: list[httpx.Request] = []
        self._responses = responses or []

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if self._responses:
            return self._responses.pop(0)
        return httpx.Response(200, json={})

    @property
    def last(self) -> httpx.Request:
        return self.requests[-1]


def make_client(
    recorder: Recorder, api_key: str | None = API_KEY, base_url: str | None = None
) -> WzrdMail:
    return WzrdMail(
        api_key=api_key,
        base_url=base_url or "https://api.wzrd.tech",
        transport=httpx.MockTransport(recorder.handler),
    )


def body_of(request: httpx.Request) -> dict[str, Any]:
    return json.loads(request.content.decode())  # type: ignore[no-any-return]


def test_default_base_url_and_bearer_auth(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("WZRDMAIL_API_KEY", raising=False)
    monkeypatch.delenv("WZRDMAIL_BASE_URL", raising=False)
    rec = Recorder([httpx.Response(200, json={"inboxes": []})])
    client = WzrdMail(api_key=API_KEY, transport=httpx.MockTransport(rec.handler))
    client.inboxes.list()
    assert str(rec.last.url) == "https://api.wzrd.tech/v0/inboxes"
    assert rec.last.headers["Authorization"] == f"Bearer {API_KEY}"


def test_env_var_fallback(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("WZRDMAIL_API_KEY", "wm_env_key")
    monkeypatch.setenv("WZRDMAIL_BASE_URL", "https://staging.example.com")
    rec = Recorder([httpx.Response(200, json={"inboxes": []})])
    client = WzrdMail(transport=httpx.MockTransport(rec.handler))
    client.inboxes.list()
    assert str(rec.last.url) == "https://staging.example.com/v0/inboxes"
    assert rec.last.headers["Authorization"] == "Bearer wm_env_key"


def test_pagination_params() -> None:
    rec = Recorder([httpx.Response(200, json={"inboxes": [], "next_page_token": "tok2"})])
    client = make_client(rec)
    result = client.inboxes.list(limit=5, page_token="tok1")
    assert rec.last.url.params["limit"] == "5"
    assert rec.last.url.params["page_token"] == "tok1"
    assert result.next_page_token == "tok2"


def test_inbox_create_body() -> None:
    rec = Recorder([httpx.Response(200, json={"inbox_id": "scout@wzrd.tech"})])
    client = make_client(rec)
    inbox = client.inboxes.create(username="scout", client_id="ci-1")
    assert rec.last.method == "POST"
    assert body_of(rec.last) == {"username": "scout", "client_id": "ci-1"}
    assert inbox.inbox_id == "scout@wzrd.tech"


def test_inbox_id_url_encoding() -> None:
    # httpx normalizes %40 back to @ (both valid in a path segment); slashes must stay encoded
    rec = Recorder(
        [
            httpx.Response(200, json={"inbox_id": "scout@wzrd.tech"}),
            httpx.Response(200, json={"inbox_id": "weird"}),
        ]
    )
    client = make_client(rec)
    client.inboxes.get("scout@wzrd.tech")
    assert rec.last.url.path == "/v0/inboxes/scout@wzrd.tech"
    client.inboxes.get("a/b?c")
    assert rec.last.url.raw_path == b"/v0/inboxes/a%2Fb%3Fc"


def test_message_send_path_and_body() -> None:
    rec = Recorder(
        [
            httpx.Response(
                200,
                json={
                    "message_id": "msg_1",
                    "inbox_id": "scout@wzrd.tech",
                    "from": "scout@wzrd.tech",
                },
            )
        ]
    )
    client = make_client(rec)
    msg = client.inboxes.messages.send(
        "scout@wzrd.tech", to=["human@gmail.com"], subject="hello", text="hi"
    )
    assert rec.last.url.path == "/v0/inboxes/scout@wzrd.tech/messages/send"
    assert body_of(rec.last) == {
        "to": ["human@gmail.com"],
        "subject": "hello",
        "text": "hi",
    }
    assert msg.message_id == "msg_1"
    assert msg.from_ == "scout@wzrd.tech"


def test_message_list_filters() -> None:
    rec = Recorder([httpx.Response(200, json={"messages": []})])
    client = make_client(rec)
    client.inboxes.messages.list(
        "scout@wzrd.tech", labels=["inbox", "unread"], before="2026-01-01"
    )
    params = rec.last.url.params
    assert params["labels"] == "inbox,unread"
    assert len(params.get_list("labels")) == 1
    assert params["before"] == "2026-01-01"


def test_message_send_headers_and_attachments() -> None:
    rec = Recorder(
        [httpx.Response(200, json={"message_id": "msg_1", "inbox_id": "scout@wzrd.tech"})]
    )
    client = make_client(rec)
    client.inboxes.messages.send(
        "scout@wzrd.tech",
        to=["human@gmail.com"],
        text="hi",
        headers={"X-Custom": "1"},
        attachments=[{"filename": "a.txt", "content_type": "text/plain", "content": "aGk="}],
    )
    body = body_of(rec.last)
    assert body["headers"] == {"X-Custom": "1"}
    assert body["attachments"] == [
        {"filename": "a.txt", "content_type": "text/plain", "content": "aGk="}
    ]


def test_close_and_context_manager() -> None:
    rec = Recorder([httpx.Response(200, json={"inboxes": []})])
    with make_client(rec) as client:
        client.inboxes.list()
    with pytest.raises(RuntimeError):
        client.inboxes.list()


@pytest.mark.parametrize("header", ["inf", "-inf", "nan"])
def test_retry_after_non_finite_uses_fallback(header: str) -> None:
    rec = Recorder(
        [
            httpx.Response(
                429,
                json={"name": "rate_limited", "message": "slow down"},
                headers={"Retry-After": header},
            ),
            httpx.Response(200, json={"inboxes": []}),
        ]
    )
    client = make_client(rec)
    sleeps: list[float] = []
    client._http._sleep = sleeps.append  # noqa: SLF001
    client.inboxes.list()
    assert sleeps == [0.5]


def test_threads_paths() -> None:
    rec = Recorder(
        [
            httpx.Response(200, json={"threads": []}),
            httpx.Response(200, json={"thread_id": "thr_1"}),
        ]
    )
    client = make_client(rec)
    client.inboxes.threads.list("scout@wzrd.tech")
    thread = client.inboxes.threads.get("scout@wzrd.tech", "thr_1")
    assert rec.requests[0].url.path == "/v0/inboxes/scout@wzrd.tech/threads"
    assert rec.requests[1].url.path == "/v0/inboxes/scout@wzrd.tech/threads/thr_1"
    assert thread.thread_id == "thr_1"


def test_webhooks_crud() -> None:
    rec = Recorder(
        [
            httpx.Response(
                200,
                json={"webhook_id": "wh_1", "url": "https://x.dev/h", "event_types": []},
            ),
            httpx.Response(200, json={"webhooks": []}),
            httpx.Response(204),
        ]
    )
    client = make_client(rec)
    wh = client.webhooks.create(url="https://x.dev/h", event_types=["message.received"])
    client.webhooks.list()
    client.webhooks.delete("wh_1")
    assert wh.webhook_id == "wh_1"
    assert body_of(rec.requests[0]) == {
        "url": "https://x.dev/h",
        "event_types": ["message.received"],
    }
    assert rec.requests[2].method == "DELETE"
    assert rec.requests[2].url.path == "/v0/webhooks/wh_1"


def test_agent_sign_up_is_unauthenticated() -> None:
    rec = Recorder(
        [
            httpx.Response(
                200,
                json={
                    "api_key": "wm_live_new",
                    "inbox_id": "scout@wzrd.tech",
                    "organization_id": "org_1",
                },
            )
        ]
    )
    client = make_client(rec, api_key=None)
    resp = client.agent.sign_up(human_email="dev@example.com", username="scout")
    assert "Authorization" not in rec.last.headers
    assert body_of(rec.last) == {"human_email": "dev@example.com", "username": "scout"}
    assert resp.api_key == "wm_live_new"


def test_agent_verify_requires_auth() -> None:
    rec = Recorder([httpx.Response(200, json={"verified": True})])
    client = make_client(rec)
    resp = client.agent.verify(otp_code="123456")
    assert rec.last.headers["Authorization"] == f"Bearer {API_KEY}"
    assert body_of(rec.last) == {"otp_code": "123456"}
    assert resp.verified is True


def test_missing_api_key_raises_locally(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("WZRDMAIL_API_KEY", raising=False)
    rec = Recorder()
    client = make_client(rec, api_key=None)
    with pytest.raises(WzrdmailError) as exc:
        client.inboxes.list()
    assert exc.value.name == "unauthorized"
    assert rec.requests == []


def test_domains() -> None:
    rec = Recorder(
        [
            httpx.Response(200, json={"domain_id": "dom_1", "domain": "example.com"}),
            httpx.Response(200, json={"domains": []}),
            httpx.Response(
                200, json={"domain_id": "dom_1", "domain": "example.com", "status": "verified"}
            ),
        ]
    )
    client = make_client(rec)
    client.domains.create(domain="example.com")
    client.domains.list()
    verified = client.domains.verify("dom_1")
    assert body_of(rec.requests[0]) == {"domain": "example.com"}
    assert rec.requests[2].url.path == "/v0/domains/dom_1/verify"
    assert verified.status == "verified"


def test_error_envelope_mapping() -> None:
    rec = Recorder(
        [httpx.Response(403, json={"name": "forbidden", "message": "verify your account"})]
    )
    client = make_client(rec)
    with pytest.raises(WzrdmailError) as exc:
        client.inboxes.list()
    assert exc.value.status == 403
    assert exc.value.name == "forbidden"
    assert exc.value.message == "verify your account"


def test_malformed_error_mapping() -> None:
    rec = Recorder([httpx.Response(500, text="oops")])
    client = make_client(rec)
    with pytest.raises(WzrdmailError) as exc:
        client.inboxes.list()
    assert exc.value.name == "internal_error"
    assert exc.value.status == 500


def test_429_retry_with_retry_after_seconds() -> None:
    rec = Recorder(
        [
            httpx.Response(429, headers={"Retry-After": "0"}, json={}),
            httpx.Response(200, json={"inboxes": []}),
        ]
    )
    client = make_client(rec)
    sleeps: list[float] = []
    client._http._sleep = sleeps.append
    client.inboxes.list()
    assert len(rec.requests) == 2
    assert sleeps == [0.0]


def test_429_retry_missing_header_uses_backoff() -> None:
    rec = Recorder(
        [
            httpx.Response(429, json={}),
            httpx.Response(429, json={}),
            httpx.Response(200, json={"inboxes": []}),
        ]
    )
    client = make_client(rec)
    sleeps: list[float] = []
    client._http._sleep = sleeps.append
    client.inboxes.list()
    assert len(rec.requests) == 3
    assert sleeps == [0.5, 1.0]


def test_429_retry_exhaustion_raises() -> None:
    rec = Recorder(
        [
            httpx.Response(
                429, json={"name": "rate_limited", "message": "slow down"}
            )
            for _ in range(4)
        ]
    )
    client = make_client(rec)
    client._http._sleep = lambda _s: None
    with pytest.raises(WzrdmailError) as exc:
        client.inboxes.list()
    assert len(rec.requests) == 4
    assert exc.value.name == "rate_limited"


def test_retry_after_http_date() -> None:
    rec = Recorder(
        [
            httpx.Response(
                429, headers={"Retry-After": "Mon, 01 Jan 1990 00:00:00 GMT"}, json={}
            ),
            httpx.Response(200, json={"inboxes": []}),
        ]
    )
    client = make_client(rec)
    sleeps: list[float] = []
    client._http._sleep = sleeps.append
    client.inboxes.list()
    assert sleeps == [0.0]
