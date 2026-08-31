import { describe, expect, it } from "vitest";
import type { FetchLike } from "wzrdmail";
import { EXIT_AUTH, EXIT_ERROR, EXIT_LIMIT, EXIT_OK, run } from "../src/run.js";

interface Captured {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
}

interface Harness {
  fetch: FetchLike;
  calls: Captured[];
  stdout: string[];
  stderr: string[];
  io: (env?: Record<string, string>) => {
    env: Record<string, string | undefined>;
    stdout: (line: string) => void;
    stderr: (line: string) => void;
    fetch: FetchLike;
  };
}

function harness(
  responses: Array<{ status: number; body?: unknown; headers?: Record<string, string> }>
): Harness {
  const calls: Captured[] = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
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
  return {
    fetch,
    calls,
    stdout,
    stderr,
    io: (env = { WZRDMAIL_API_KEY: "wm_live_test" }) => ({
      env,
      stdout: (line: string) => stdout.push(line),
      stderr: (line: string) => stderr.push(line),
      fetch
    })
  };
}

const inbox = {
  inbox_id: "scout@wzrd.tech",
  organization_id: "org_1",
  pod_id: "pod_1",
  username: "scout",
  domain: "wzrd.tech",
  display_name: "Scout",
  created_at: "2026-08-31T00:00:00Z",
  updated_at: "2026-08-31T00:00:00Z"
};

describe("wzrdmail CLI", () => {
  it("prints help with exit 0 when no command given", async () => {
    const h = harness([]);
    const code = await run([], h.io());
    expect(code).toBe(EXIT_OK);
    expect(h.stdout.join("\n")).toContain("Usage: wzrdmail");
    expect(h.calls.length).toBe(0);
  });

  it("inboxes list --format json emits machine-clean JSON", async () => {
    const h = harness([
      { status: 200, body: { inboxes: [inbox], next_page_token: "tok" } }
    ]);
    const code = await run(["--format", "json", "inboxes", "list"], h.io());
    expect(code).toBe(EXIT_OK);
    expect(h.calls[0]?.url.pathname).toBe("/v0/inboxes");
    expect(h.calls[0]?.headers["Authorization"]).toBe("Bearer wm_live_test");
    const parsed = JSON.parse(h.stdout.join("\n")) as {
      inboxes: unknown[];
      next_page_token: string;
    };
    expect(parsed.inboxes).toEqual([inbox]);
    expect(parsed.next_page_token).toBe("tok");
    expect(h.stderr).toEqual([]);
  });

  it("inboxes list renders a human table by default", async () => {
    const h = harness([{ status: 200, body: { inboxes: [inbox] } }]);
    const code = await run(["inboxes", "list"], h.io());
    expect(code).toBe(EXIT_OK);
    const out = h.stdout.join("\n");
    expect(out).toContain("INBOX_ID");
    expect(out).toContain("scout@wzrd.tech");
    expect(() => JSON.parse(out)).toThrow();
  });

  it("respects WZRDMAIL_BASE_URL", async () => {
    const h = harness([{ status: 200, body: { inboxes: [] } }]);
    const code = await run(["inboxes", "list"], h.io({
      WZRDMAIL_API_KEY: "wm_live_test",
      WZRDMAIL_BASE_URL: "http://localhost:8787"
    }));
    expect(code).toBe(EXIT_OK);
    expect(h.calls[0]?.url.origin).toBe("http://localhost:8787");
  });

  it("inboxes create passes snake_case flags through", async () => {
    const h = harness([{ status: 200, body: inbox }]);
    const code = await run(
      [
        "inboxes",
        "create",
        "--username",
        "scout",
        "--display-name",
        "Scout",
        "--client-id",
        "cid-1",
        "--format=json"
      ],
      h.io()
    );
    expect(code).toBe(EXIT_OK);
    expect(h.calls[0]?.method).toBe("POST");
    expect(h.calls[0]?.body).toEqual({
      username: "scout",
      display_name: "Scout",
      client_id: "cid-1"
    });
  });

  it("inboxes get requires an inbox id", async () => {
    const h = harness([]);
    const code = await run(["inboxes", "get"], h.io());
    expect(code).toBe(EXIT_ERROR);
    expect(h.stderr.join("\n")).toContain("inboxes get <inbox_id>");
  });

  it("messages send builds the send body and encodes the inbox id", async () => {
    const h = harness([{ status: 200, body: { message_id: "msg_1" } }]);
    const code = await run(
      [
        "messages",
        "send",
        "scout@wzrd.tech",
        "--to",
        "a@example.com,b@example.com",
        "--subject",
        "Hi",
        "--text",
        "Hello"
      ],
      h.io()
    );
    expect(code).toBe(EXIT_OK);
    expect(h.calls[0]?.url.pathname).toBe(
      "/v0/inboxes/scout%40wzrd.tech/messages/send"
    );
    expect(h.calls[0]?.body).toEqual({
      to: ["a@example.com", "b@example.com"],
      subject: "Hi",
      text: "Hello"
    });
  });

  it("messages send without --to is a usage error", async () => {
    const h = harness([]);
    const code = await run(
      ["--format", "json", "messages", "send", "scout@wzrd.tech"],
      h.io()
    );
    expect(code).toBe(EXIT_ERROR);
    const err = JSON.parse(h.stderr.join("\n")) as { name: string; message: string };
    expect(err.name).toBe("cli_error");
    expect(err.message).toContain("--to is required");
    expect(h.stdout).toEqual([]);
  });

  it("messages list forwards filters", async () => {
    const h = harness([{ status: 200, body: { messages: [] } }]);
    const code = await run(
      ["messages", "list", "scout@wzrd.tech", "--labels", "unread", "--limit", "5"],
      h.io()
    );
    expect(code).toBe(EXIT_OK);
    expect(h.calls[0]?.url.searchParams.get("labels")).toBe("unread");
    expect(h.calls[0]?.url.searchParams.get("limit")).toBe("5");
  });

  it("threads list and get hit the right paths", async () => {
    const h = harness([{ status: 200, body: { threads: [] } }]);
    await run(["threads", "list", "scout@wzrd.tech"], h.io());
    await run(["threads", "get", "scout@wzrd.tech", "thread_1"], h.io());
    expect(h.calls[0]?.url.pathname).toBe("/v0/inboxes/scout%40wzrd.tech/threads");
    expect(h.calls[1]?.url.pathname).toBe(
      "/v0/inboxes/scout%40wzrd.tech/threads/thread_1"
    );
  });

  it("agent sign-up works without an API key", async () => {
    const h = harness([
      {
        status: 200,
        body: { api_key: "wm_live_x", inbox_id: "scout@wzrd.tech", organization_id: "org_1" }
      }
    ]);
    const code = await run(
      [
        "--format",
        "json",
        "agent",
        "sign-up",
        "--human-email",
        "dev@example.com",
        "--username",
        "scout"
      ],
      h.io({})
    );
    expect(code).toBe(EXIT_OK);
    expect(h.calls[0]?.url.pathname).toBe("/v0/agent/sign-up");
    expect(h.calls[0]?.headers["Authorization"]).toBeUndefined();
    expect(h.calls[0]?.body).toEqual({
      human_email: "dev@example.com",
      username: "scout"
    });
  });

  it("agent verify posts the otp code", async () => {
    const h = harness([{ status: 200, body: { verified: true } }]);
    const code = await run(["agent", "verify", "--otp-code", "482913"], h.io());
    expect(code).toBe(EXIT_OK);
    expect(h.calls[0]?.url.pathname).toBe("/v0/agent/verify");
    expect(h.calls[0]?.body).toEqual({ otp_code: "482913" });
  });

  it("missing API key on an authed command exits 2", async () => {
    const h = harness([]);
    const code = await run(["inboxes", "list"], h.io({}));
    expect(code).toBe(EXIT_AUTH);
    expect(h.stderr.join("\n")).toContain("WZRDMAIL_API_KEY");
  });

  it("API 401 exits 2 with JSON error envelope on stderr", async () => {
    const h = harness([
      { status: 401, body: { name: "unauthorized", message: "bad key" } }
    ]);
    const code = await run(["--format", "json", "inboxes", "list"], h.io());
    expect(code).toBe(EXIT_AUTH);
    expect(JSON.parse(h.stderr.join("\n"))).toEqual({
      name: "unauthorized",
      message: "bad key"
    });
    expect(h.stdout).toEqual([]);
  });

  it("plan_limit_exceeded exits 3", async () => {
    const h = harness([
      {
        status: 403,
        body: { name: "plan_limit_exceeded", message: "upgrade" }
      }
    ]);
    const code = await run(["inboxes", "create"], h.io());
    expect(code).toBe(EXIT_LIMIT);
    expect(h.stderr.join("\n")).toContain("plan_limit_exceeded");
  });

  it("unsupported --format value is a usage error (exit 1)", async () => {
    const h = harness([]);
    const code = await run(["--format", "yaml", "inboxes", "list"], h.io());
    expect(code).toBe(EXIT_ERROR);
    expect(h.stderr.join("\n")).toContain('--format must be "table" or "json"');
    expect(h.calls.length).toBe(0);
  });

  it("valueless trailing --format is a usage error, not an uncaught throw", async () => {
    const h = harness([]);
    const code = await run(["inboxes", "list", "--format"], h.io());
    expect(code).toBe(EXIT_ERROR);
    expect(h.stderr.join("\n")).toContain('--format must be "table" or "json"');
  });

  it("unknown commands print usage and exit 1", async () => {
    const h = harness([]);
    const code = await run(["bogus"], h.io());
    expect(code).toBe(EXIT_ERROR);
    expect(h.stderr.join("\n")).toContain("unknown command: bogus");
  });

  it("inboxes delete issues DELETE and reports success", async () => {
    const h = harness([{ status: 204 }]);
    const code = await run(
      ["--format", "json", "inboxes", "delete", "scout@wzrd.tech"],
      h.io()
    );
    expect(code).toBe(EXIT_OK);
    expect(h.calls[0]?.method).toBe("DELETE");
    expect(h.calls[0]?.url.pathname).toBe("/v0/inboxes/scout%40wzrd.tech");
    expect(JSON.parse(h.stdout.join("\n"))).toEqual({
      deleted: true,
      inbox_id: "scout@wzrd.tech"
    });
  });

  it("messages reply / reply --all / forward hit the right endpoints", async () => {
    const h = harness([{ status: 200, body: {} }]);
    await run(["messages", "reply", "i@wzrd.tech", "msg_1", "--text", "re"], h.io());
    await run(
      ["messages", "reply", "i@wzrd.tech", "msg_1", "--text", "re", "--all"],
      h.io()
    );
    await run(
      ["messages", "forward", "i@wzrd.tech", "msg_1", "--to", "x@y.com"],
      h.io()
    );
    expect(h.calls.map((c) => c.url.pathname)).toEqual([
      "/v0/inboxes/i%40wzrd.tech/messages/msg_1/reply",
      "/v0/inboxes/i%40wzrd.tech/messages/msg_1/reply-all",
      "/v0/inboxes/i%40wzrd.tech/messages/msg_1/forward"
    ]);
    expect(h.calls[0]?.body).toEqual({ text: "re" });
    expect(h.calls[2]?.body).toEqual({ to: ["x@y.com"] });
  });

  it("threads search requires --query and passes it through", async () => {
    const h = harness([{ status: 200, body: { threads: [] } }]);
    const bad = await run(["threads", "search", "i@wzrd.tech"], h.io());
    expect(bad).toBe(EXIT_ERROR);
    const code = await run(
      ["threads", "search", "i@wzrd.tech", "--query", "invoice"],
      h.io()
    );
    expect(code).toBe(EXIT_OK);
    expect(h.calls[0]?.url.pathname).toBe("/v0/inboxes/i%40wzrd.tech/threads/search");
    expect(h.calls[0]?.url.searchParams.get("query")).toBe("invoice");
  });

  it("drafts list/create/send", async () => {
    const h = harness([{ status: 200, body: { drafts: [] } }]);
    await run(["drafts", "list", "i@wzrd.tech"], h.io());
    await run(
      ["drafts", "create", "i@wzrd.tech", "--to", "x@y.com", "--text", "hi"],
      h.io()
    );
    await run(["drafts", "send", "i@wzrd.tech", "draft_1"], h.io());
    expect(h.calls.map((c) => `${c.method} ${c.url.pathname}`)).toEqual([
      "GET /v0/inboxes/i%40wzrd.tech/drafts",
      "POST /v0/inboxes/i%40wzrd.tech/drafts",
      "POST /v0/inboxes/i%40wzrd.tech/drafts/draft_1/send"
    ]);
    expect(h.calls[1]?.body).toEqual({ to: ["x@y.com"], text: "hi" });
  });

  it("webhooks create validates flags and posts the body", async () => {
    const h = harness([{ status: 200, body: {} }]);
    const bad = await run(["webhooks", "create", "--url", "https://x.example"], h.io());
    expect(bad).toBe(EXIT_ERROR);
    const code = await run(
      [
        "webhooks",
        "create",
        "--url",
        "https://x.example",
        "--event-types",
        "message.received,message.sent"
      ],
      h.io()
    );
    expect(code).toBe(EXIT_OK);
    expect(h.calls[0]?.body).toEqual({
      url: "https://x.example",
      event_types: ["message.received", "message.sent"]
    });
  });

  it("webhooks test posts to the test endpoint", async () => {
    const h = harness([
      { status: 200, body: { webhook_id: "wh_1", delivered: true, status_code: 200 } }
    ]);
    const code = await run(["--format", "json", "webhooks", "test", "wh_1"], h.io());
    expect(code).toBe(EXIT_OK);
    expect(h.calls[0]?.method).toBe("POST");
    expect(h.calls[0]?.url.pathname).toBe("/v0/webhooks/wh_1/test");
    expect(JSON.parse(h.stdout.join("\n")).delivered).toBe(true);
  });

  it("domains records prints the dns_records table", async () => {
    const h = harness([
      {
        status: 200,
        body: {
          domain_id: "dom_1",
          domain: "acme.com",
          status: "pending",
          dns_records: [{ type: "MX", name: "acme.com", value: "mx.wzrd.tech" }],
          created_at: "2026-08-31T00:00:00Z",
          updated_at: "2026-08-31T00:00:00Z"
        }
      }
    ]);
    const code = await run(["domains", "records", "dom_1"], h.io());
    expect(code).toBe(EXIT_OK);
    expect(h.calls[0]?.url.pathname).toBe("/v0/domains/dom_1");
    expect(h.stdout.join("\n")).toContain("mx.wzrd.tech");
  });

  it("pods, keys, and usage map to their endpoints", async () => {
    const h = harness([
      { status: 200, body: { pods: [] } },
      { status: 200, body: {} },
      { status: 200, body: { api_keys: [] } },
      { status: 204 },
      { status: 200, body: { month: "2026-08", metrics: [] } }
    ]);
    await run(["pods", "list"], h.io());
    await run(["pods", "create", "--name", "prod"], h.io());
    await run(["keys", "list"], h.io());
    await run(["keys", "revoke", "key_1"], h.io());
    await run(["usage", "--month", "2026-08"], h.io());
    expect(h.calls.map((c) => `${c.method} ${c.url.pathname}`)).toEqual([
      "GET /v0/pods",
      "POST /v0/pods",
      "GET /v0/api-keys",
      "DELETE /v0/api-keys/key_1",
      "GET /v0/metrics/usage"
    ]);
    expect(h.calls[4]?.url.searchParams.get("month")).toBe("2026-08");
  });
});
