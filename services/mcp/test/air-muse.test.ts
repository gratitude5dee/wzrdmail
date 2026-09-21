import { describe, expect, it, vi } from "vitest";

import {
  isMuseDiscoveryPath,
  isWzrdmailRequest,
  museTarget,
  proxyMuse
} from "../src/air-muse.js";

const request = (headers: Record<string, string> = {}, path = "/mcp") =>
  new Request(`https://mcp.mail.wzrd.tech${path}?probe=1`, {
    method: "POST",
    headers,
    body: "{}"
  });

describe("Air × Muse proxy lane", () => {
  it("keeps explicit WZRDMail credentials on the WZRDMail toolset", () => {
    expect(isWzrdmailRequest(request({ "x-api-key": "wm_live_key" }))).toBe(true);
    expect(isWzrdmailRequest(request({ authorization: "Bearer wm_live_key" }))).toBe(true);
    expect(isWzrdmailRequest(request({
      "x-api-key": "wm_live_key",
      authorization: "Bearer air_oauth_token"
    }))).toBe(true);
  });

  it("sends anonymous and Air OAuth requests to the Air resource", () => {
    expect(isWzrdmailRequest(request())).toBe(false);
    expect(isWzrdmailRequest(request({ authorization: "Bearer air_oauth_token" }))).toBe(false);
    expect(museTarget(request({ authorization: "Bearer air_oauth_token" }))).toBe(
      "https://muse.wzrd.tech/mcp?probe=1"
    );
  });

  it("only exposes the Air discovery documents under the shared host", () => {
    expect(isMuseDiscoveryPath("/.well-known/mcp.json")).toBe(true);
    expect(isMuseDiscoveryPath("/.well-known/oauth-protected-resource/mcp")).toBe(true);
    expect(isMuseDiscoveryPath("/muse.md")).toBe(true);
    expect(isMuseDiscoveryPath("/.well-known/oauth-authorization-server")).toBe(false);
    expect(isMuseDiscoveryPath("/mcp")).toBe(false);
  });

  it("forwards the opaque bearer and request body only to the Air origin", async () => {
    let forwarded: Request | undefined;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      forwarded = input as Request;
      return Response.json({ ok: true });
    });
    const response = await proxyMuse(
      request({ authorization: "Bearer air_oauth_token", "content-type": "application/json" }),
      "https://muse.wzrd.tech",
      fetchImpl as typeof fetch
    );
    expect(response.status).toBe(200);
    expect(forwarded?.url).toBe("https://muse.wzrd.tech/mcp?probe=1");
    expect(forwarded?.headers.get("authorization")).toBe("Bearer air_oauth_token");
    await expect(forwarded?.text()).resolves.toBe("{}");
  });
});
