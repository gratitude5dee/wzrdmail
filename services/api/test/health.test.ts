import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";

describe("GET /v0/health", () => {
  it("returns env + build sha without auth", async () => {
    const app = createApp();
    const res = await app.request("/v0/health", {}, env);
    expect(res.status).toBe(200);
    const body = await res.json<{
      ok: boolean;
      env: string;
      build_sha: string;
      migration_head: string | null;
    }>();
    expect(body.ok).toBe(true);
    expect(body.env).toBe("dev");
    expect(body.build_sha).toBe("dev");
  });

  it("returns the AgentMail-shape error envelope on unknown routes", async () => {
    const app = createApp();
    const res = await app.request("/v0/nope", {}, env);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      name: "not_found",
      message: "no such endpoint"
    });
  });
});
