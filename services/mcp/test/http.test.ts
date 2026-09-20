import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

/**
 * HTTP-path tests for the Worker entry (muse.md §9 MU1).
 *
 * These run in workerd through @cloudflare/vitest-pool-workers, so they
 * exercise src/index.ts, the CORS wrapper and the Durable Object session
 * bridge that the InMemoryTransport suite in server.test.ts cannot reach.
 */

const MCP = "http://localhost:8788/mcp";
const KEY = "wm_live_000102030405060708090a0b0c0d0e0f101112131415161718191a1b";

const initialize = (id = 1) =>
  JSON.stringify({
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "pin", version: "0" }
    }
  });

describe("worker entry", () => {
  it("serves /health without a credential", async () => {
    const res = await SELF.fetch("http://localhost:8788/health");
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
  });

  it("404s any path other than /mcp", async () => {
    const res = await SELF.fetch("http://localhost:8788/nope");
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({ name: "not_found" });
  });

  it("answers OPTIONS with CORS headers", async () => {
    const res = await SELF.fetch(MCP, { method: "OPTIONS" });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("401s a credential-less POST with an RFC 9728 challenge and an envelope", async () => {
    const res = await SELF.fetch(MCP, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: initialize()
    });
    expect(res.status).toBe(401);

    // The challenge is how a client discovers where to authorize, and the
    // scope list is what a client that registers without one reads back.
    const challenge = res.headers.get("www-authenticate") ?? "";
    expect(challenge).toContain("Bearer");
    expect(challenge).toContain(
      'resource_metadata="http://localhost:8788/.well-known/oauth-protected-resource/mcp"'
    );
    expect(challenge).toContain('scope="mail:read mail:drafts mail:send"');

    await expect(res.json()).resolves.toMatchObject({ name: "unauthorized" });
  });

  it("publishes protected-resource metadata pointing at this server", async () => {
    const res = await SELF.fetch(
      "http://localhost:8788/.well-known/oauth-protected-resource/mcp"
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      resource: string;
      authorization_servers: string[];
      scopes_supported: string[];
    };
    expect(body.resource).toBe("http://localhost:8788/mcp");
    expect(body.authorization_servers).toContain("http://localhost:8788");
    expect(body.scopes_supported).toEqual(["mail:read", "mail:drafts", "mail:send"]);
  });

  it("advertises PKCE S256 and dynamic registration in authorization-server metadata", async () => {
    const res = await SELF.fetch(
      "http://localhost:8788/.well-known/oauth-authorization-server"
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      code_challenge_methods_supported: string[];
      registration_endpoint: string;
      authorization_endpoint: string;
      token_endpoint: string;
    };
    expect(body.code_challenge_methods_supported).toContain("S256");
    expect(body.registration_endpoint).toBe("http://localhost:8788/register");
    expect(body.authorization_endpoint).toBe("http://localhost:8788/authorize");
    expect(body.token_endpoint).toBe("http://localhost:8788/token");
  });
});

describe("streaming lane", () => {
  it("still answers a both-Accept initialize with SSE and a session id", async () => {
    const res = await SELF.fetch(MCP, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "x-api-key": KEY
      },
      body: initialize()
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.headers.get("mcp-session-id")).toBeTruthy();
    const body = await res.text();
    expect(body).toContain('"protocolVersion":"2025-06-18"');
  });

  it("routes a both-Accept POST to JSON when the escape-hatch header is set", async () => {
    const res = await SELF.fetch(MCP, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-response-mode": "json",
        "x-api-key": KEY
      },
      body: initialize()
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
  });
});

describe("json lane", () => {
  it("answers initialize as JSON with no session id when Accept omits event-stream", async () => {
    const res = await SELF.fetch(MCP, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "x-api-key": KEY
      },
      body: initialize()
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("mcp-session-id")).toBeNull();
    const body = (await res.json()) as {
      result: { protocolVersion: string; serverInfo: { name: string } };
    };
    expect(body.result.protocolVersion).toBe("2025-06-18");
    expect(body.result.serverInfo.name).toBe("wzrdmail");
  });

  it("answers initialize as JSON when there is no Accept header at all", async () => {
    const res = await SELF.fetch(MCP, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": KEY },
      body: initialize()
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("mcp-session-id")).toBeNull();
  });

  it("lists the full toolset without a prior initialize or a session id", async () => {
    const res = await SELF.fetch(MCP, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "x-api-key": KEY
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { tools: { name: string; annotations?: unknown }[] } };
    const names = body.result.tools.map((t) => t.name);
    expect(names).toHaveLength(24);
    expect(names).toContain("whoami");
    expect(names).toContain("check_new_mail");
  });

  it("carries annotations so a consumer agent knows what is destructive", async () => {
    const res = await SELF.fetch(MCP, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "x-api-key": KEY
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} })
    });
    const body = (await res.json()) as {
      result: { tools: { name: string; annotations?: Record<string, unknown> }[] };
    };
    const byName = new Map(body.result.tools.map((t) => [t.name, t.annotations]));
    expect(byName.get("list_inboxes")).toMatchObject({ readOnlyHint: true });
    expect(byName.get("send_message")).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true
    });
  });
});
