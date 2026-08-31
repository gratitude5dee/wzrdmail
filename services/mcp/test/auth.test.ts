import { WzrdmailError } from "wzrdmail";
import { describe, expect, it } from "vitest";

import { ApiClient } from "../src/api.js";
import { extractApiKey, sessionKeyGuard } from "../src/auth.js";

const req = (headers: Record<string, string>): Request =>
  new Request("https://mcp.wzrd.tech/mcp", { method: "POST", headers });

describe("extractApiKey", () => {
  it("reads x-api-key", () => {
    expect(extractApiKey(req({ "x-api-key": "wm_1" }))).toBe("wm_1");
  });

  it("reads Bearer tokens", () => {
    expect(extractApiKey(req({ authorization: "Bearer wm_2" }))).toBe("wm_2");
  });

  it("rejects empty x-api-key and empty Bearer credentials", () => {
    expect(extractApiKey(req({ "x-api-key": "  " }))).toBeNull();
    expect(extractApiKey(req({ authorization: "Bearer " }))).toBeNull();
    expect(extractApiKey(req({ authorization: "Bearer    " }))).toBeNull();
    expect(extractApiKey(req({}))).toBeNull();
  });
});

describe("sessionKeyGuard", () => {
  it("passes when the presented key matches the bound key", () => {
    expect(sessionKeyGuard(req({ "x-api-key": "wm_owner" }), "wm_owner")).toBeNull();
    expect(
      sessionKeyGuard(req({ authorization: "Bearer wm_owner" }), "wm_owner")
    ).toBeNull();
  });

  it("rejects a different valid key presented against a stolen session", async () => {
    const rejection = sessionKeyGuard(req({ "x-api-key": "wm_attacker" }), "wm_owner");
    expect(rejection?.status).toBe(401);
    const body = (await rejection?.json()) as { name: string };
    expect(body.name).toBe("unauthorized");
  });

  it("rejects missing credentials and an unbound session", () => {
    expect(sessionKeyGuard(req({}), "wm_owner")?.status).toBe(401);
    expect(sessionKeyGuard(req({ "x-api-key": "wm_owner" }), undefined)?.status).toBe(
      401
    );
  });
});

describe("ApiClient with a key provider", () => {
  it("resolves the key per request", async () => {
    let key = "wm_first";
    const seen: string[] = [];
    const api = new ApiClient({
      apiKey: () => key,
      baseUrl: "https://api.example.com",
      fetchImpl: async (_input, init) => {
        const headers = init?.headers as Record<string, string>;
        seen.push(headers["Authorization"] ?? "");
        return Response.json({});
      }
    });
    await api.request({ method: "GET", path: "/v0/inboxes" });
    key = "wm_second";
    await api.request({ method: "GET", path: "/v0/inboxes" });
    expect(seen).toEqual(["Bearer wm_first", "Bearer wm_second"]);
  });

  it("propagates provider errors without issuing a request", async () => {
    let called = false;
    const api = new ApiClient({
      apiKey: () => {
        throw new WzrdmailError(401, { name: "unauthorized", message: "key mismatch" });
      },
      baseUrl: "https://api.example.com",
      fetchImpl: async () => {
        called = true;
        return Response.json({});
      }
    });
    await expect(api.request({ method: "GET", path: "/v0/inboxes" })).rejects.toThrow(
      "key mismatch"
    );
    expect(called).toBe(false);
  });
});
