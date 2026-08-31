import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeEach, describe, expect, it } from "vitest";

import { ApiClient } from "../src/api.js";
import { buildServer } from "../src/server.js";

interface Recorded {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: unknown;
}

class FakeApi {
  requests: Recorded[] = [];
  responses: Response[] = [];

  fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(init?.headers ?? {})) {
      headers[key.toLowerCase()] = value;
    }
    this.requests.push({
      method: init?.method ?? "GET",
      url: new URL(input),
      headers,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined
    });
    return this.responses.shift() ?? Response.json({});
  };

  get last(): Recorded {
    const request = this.requests[this.requests.length - 1];
    if (request === undefined) throw new Error("no requests recorded");
    return request;
  }
}

const EXPECTED_TOOLS = [
  "list_inboxes",
  "create_inbox",
  "get_inbox",
  "list_messages",
  "get_message",
  "send_message",
  "reply_to_message",
  "reply_all_to_message",
  "forward_message",
  "update_message",
  "list_threads",
  "get_thread",
  "search_threads",
  "list_drafts",
  "create_draft",
  "update_draft",
  "send_draft",
  "get_attachment",
  "list_webhooks",
  "create_webhook",
  "list_domains",
  "get_usage"
];

describe("wzrdmail MCP server", () => {
  let fake: FakeApi;
  let client: Client;

  beforeEach(async () => {
    fake = new FakeApi();
    const api = new ApiClient({
      apiKey: "wm_live_test",
      baseUrl: "https://api.example.com",
      fetchImpl: fake.fetchImpl
    });
    const server = buildServer(api);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "test", version: "0.0.0" });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  });

  it("exposes the full §9 toolset", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([...EXPECTED_TOOLS].sort());
    for (const tool of tools) {
      expect(tool.description).toBeTruthy();
    }
  });

  it("exposes quickstart and llms.txt resources", async () => {
    const { resources } = await client.listResources();
    expect(resources.map((resource) => resource.uri).sort()).toEqual([
      "wzrdmail://docs/llms.txt",
      "wzrdmail://docs/quickstart"
    ]);
    const quickstart = await client.readResource({ uri: "wzrdmail://docs/quickstart" });
    const first = quickstart.contents[0];
    if (first === undefined || !("text" in first)) throw new Error("expected text content");
    expect(first.text).toContain("agent/sign-up");
  });

  it("list_inboxes hits GET /v0/inboxes with Bearer auth and pagination", async () => {
    fake.responses.push(Response.json({ inboxes: [], next_page_token: "tok2" }));
    const result = await client.callTool({
      name: "list_inboxes",
      arguments: { limit: 5, page_token: "tok1" }
    });
    expect(fake.last.method).toBe("GET");
    expect(fake.last.url.pathname).toBe("/v0/inboxes");
    expect(fake.last.url.searchParams.get("limit")).toBe("5");
    expect(fake.last.url.searchParams.get("page_token")).toBe("tok1");
    expect(fake.last.headers["authorization"]).toBe("Bearer wm_live_test");
    const content = result.content as { type: string; text: string }[];
    expect(JSON.parse(content[0]?.text ?? "")).toEqual({ inboxes: [], next_page_token: "tok2" });
  });

  it("send_message posts the §7 body to /messages/send", async () => {
    fake.responses.push(Response.json({ message_id: "msg_1", inbox_id: "scout@wzrd.tech" }));
    await client.callTool({
      name: "send_message",
      arguments: {
        inbox_id: "scout@wzrd.tech",
        to: ["human@gmail.com"],
        subject: "hi",
        text: "hello"
      }
    });
    expect(fake.last.method).toBe("POST");
    expect(fake.last.url.pathname).toBe("/v0/inboxes/scout%40wzrd.tech/messages/send");
    expect(fake.last.body).toEqual({ to: ["human@gmail.com"], subject: "hi", text: "hello" });
  });

  it("reply_to_message posts to the reply endpoint", async () => {
    fake.responses.push(Response.json({ message_id: "msg_2" }));
    await client.callTool({
      name: "reply_to_message",
      arguments: { inbox_id: "scout@wzrd.tech", message_id: "msg_1", text: "thanks" }
    });
    expect(fake.last.method).toBe("POST");
    expect(fake.last.url.pathname).toBe(
      "/v0/inboxes/scout%40wzrd.tech/messages/msg_1/reply"
    );
    expect(fake.last.body).toEqual({ text: "thanks" });
  });

  it("list_messages comma-joins labels", async () => {
    fake.responses.push(Response.json({ messages: [] }));
    await client.callTool({
      name: "list_messages",
      arguments: { inbox_id: "scout@wzrd.tech", labels: ["inbox", "unread"] }
    });
    expect(fake.last.url.searchParams.get("labels")).toBe("inbox,unread");
  });

  it("update_message PATCHes labels", async () => {
    fake.responses.push(Response.json({ message_id: "msg_1" }));
    await client.callTool({
      name: "update_message",
      arguments: {
        inbox_id: "scout@wzrd.tech",
        message_id: "msg_1",
        add_labels: ["read"]
      }
    });
    expect(fake.last.method).toBe("PATCH");
    expect(fake.last.body).toEqual({ add_labels: ["read"] });
  });

  it("search_threads passes the query param", async () => {
    fake.responses.push(Response.json({ threads: [] }));
    await client.callTool({
      name: "search_threads",
      arguments: { inbox_id: "scout@wzrd.tech", query: "invoice" }
    });
    expect(fake.last.url.pathname).toBe("/v0/inboxes/scout%40wzrd.tech/threads/search");
    expect(fake.last.url.searchParams.get("query")).toBe("invoice");
  });

  it("draft lifecycle tools hit the §7 draft endpoints", async () => {
    fake.responses.push(
      Response.json({ draft_id: "draft_1" }),
      Response.json({ draft_id: "draft_1" }),
      Response.json({ message_id: "msg_9" })
    );
    await client.callTool({
      name: "create_draft",
      arguments: { inbox_id: "scout@wzrd.tech", to: ["a@b.co"], subject: "s" }
    });
    await client.callTool({
      name: "update_draft",
      arguments: { inbox_id: "scout@wzrd.tech", draft_id: "draft_1", text: "v2" }
    });
    await client.callTool({
      name: "send_draft",
      arguments: { inbox_id: "scout@wzrd.tech", draft_id: "draft_1" }
    });
    expect(fake.requests[0]?.url.pathname).toBe("/v0/inboxes/scout%40wzrd.tech/drafts");
    expect(fake.requests[1]?.method).toBe("PATCH");
    expect(fake.requests[1]?.url.pathname).toBe("/v0/inboxes/scout%40wzrd.tech/drafts/draft_1");
    expect(fake.requests[2]?.url.pathname).toBe(
      "/v0/inboxes/scout%40wzrd.tech/drafts/draft_1/send"
    );
  });

  it("maps API error envelopes to isError results", async () => {
    fake.responses.push(
      Response.json({ name: "forbidden", message: "verify your account" }, { status: 403 })
    );
    const result = await client.callTool({
      name: "get_inbox",
      arguments: { inbox_id: "scout@wzrd.tech" }
    });
    expect(result.isError).toBe(true);
    const content = result.content as { type: string; text: string }[];
    expect(JSON.parse(content[0]?.text ?? "")).toEqual({
      error: { name: "forbidden", message: "verify your account" },
      status: 403
    });
  });

  it("get_usage hits /v0/metrics/usage", async () => {
    fake.responses.push(Response.json({ usage: [] }));
    await client.callTool({ name: "get_usage", arguments: { month: "2026-08" } });
    expect(fake.last.url.pathname).toBe("/v0/metrics/usage");
    expect(fake.last.url.searchParams.get("month")).toBe("2026-08");
  });
});
