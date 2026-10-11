import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  OpenAISettingsReadResultSchema,
  OpenAIUiResourceMetadataSchema,
  OpenAIUiToolMetadataSchema
} from "@openai/mcp-extensions/server";
import { beforeEach, describe, expect, it } from "vitest";

import { ApiClient } from "../src/api.js";
import {
  MAILBOX_RESOURCE_URI,
  MESSAGE_RESOURCE_URI
} from "../src/extensions.js";
import { buildServer } from "../src/server.js";

class FakeApi {
  requests: { method: string; url: URL }[] = [];
  responses: Response[] = [];

  fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
    this.requests.push({ method: init?.method ?? "GET", url: new URL(input) });
    return this.responses.shift() ?? Response.json({});
  };

  get last(): { method: string; url: URL } {
    const request = this.requests[this.requests.length - 1];
    if (request === undefined) throw new Error("no requests recorded");
    return request;
  }
}

const meta = (record: unknown): Record<string, unknown> => {
  if (typeof record !== "object" || record === null) throw new Error("no _meta");
  return record as Record<string, unknown>;
};

describe("openai MCP extensions", () => {
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

  it("points mail tools at ui:// app resources via ui.resourceUri", async () => {
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((tool) => [tool.name, tool]));

    for (const name of ["list_inboxes", "list_messages", "list_drafts"]) {
      expect(meta(byName.get(name)?._meta)).toMatchObject({
        ui: { resourceUri: MAILBOX_RESOURCE_URI }
      });
    }
    for (const name of [
      "get_message",
      "send_message",
      "reply_to_message",
      "create_draft",
      "send_draft"
    ]) {
      expect(meta(byName.get(name)?._meta)).toMatchObject({
        ui: { resourceUri: MESSAGE_RESOURCE_URI }
      });
    }

    // Tools without a UI surface stay plain _meta-less MCP tools.
    expect(byName.get("list_threads")?._meta?.["ui"]).toBeUndefined();
    expect(byName.get("list_domains")?._meta?.["ui"]).toBeUndefined();
  });

  it("registers global and thread entrypoints per the openai/ui spec", async () => {
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((tool) => [tool.name, tool]));

    const mailbox = meta(byName.get("open_mailbox")?._meta);
    const mailboxMeta = OpenAIUiToolMetadataSchema.parse(mailbox["openai/ui"]);
    expect(mailboxMeta.entrypoints).toEqual([{ type: "global" }]);
    expect(mailbox["ui"]).toMatchObject({ resourceUri: MAILBOX_RESOURCE_URI });
    expect(byName.get("open_mailbox")?.annotations?.readOnlyHint).toBe(true);

    const message = meta(byName.get("open_message")?._meta);
    const messageMeta = OpenAIUiToolMetadataSchema.parse(message["openai/ui"]);
    expect(messageMeta.entrypoints).toEqual([{ type: "thread" }]);
    expect(message["ui"]).toMatchObject({ resourceUri: MESSAGE_RESOURCE_URI });
  });

  it("serves the ui:// resources as self-contained mcp-app HTML", async () => {
    const { resources } = await client.listResources();
    const uris = resources.map((resource) => resource.uri);
    expect(uris).toContain(MAILBOX_RESOURCE_URI);
    expect(uris).toContain(MESSAGE_RESOURCE_URI);
    for (const resource of resources.filter((r) => r.uri.startsWith("ui://"))) {
      expect(resource.mimeType).toBe("text/html;profile=mcp-app");
    }

    for (const [uri, surface] of [
      [MAILBOX_RESOURCE_URI, "mailbox"],
      [MESSAGE_RESOURCE_URI, "message"]
    ] as const) {
      const read = await client.readResource({ uri });
      const content = read.contents[0];
      if (content === undefined || !("text" in content)) {
        throw new Error("expected text content");
      }
      expect(content.mimeType).toBe("text/html;profile=mcp-app");
      expect(content.text).toContain(`data-surface="${surface}"`);
      expect(content.text).toContain("<script>");
      // Sandboxed: no external fetches — the bundle must be fully inline.
      expect(content.text).not.toMatch(/src="https?:|href="https?:/);
      OpenAIUiResourceMetadataSchema.parse(meta(content._meta)["openai/ui"]);
    }
  });

  it("advertises and serves the openai/settings capability", async () => {
    const capabilities = client.getServerCapabilities() as Record<string, unknown>;
    for (const bucket of ["extensions", "experimental"]) {
      const bag = capabilities[bucket] as Record<string, unknown> | undefined;
      expect(bag?.["openai/settings"]).toMatchObject({
        readTool: "settings.read",
        updateTool: "settings.update"
      });
    }

    const read = await client.callTool({ name: "settings.read", arguments: {} });
    OpenAISettingsReadResultSchema.parse(read.structuredContent);
    const first = read.structuredContent as {
      schema: { type: string; properties?: Record<string, unknown> };
      values: Record<string, unknown>;
      layout?: unknown[];
    };
    expect(first.schema.type).toBe("object");
    expect(first.schema.properties).toHaveProperty("confirm_send");
    expect(first.values).toMatchObject({
      default_inbox: "",
      messages_per_page: 25,
      confirm_send: true
    });
    expect(first.layout).toBeDefined();

    const updated = await client.callTool({
      name: "settings.update",
      arguments: { set: { confirm_send: false, messages_per_page: 5 } }
    });
    expect(updated.structuredContent).toMatchObject({
      values: { confirm_send: false, messages_per_page: 5 }
    });

    const reread = await client.callTool({ name: "settings.read", arguments: {} });
    expect(reread.structuredContent).toMatchObject({
      values: { confirm_send: false, messages_per_page: 5 }
    });
  });

  it("open_mailbox lists inboxes and returns app-visible JSON", async () => {
    fake.responses.push(Response.json({ inboxes: [{ inbox_id: "scout@wzrd.tech" }] }));
    const result = await client.callTool({ name: "open_mailbox", arguments: {} });
    expect(fake.last.method).toBe("GET");
    expect(fake.last.url.pathname).toBe("/v0/inboxes");
    const content = result.content as { type: string; text: string }[];
    expect(JSON.parse(content[0]?.text ?? "")).toEqual({
      inboxes: [{ inbox_id: "scout@wzrd.tech" }]
    });
  });
});
