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


def test_drafts_crud_and_send() -> None:
    rec = Recorder(
        [
            httpx.Response(200, json={"draft_id": "dft_1", "inbox_id": "scout@wzrd.tech"}),
            httpx.Response(200, json={"drafts": [], "next_page_token": "t2"}),
            httpx.Response(200, json={"draft_id": "dft_1"}),
            httpx.Response(200, json={"draft_id": "dft_1", "subject": "s2"}),
            httpx.Response(204),
            httpx.Response(200, json={"message_id": "msg_9", "inbox_id": "scout@wzrd.tech"}),
        ]
    )
    client = make_client(rec)
    draft = client.inboxes.drafts.create(
        "scout@wzrd.tech", to=["a@b.com"], subject="s1", client_id="ci-1"
    )
    client.inboxes.drafts.list("scout@wzrd.tech", limit=10)
    client.inboxes.drafts.get("scout@wzrd.tech", "dft_1")
    client.inboxes.drafts.update("scout@wzrd.tech", "dft_1", subject="s2")
    client.inboxes.drafts.delete("scout@wzrd.tech", "dft_1")
    msg = client.inboxes.drafts.send("scout@wzrd.tech", "dft_1", send_at="2027-01-01T00:00:00Z")
    assert draft.draft_id == "dft_1"
    assert body_of(rec.requests[0]) == {
        "to": ["a@b.com"],
        "subject": "s1",
        "client_id": "ci-1",
    }
    assert rec.requests[2].url.path == "/v0/inboxes/scout@wzrd.tech/drafts/dft_1"
    assert rec.requests[3].method == "PATCH"
    assert rec.requests[4].method == "DELETE"
    assert rec.requests[5].url.path.endswith("/drafts/dft_1/send")
    assert body_of(rec.requests[5]) == {"send_at": "2027-01-01T00:00:00Z"}
    assert msg.message_id == "msg_9"


def test_pods_crud() -> None:
    rec = Recorder(
        [
            httpx.Response(200, json={"pods": []}),
            httpx.Response(201, json={"pod_id": "pod_1", "name": "n"}),
            httpx.Response(200, json={"pod_id": "pod_1"}),
            httpx.Response(204),
        ]
    )
    client = make_client(rec)
    client.pods.list()
    pod = client.pods.create(name="n", client_id="ci-1")
    client.pods.get("pod_1")
    client.pods.delete("pod_1")
    assert pod.pod_id == "pod_1"
    assert body_of(rec.requests[1]) == {"name": "n", "client_id": "ci-1"}
    assert rec.requests[3].url.path == "/v0/pods/pod_1"


def test_api_keys_crud_and_rename() -> None:
    rec = Recorder(
        [
            httpx.Response(200, json={"api_keys": []}),
            httpx.Response(201, json={"api_key_id": "key_1", "key": "wm_live_x"}),
            httpx.Response(200, json={"key_id": "key_1", "name": "new"}),
            httpx.Response(200, json={"key_id": "key_1", "revoked": True}),
        ]
    )
    client = make_client(rec)
    client.api_keys.list()
    key = client.api_keys.create(
        name="k", pod_id="pod_1", permissions=["read", "drafts"]
    )
    renamed = client.api_keys.rename("key_1", name="new")
    client.api_keys.delete("key_1")
    assert key.key == "wm_live_x"
    assert rec.requests[1].url.path == "/v0/api-keys"
    assert body_of(rec.requests[1]) == {
        "name": "k",
        "pod_id": "pod_1",
        "permissions": ["read", "drafts"],
    }
    assert rec.requests[2].method == "PATCH"
    assert rec.requests[2].url.path == "/v0/api-keys/key_1"
    assert body_of(rec.requests[2]) == {"name": "new"}
    assert renamed.name == "new"
    assert rec.requests[3].method == "DELETE"


def test_lists_org_and_inbox_scoped() -> None:
    rec = Recorder(
        [
            httpx.Response(200, json={"list_entries": []}),
            httpx.Response(201, json={"entry_id": "lst_1", "kind": "block"}),
            httpx.Response(200, json={"entry_id": "lst_1"}),
            httpx.Response(204),
            httpx.Response(200, json={"list_entries": []}),
            httpx.Response(201, json={"entry_id": "lst_2", "kind": "allow"}),
        ]
    )
    client = make_client(rec)
    client.lists.list(kind="block", inbox_id="scout@wzrd.tech")
    entry = client.lists.create(kind="block", pattern="@spam.example")
    client.lists.get("lst_1")
    client.lists.delete("lst_1")
    client.inboxes.lists.list("scout@wzrd.tech", kind="allow")
    client.inboxes.lists.create("scout@wzrd.tech", kind="allow", pattern="friend@x.com")
    assert rec.requests[0].url.path == "/v0/lists"
    assert rec.requests[0].url.params["kind"] == "block"
    assert body_of(rec.requests[1]) == {"kind": "block", "pattern": "@spam.example"}
    assert entry.entry_id == "lst_1"
    assert rec.requests[4].url.path == "/v0/inboxes/scout@wzrd.tech/lists"
    assert body_of(rec.requests[5]) == {"kind": "allow", "pattern": "friend@x.com"}


def test_inbox_counts_usage_metrics_and_auth() -> None:
    rec = Recorder(
        [
            httpx.Response(200, json={"unread": 3, "spam": 1, "drafts": 2, "trash": 0}),
            httpx.Response(
                200,
                json={
                    "plan": "free",
                    "month": "2026-10",
                    "usage": {"inboxes": {"used": 2, "limit": 5}},
                },
            ),
            httpx.Response(
                200,
                json={
                    "month": "2026-10",
                    "metrics": [{"metric": "emails", "used": 9, "limit": 100}],
                },
            ),
            httpx.Response(
                200,
                json={
                    "period": "7d",
                    "since": "s",
                    "totals": {"message.sent": 4},
                    "series": [],
                },
            ),
            httpx.Response(200, json={"organization_id": "org_1", "verified": True}),
        ]
    )
    client = make_client(rec)
    counts = client.inboxes.counts("scout@wzrd.tech")
    plan = client.usage.get()
    usage = client.metrics.usage(month="2026-10")
    metrics = client.metrics.get(period="7d", inbox_id="scout@wzrd.tech")
    me = client.auth.me()
    assert counts.unread == 3 and counts.drafts == 2
    assert rec.requests[0].url.path == "/v0/inboxes/scout@wzrd.tech/counts"
    assert plan.usage["inboxes"].used == 2
    assert usage.metrics[0].used == 9
    assert rec.requests[3].url.params["period"] == "7d"
    assert metrics.totals["message.sent"] == 4
    assert me.organization_id == "org_1"


def test_message_batch_get_update_and_search() -> None:
    rec = Recorder(
        [
            httpx.Response(
                200,
                json={"messages": [{"message_id": "m1", "inbox_id": "scout@wzrd.tech"}]},
            ),
            httpx.Response(200, json={"updated": ["m1", "m2"]}),
            httpx.Response(200, json={"messages": []}),
            httpx.Response(200, json={"threads": []}),
        ]
    )
    client = make_client(rec)
    got = client.inboxes.messages.batch_get("scout@wzrd.tech", message_ids=["m1"])
    upd = client.inboxes.messages.batch_update(
        "scout@wzrd.tech", message_ids=["m1", "m2"], add_labels=["triaged"], read=True
    )
    client.inboxes.messages.search("scout@wzrd.tech", query="invoice")
    client.inboxes.threads.search("scout@wzrd.tech", query="invoice")
    assert got.messages[0].message_id == "m1"
    assert body_of(rec.requests[0]) == {"message_ids": ["m1"]}
    assert rec.requests[1].method == "PATCH"
    assert rec.requests[1].url.path.endswith("/messages/batch-update")
    assert body_of(rec.requests[1]) == {
        "message_ids": ["m1", "m2"],
        "add_labels": ["triaged"],
        "read": True,
    }
    assert upd.updated == ["m1", "m2"]
    assert rec.requests[2].url.path.endswith("/messages/search")
    assert rec.requests[2].url.params["query"] == "invoice"
    assert rec.requests[3].url.path.endswith("/threads/search")


def test_message_reply_forward_update_restore_delete() -> None:
    ok = httpx.Response(200, json={"message_id": "m2", "inbox_id": "scout@wzrd.tech"})
    rec = Recorder([ok, ok, ok, ok, httpx.Response(204), ok])
    client = make_client(rec)
    client.inboxes.messages.reply(
        "scout@wzrd.tech", "m1", text="thx", reply_to=["a@x.com", "b@x.com"]
    )
    client.inboxes.messages.reply_all("scout@wzrd.tech", "m1", html="<p>all</p>")
    client.inboxes.messages.forward("scout@wzrd.tech", "m1", to=["c@x.com"], text="fyi")
    client.inboxes.messages.update(
        "scout@wzrd.tech", "m1", add_labels=["x"], send_at="2027-01-01T00:00:00Z"
    )
    client.inboxes.messages.delete("scout@wzrd.tech", "m1")
    client.inboxes.messages.restore("scout@wzrd.tech", "m1")
    assert rec.requests[0].url.path.endswith("/messages/m1/reply")
    assert body_of(rec.requests[0])["reply_to"] == ["a@x.com", "b@x.com"]
    assert rec.requests[1].url.path.endswith("/reply-all")
    assert rec.requests[2].url.path.endswith("/forward")
    assert body_of(rec.requests[2])["to"] == ["c@x.com"]
    assert rec.requests[3].method == "PATCH"
    assert body_of(rec.requests[3]) == {
        "add_labels": ["x"],
        "send_at": "2027-01-01T00:00:00Z",
    }
    assert rec.requests[4].method == "DELETE"
    assert rec.requests[5].url.path.endswith("/restore")


def test_message_batch_send_cancel_share_events_attachments() -> None:
    rec = Recorder(
        [
            httpx.Response(
                200,
                json={
                    "results": [
                        {"index": 0, "message_id": "m1"},
                        {
                            "index": 1,
                            "error": {"name": "validation_error", "message": "bad"},
                        },
                    ]
                },
            ),
            httpx.Response(200, json={"message_id": "m1", "inbox_id": "i", "state": "cancelled"}),
            httpx.Response(
                200,
                json={
                    "attachments": [
                        {
                            "attachment_id": "att_1",
                            "filename": "a.png",
                            "content_type": "image/png",
                            "size": 3,
                        }
                    ]
                },
            ),
            httpx.Response(200, content=b"\x89PNG", headers={"Content-Type": "image/png"}),
            httpx.Response(200, json={"events": [{"event_id": "evt_1", "type": "message.sent"}]}),
            httpx.Response(200, json={"share_url": "https://api.wzrd.tech/v0/share/shr_1"}),
        ]
    )
    client = make_client(rec)
    result = client.inboxes.messages.batch_send(
        "scout@wzrd.tech",
        messages=[{"to": ["a@b.com"], "text": "x"}, {"to": ["bad"], "text": "y"}],
        idempotency_key="batch-1",
    )
    cancelled = client.inboxes.messages.cancel("scout@wzrd.tech", "m1")
    atts = client.inboxes.messages.list_attachments("scout@wzrd.tech", "m1")
    content = client.inboxes.messages.download_attachment(
        "scout@wzrd.tech", "m1", "att_1", disposition="inline"
    )
    events = client.inboxes.messages.events("scout@wzrd.tech", "m1")
    share = client.inboxes.messages.share("scout@wzrd.tech", "m1", expires_in=3600)
    assert rec.requests[0].url.path.endswith("/messages/batch-send")
    assert rec.requests[0].headers["Idempotency-Key"] == "batch-1"
    assert body_of(rec.requests[0]) == {
        "messages": [
            {"to": ["a@b.com"], "text": "x"},
            {"to": ["bad"], "text": "y"},
        ]
    }
    assert result.results[0].message_id == "m1"
    assert result.results[1].error is not None
    assert cancelled.state == "cancelled"
    assert rec.requests[1].url.path.endswith("/cancel")
    assert atts.attachments[0].attachment_id == "att_1"
    assert content == b"\x89PNG"
    assert rec.requests[3].url.params["disposition"] == "inline"
    assert events.events[0].type == "message.sent"
    assert share.share_url.endswith("/share/shr_1")
    assert body_of(rec.requests[5]) == {"expires_in": 3600}


def test_send_widened_fields() -> None:
    rec = Recorder([httpx.Response(200, json={"message_id": "m1", "inbox_id": "i"})])
    client = make_client(rec)
    client.inboxes.messages.send(
        "scout@wzrd.tech",
        to=["a@b.com"],
        reply_to=["r1@x.com", "r2@x.com"],
        send_at="2027-01-01T00:00:00Z",
        template={"id": "tpl_1", "variables": {"NAME": "Ada"}},
        attachments=[
            {
                "filename": "a.txt",
                "content_type": "text/plain",
                "path": "https://x.com/a.txt",
                "content_id": "att",
            }
        ],
    )
    body = body_of(rec.last)
    assert body["reply_to"] == ["r1@x.com", "r2@x.com"]
    assert body["send_at"] == "2027-01-01T00:00:00Z"
    assert body["template"] == {"id": "tpl_1", "variables": {"NAME": "Ada"}}
    assert body["attachments"] == [
        {
            "filename": "a.txt",
            "content_type": "text/plain",
            "path": "https://x.com/a.txt",
            "content_id": "att",
        }
    ]


def test_suppressions() -> None:
    rec = Recorder(
        [
            httpx.Response(
                200, json={"suppressions": [{"address": "a@x.com", "reason": "bounce"}]}
            ),
            httpx.Response(201, json={"address": "b@x.com", "reason": "manual"}),
            httpx.Response(204),
            httpx.Response(200, json={"added": ["c@x.com"], "removed": ["a@x.com"]}),
        ]
    )
    client = make_client(rec)
    listed = client.suppressions.list(reason="bounce")
    added = client.suppressions.add(address="b@x.com")
    client.suppressions.remove("a@x.com")
    batch = client.suppressions.batch(add=["c@x.com"], remove=["a@x.com"])
    assert rec.requests[0].url.params["reason"] == "bounce"
    assert listed.suppressions[0].reason == "bounce"
    assert body_of(rec.requests[1]) == {"address": "b@x.com"}
    assert added.reason == "manual"
    assert rec.requests[2].method == "DELETE"
    assert rec.requests[2].url.path == "/v0/suppressions/a@x.com"
    assert rec.requests[3].url.path == "/v0/suppressions/batch"
    assert body_of(rec.requests[3]) == {"add": ["c@x.com"], "remove": ["a@x.com"]}
    assert batch.added == ["c@x.com"]


def test_domain_update_and_webhook_secret_events() -> None:
    rec = Recorder(
        [
            httpx.Response(200, json={"domain_id": "dom_1", "domain": "x.com"}),
            httpx.Response(200, json={"secret": "whsec_new"}),
            httpx.Response(200, json={"events": [{"event_id": "evt_1"}]}),
            httpx.Response(200, json={"event_id": "evt_1", "type": "message.sent"}),
        ]
    )
    client = make_client(rec)
    client.domains.update("dom_1", custom_return_path="bounces")
    rotated = client.webhooks.rotate_secret("wh_1")
    client.webhooks.events("wh_1", limit=5)
    event = client.webhooks.get_event("wh_1", "evt_1")
    assert rec.requests[0].method == "PATCH"
    assert body_of(rec.requests[0]) == {"custom_return_path": "bounces"}
    assert rec.requests[1].url.path == "/v0/webhooks/wh_1/rotate-secret"
    assert rotated.secret == "whsec_new"
    assert rec.requests[2].url.path == "/v0/webhooks/wh_1/events"
    assert rec.requests[2].url.params["limit"] == "5"
    assert event.type == "message.sent"


def test_templates_crud_publish_duplicate() -> None:
    rec = Recorder(
        [
            httpx.Response(201, json={"id": "tpl_1", "name": "welcome"}),
            httpx.Response(200, json={"templates": [], "next_page_token": "t9"}),
            httpx.Response(200, json={"id": "tpl_1", "status": "draft"}),
            httpx.Response(200, json={"id": "tpl_1", "name": "v2"}),
            httpx.Response(204),
            httpx.Response(200, json={"id": "tpl_1", "status": "published"}),
            httpx.Response(200, json={"id": "tpl_2"}),
        ]
    )
    client = make_client(rec)
    created = client.templates.create(
        name="welcome",
        html="<p>Hi {{NAME}}</p>",
        variables=[{"key": "NAME", "type": "string", "fallback_value": "there"}],
    )
    listed = client.templates.list()
    client.templates.get("tpl_1")
    client.templates.update("tpl_1", name="v2")
    client.templates.delete("tpl_1")
    published = client.templates.publish("tpl_1")
    dup = client.templates.duplicate("tpl_1")
    assert created.id == "tpl_1"
    assert body_of(rec.requests[0]) == {
        "name": "welcome",
        "html": "<p>Hi {{NAME}}</p>",
        "variables": [{"key": "NAME", "type": "string", "fallback_value": "there"}],
    }
    assert listed.next_page_token == "t9"
    assert rec.requests[4].method == "DELETE"
    assert rec.requests[5].url.path == "/v0/templates/tpl_1/publish"
    assert published.status == "published"
    assert rec.requests[6].url.path == "/v0/templates/tpl_1/duplicate"
    assert dup.id == "tpl_2"


def test_inbox_update_tracking_and_delete() -> None:
    rec = Recorder(
        [
            httpx.Response(200, json={"inbox_id": "scout@wzrd.tech", "x_open_tracking": True}),
            httpx.Response(204),
        ]
    )
    client = make_client(rec)
    inbox = client.inboxes.update(
        "scout@wzrd.tech", display_name="Scout", x_open_tracking=True, x_click_tracking=False
    )
    client.inboxes.delete("scout@wzrd.tech")
    assert rec.requests[0].method == "PATCH"
    assert body_of(rec.requests[0]) == {
        "display_name": "Scout",
        "x_open_tracking": True,
        "x_click_tracking": False,
    }
    assert inbox.inbox_id == "scout@wzrd.tech"
    assert rec.requests[1].method == "DELETE"
    assert rec.requests[1].url.path == "/v0/inboxes/scout@wzrd.tech"
