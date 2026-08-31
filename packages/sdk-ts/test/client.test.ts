import { describe, expect, it, vi } from "vitest";
import { WzrdMailClient, WzrdmailError } from "../src/index.js";
import type { FetchLike } from "../src/http.js";

interface Captured {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
}

function mockFetch(
  responses: Array<{ status: number; body?: unknown; headers?: Record<string, string> }>
): { fetch: FetchLike; calls: Captured[] } {
  const calls: Captured[] = [];
  let i = 0;
  const fetch: FetchLike = (input, init) => {
    const spec = responses[Math.min(i, responses.length - 1)];
    i += 1;
    calls.push({
      url: new URL(input),
      method: init.method ?? "GET",
      headers: (init.headers ?? {}) as Record<string, string>,
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined
    });
    if (!spec) throw new Error("no mock response");
    return Promise.resolve(
      new Response(spec.body === undefined ? null : JSON.stringify(spec.body), {
        status: spec.status,
        headers: spec.headers
      })
    );
  };
  return { fetch, calls };
}

const inbox = {
  inbox_id: "scout@wzrd.tech",
  organization_id: "org_1",
  pod_id: "pod_1",
  username: "scout",
  domain: "wzrd.tech",
  created_at: "2026-08-31T00:00:00Z",
  updated_at: "2026-08-31T00:00:00Z"
};

function client(fetch: FetchLike, apiKey: string | null = "wm_live_test") {
  return new WzrdMailClient({ apiKey: apiKey ?? undefined, fetch });
}

describe("WzrdMailClient", () => {
  it("defaults baseUrl to https://api.wzrd.tech and sends Bearer auth", async () => {
    const { fetch, calls } = mockFetch([{ status: 200, body: { inboxes: [] } }]);
    await client(fetch).inboxes.list();
    expect(calls[0]?.url.origin).toBe("https://api.wzrd.tech");
    expect(calls[0]?.url.pathname).toBe("/v0/inboxes");
    expect(calls[0]?.headers["Authorization"]).toBe("Bearer wm_live_test");
  });

  it("honors a custom baseUrl", async () => {
    const { fetch, calls } = mockFetch([{ status: 200, body: { inboxes: [] } }]);
    const c = new WzrdMailClient({
      apiKey: "wm_live_test",
      baseUrl: "http://localhost:8787/",
      fetch
    });
    await c.inboxes.list();
    expect(calls[0]?.url.toString()).toBe("http://localhost:8787/v0/inboxes");
  });

  it("passes pagination params as query string", async () => {
    const { fetch, calls } = mockFetch([
      { status: 200, body: { inboxes: [inbox], next_page_token: "tok2" } }
    ]);
    const page = await client(fetch).inboxes.list({ limit: 5, page_token: "tok1" });
    expect(calls[0]?.url.searchParams.get("limit")).toBe("5");
    expect(calls[0]?.url.searchParams.get("page_token")).toBe("tok1");
    expect(page.inboxes).toEqual([inbox]);
    expect(page.next_page_token).toBe("tok2");
  });

  it("creates an inbox with a snake_case body", async () => {
    const { fetch, calls } = mockFetch([{ status: 200, body: inbox }]);
    const created = await client(fetch).inboxes.create({
      username: "scout",
      display_name: "Scout",
      client_id: "cid-1"
    });
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url.pathname).toBe("/v0/inboxes");
    expect(calls[0]?.headers["Content-Type"]).toBe("application/json");
    expect(calls[0]?.body).toEqual({
      username: "scout",
      display_name: "Scout",
      client_id: "cid-1"
    });
    expect(created).toEqual(inbox);
  });

  it("URL-encodes inbox ids in paths", async () => {
    const { fetch, calls } = mockFetch([{ status: 200, body: inbox }]);
    await client(fetch).inboxes.get("scout@wzrd.tech");
    expect(calls[0]?.url.pathname).toBe("/v0/inboxes/scout%40wzrd.tech");
  });

  it("sends a message via POST …/messages/send", async () => {
    const { fetch, calls } = mockFetch([{ status: 200, body: { message_id: "msg_1" } }]);
    await client(fetch).inboxes.messages.send("scout@wzrd.tech", {
      to: ["human@gmail.com"],
      subject: "Report ready",
      text: "Done."
    });
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url.pathname).toBe("/v0/inboxes/scout%40wzrd.tech/messages/send");
    expect(calls[0]?.body).toEqual({
      to: ["human@gmail.com"],
      subject: "Report ready",
      text: "Done."
    });
  });

  it("lists messages with filters", async () => {
    const { fetch, calls } = mockFetch([{ status: 200, body: { messages: [] } }]);
    await client(fetch).inboxes.messages.list("scout@wzrd.tech", {
      labels: ["unread", "sent"],
      before: "2026-08-31T00:00:00Z"
    });
    expect(calls[0]?.url.pathname).toBe("/v0/inboxes/scout%40wzrd.tech/messages");
    expect(calls[0]?.url.searchParams.get("labels")).toBe("unread,sent");
    expect(calls[0]?.url.searchParams.get("before")).toBe("2026-08-31T00:00:00Z");
  });

  it("gets a message and a thread by id", async () => {
    const { fetch, calls } = mockFetch([{ status: 200, body: {} }]);
    const c = client(fetch);
    await c.inboxes.messages.get("scout@wzrd.tech", "msg_1");
    await c.inboxes.threads.get("scout@wzrd.tech", "thread_1");
    await c.inboxes.threads.list("scout@wzrd.tech", { limit: 10 });
    expect(calls[0]?.url.pathname).toBe("/v0/inboxes/scout%40wzrd.tech/messages/msg_1");
    expect(calls[1]?.url.pathname).toBe("/v0/inboxes/scout%40wzrd.tech/threads/thread_1");
    expect(calls[2]?.url.pathname).toBe("/v0/inboxes/scout%40wzrd.tech/threads");
    expect(calls[2]?.url.searchParams.get("limit")).toBe("10");
  });

  it("manages webhooks", async () => {
    const { fetch, calls } = mockFetch([{ status: 200, body: { webhooks: [] } }]);
    const c = client(fetch);
    await c.webhooks.create({ url: "https://example.com/hook", event_types: ["message.received"] });
    await c.webhooks.list();
    await c.webhooks.delete("wh_1");
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url.pathname).toBe("/v0/webhooks");
    expect(calls[0]?.body).toEqual({
      url: "https://example.com/hook",
      event_types: ["message.received"]
    });
    expect(calls[1]?.method).toBe("GET");
    expect(calls[2]?.method).toBe("DELETE");
    expect(calls[2]?.url.pathname).toBe("/v0/webhooks/wh_1");
  });

  it("agent sign-up needs no auth; verify sends the bearer key", async () => {
    const { fetch, calls } = mockFetch([
      {
        status: 200,
        body: { api_key: "wm_live_x", inbox_id: "scout@wzrd.tech", organization_id: "org_1" }
      }
    ]);
    const anonymous = client(fetch, null);
    const res = await anonymous.agent.signUp({
      human_email: "dev@example.com",
      username: "scout"
    });
    expect(res.api_key).toBe("wm_live_x");
    expect(calls[0]?.url.pathname).toBe("/v0/agent/sign-up");
    expect(calls[0]?.headers["Authorization"]).toBeUndefined();

    await client(fetch).agent.verify({ otp_code: "482913" });
    expect(calls[1]?.url.pathname).toBe("/v0/agent/verify");
    expect(calls[1]?.headers["Authorization"]).toBe("Bearer wm_live_test");
    expect(calls[1]?.body).toEqual({ otp_code: "482913" });
  });

  it("rejects authenticated calls without an apiKey", async () => {
    const { fetch } = mockFetch([{ status: 200, body: {} }]);
    await expect(client(fetch, null).inboxes.list()).rejects.toThrow(/apiKey is required/);
  });

  it("manages domains", async () => {
    const { fetch, calls } = mockFetch([{ status: 200, body: { domains: [] } }]);
    const c = client(fetch);
    await c.domains.create({ domain: "mail.example.com" });
    await c.domains.list();
    await c.domains.verify("dom_1");
    expect(calls[0]?.url.pathname).toBe("/v0/domains");
    expect(calls[0]?.body).toEqual({ domain: "mail.example.com" });
    expect(calls[2]?.method).toBe("POST");
    expect(calls[2]?.url.pathname).toBe("/v0/domains/dom_1/verify");
  });

  it("throws WzrdmailError with the API error envelope on 4xx", async () => {
    const { fetch } = mockFetch([
      { status: 404, body: { name: "not_found", message: "inbox not found" } }
    ]);
    const err = await client(fetch)
      .inboxes.get("missing@wzrd.tech")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WzrdmailError);
    const typed = err as WzrdmailError;
    expect(typed.status).toBe(404);
    expect(typed.name).toBe("not_found");
    expect(typed.message).toBe("inbox not found");
    expect(typed.body).toEqual({ name: "not_found", message: "inbox not found" });
  });

  it("wraps malformed error bodies in an internal_error envelope", async () => {
    const { fetch } = mockFetch([{ status: 500, body: "boom" }]);
    const err = await client(fetch)
      .inboxes.list()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WzrdmailError);
    expect((err as WzrdmailError).name).toBe("internal_error");
    expect((err as WzrdmailError).status).toBe(500);
  });

  it("maps camelCase clientId to the client_id wire field", async () => {
    const { fetch, calls } = mockFetch([{ status: 200, body: inbox }]);
    const c = client(fetch);
    await c.inboxes.create({ clientId: "cid-camel" });
    await c.inboxes.messages.send("scout@wzrd.tech", {
      to: ["a@example.com"],
      subject: "s",
      clientId: "cid-msg"
    });
    expect(calls[0]?.body).toEqual({ client_id: "cid-camel" });
    expect(calls[1]?.body).toEqual({
      to: ["a@example.com"],
      subject: "s",
      client_id: "cid-msg"
    });
  });

  it("prefers explicit client_id over the clientId alias", async () => {
    const { fetch, calls } = mockFetch([{ status: 200, body: inbox }]);
    await client(fetch).inboxes.create({ client_id: "snake", clientId: "camel" });
    expect(calls[0]?.body).toEqual({ client_id: "snake" });
  });

  it("retries a 429 with an HTTP-date Retry-After", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-31T00:00:00Z"));
    try {
      const { fetch, calls } = mockFetch([
        {
          status: 429,
          body: { name: "rate_limited", message: "slow down" },
          headers: { "Retry-After": new Date("2026-08-31T00:00:02Z").toUTCString() }
        },
        { status: 200, body: { inboxes: [] } }
      ]);
      const promise = client(fetch).inboxes.list();
      await vi.advanceTimersByTimeAsync(2000);
      await promise;
      expect(calls.length).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls back to expo backoff when Retry-After is missing", async () => {
    vi.useFakeTimers();
    try {
      const { fetch, calls } = mockFetch([
        { status: 429, body: { name: "rate_limited", message: "slow down" } },
        { status: 200, body: { inboxes: [] } }
      ]);
      const promise = client(fetch).inboxes.list();
      await vi.advanceTimersByTimeAsync(499);
      expect(calls.length).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      await promise;
      expect(calls.length).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries 429 honoring Retry-After, then succeeds", async () => {
    vi.useFakeTimers();
    try {
      const { fetch, calls } = mockFetch([
        {
          status: 429,
          body: { name: "rate_limited", message: "slow down" },
          headers: { "Retry-After": "1" }
        },
        { status: 200, body: { inboxes: [] } }
      ]);
      const promise = client(fetch).inboxes.list();
      await vi.advanceTimersByTimeAsync(1000);
      const page = await promise;
      expect(calls.length).toBe(2);
      expect(page.inboxes).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up on 429 after max retries and throws rate_limited", async () => {
    vi.useFakeTimers();
    try {
      const { fetch, calls } = mockFetch([
        {
          status: 429,
          body: { name: "rate_limited", message: "slow down" },
          headers: { "Retry-After": "0" }
        }
      ]);
      const promise = client(fetch)
        .inboxes.list()
        .catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(10_000);
      const err = await promise;
      expect(err).toBeInstanceOf(WzrdmailError);
      expect((err as WzrdmailError).name).toBe("rate_limited");
      expect(calls.length).toBe(4); // initial + 3 retries
    } finally {
      vi.useRealTimers();
    }
  });

  it("deletes inboxes", async () => {
    const { fetch, calls } = mockFetch([{ status: 204 }]);
    await client(fetch).inboxes.delete("scout@wzrd.tech");
    expect(calls[0]?.method).toBe("DELETE");
    expect(calls[0]?.url.pathname).toBe("/v0/inboxes/scout%40wzrd.tech");
  });

  it("replies, replies-all, and forwards messages", async () => {
    const { fetch, calls } = mockFetch([{ status: 200, body: {} }]);
    const c = client(fetch);
    await c.inboxes.messages.reply("i@wzrd.tech", "msg_1", { text: "re" });
    await c.inboxes.messages.replyAll("i@wzrd.tech", "msg_1", { text: "re-all" });
    await c.inboxes.messages.forward("i@wzrd.tech", "msg_1", {
      to: ["x@y.com"]
    });
    expect(calls.map((c2) => c2.url.pathname)).toEqual([
      "/v0/inboxes/i%40wzrd.tech/messages/msg_1/reply",
      "/v0/inboxes/i%40wzrd.tech/messages/msg_1/reply-all",
      "/v0/inboxes/i%40wzrd.tech/messages/msg_1/forward"
    ]);
    expect(calls[2]?.body).toEqual({ to: ["x@y.com"] });
  });

  it("updates message labels/read via PATCH", async () => {
    const { fetch, calls } = mockFetch([{ status: 200, body: {} }]);
    await client(fetch).inboxes.messages.update("i@wzrd.tech", "msg_1", {
      labels: ["read"],
      read: true
    });
    expect(calls[0]?.method).toBe("PATCH");
    expect(calls[0]?.body).toEqual({ labels: ["read"], read: true });
  });

  it("searches threads with a query", async () => {
    const { fetch, calls } = mockFetch([{ status: 200, body: { threads: [] } }]);
    await client(fetch).inboxes.threads.search("i@wzrd.tech", {
      query: "invoice",
      limit: 10
    });
    expect(calls[0]?.url.pathname).toBe("/v0/inboxes/i%40wzrd.tech/threads/search");
    expect(calls[0]?.url.searchParams.get("query")).toBe("invoice");
    expect(calls[0]?.url.searchParams.get("limit")).toBe("10");
  });

  it("supports the draft lifecycle", async () => {
    const { fetch, calls } = mockFetch([{ status: 200, body: {} }]);
    const c = client(fetch);
    await c.inboxes.drafts.list("i@wzrd.tech");
    await c.inboxes.drafts.create("i@wzrd.tech", { to: ["x@y.com"], text: "hi" });
    await c.inboxes.drafts.update("i@wzrd.tech", "draft_1", { subject: "s" });
    await c.inboxes.drafts.send("i@wzrd.tech", "draft_1");
    await c.inboxes.drafts.delete("i@wzrd.tech", "draft_1");
    expect(calls.map((c2) => `${c2.method} ${c2.url.pathname}`)).toEqual([
      "GET /v0/inboxes/i%40wzrd.tech/drafts",
      "POST /v0/inboxes/i%40wzrd.tech/drafts",
      "PATCH /v0/inboxes/i%40wzrd.tech/drafts/draft_1",
      "POST /v0/inboxes/i%40wzrd.tech/drafts/draft_1/send",
      "DELETE /v0/inboxes/i%40wzrd.tech/drafts/draft_1"
    ]);
  });

  it("lists/creates/deletes pods and api keys", async () => {
    const { fetch, calls } = mockFetch([{ status: 200, body: {} }]);
    const c = client(fetch);
    await c.pods.list();
    await c.pods.create({ name: "prod" });
    await c.pods.delete("pod_1");
    await c.apiKeys.list();
    await c.apiKeys.create({ name: "ci", pod_id: "pod_1" });
    await c.apiKeys.delete("key_1");
    expect(calls.map((c2) => `${c2.method} ${c2.url.pathname}`)).toEqual([
      "GET /v0/pods",
      "POST /v0/pods",
      "DELETE /v0/pods/pod_1",
      "GET /v0/api-keys",
      "POST /v0/api-keys",
      "DELETE /v0/api-keys/key_1"
    ]);
  });

  it("exposes auth.me and metrics.usage", async () => {
    const { fetch, calls } = mockFetch([{ status: 200, body: {} }]);
    const c = client(fetch);
    await c.auth.me();
    await c.metrics.usage({ month: "2026-08" });
    expect(calls[0]?.url.pathname).toBe("/v0/auth/me");
    expect(calls[1]?.url.pathname).toBe("/v0/metrics/usage");
    expect(calls[1]?.url.searchParams.get("month")).toBe("2026-08");
  });
});
