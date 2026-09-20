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

  it("401s a credential-less POST", async () => {
    const res = await SELF.fetch(MCP, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: initialize()
    });
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toMatchObject({ name: "unauthorized" });
  });
});

describe("streamable-http lane (pinned pre-change behaviour)", () => {
  it("answers initialize with an SSE body and a session id", async () => {
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
    expect(body).toContain('"name":"wzrdmail"');
  });

  it("406s a POST whose Accept omits text/event-stream", async () => {
    const res = await SELF.fetch(MCP, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "x-api-key": KEY
      },
      body: initialize()
    });
    expect(res.status).toBe(406);
  });

  it("406s a POST with no Accept header at all", async () => {
    const res = await SELF.fetch(MCP, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": KEY },
      body: initialize()
    });
    expect(res.status).toBe(406);
  });
});
