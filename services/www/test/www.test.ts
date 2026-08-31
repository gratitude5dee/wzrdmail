import { env } from "cloudflare:test";
import { PLANS } from "@wzrdmail/core";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";

const app = createApp();

describe("landing page", () => {
  it("serves the landing HTML to browsers", async () => {
    const res = await app.request(
      "/",
      { headers: { Accept: "text/html,application/xhtml+xml" } },
      env
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain("Email for AI agents");
    expect(body).toContain("https://api.wzrd.tech/v0/agent/sign-up");
    expect(body).toContain("https://docs.wzrd.tech");
    expect(body).toContain("https://console.wzrd.tech");
  });

  it("shows pricing derived from plans.ts", async () => {
    const res = await app.request(
      "/",
      { headers: { Accept: "text/html" } },
      env
    );
    const body = await res.text();
    expect(body).toContain(`$${String(PLANS.developer.priceUsdMonthly)}`);
    expect(body).toContain(`$${String(PLANS.startup.priceUsdMonthly)}`);
    expect(body).toContain("$0");
    expect(body).toContain(PLANS.free.emailsPerMonth.toLocaleString("en-US"));
    expect(body).toContain(
      PLANS.startup.emailsPerMonth.toLocaleString("en-US")
    );
  });

  it("serves the agent onboarding header to text/plain-ish agents at /", async () => {
    const res = await app.request(
      "/",
      { headers: { Accept: "*/*" } },
      env
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/plain");
    const body = await res.text();
    expect(body).toContain("If you are an AI agent");
  });

  it("serves the onboarding header when text/html is rejected with q=0", async () => {
    const res = await app.request(
      "/",
      { headers: { Accept: "text/html;q=0, */*" } },
      env
    );
    expect(res.headers.get("Content-Type")).toContain("text/plain");
    expect(await res.text()).toContain("If you are an AI agent");
  });

  it("matches text/html case-insensitively", async () => {
    const res = await app.request(
      "/",
      { headers: { Accept: "TEXT/HTML;q=0.8" } },
      env
    );
    expect(res.headers.get("Content-Type")).toContain("text/html");
  });

  it("honors a later positive-q entry for a duplicated media type", async () => {
    const res = await app.request(
      "/",
      { headers: { Accept: "text/html;q=0, text/html;q=0.9" } },
      env
    );
    expect(res.headers.get("Content-Type")).toContain("text/html");
  });

  it("returns the error envelope on unknown routes", async () => {
    const res = await app.request("/nope", {}, env);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      name: "not_found",
      message: "no such page"
    });
  });
});

describe("GET /llms.txt", () => {
  it("returns the agent onboarding header", async () => {
    const res = await app.request("/llms.txt", {}, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/plain");
    const body = await res.text();
    expect(body).toContain("If you are an AI agent");
    expect(body).toContain("WZRDMAIL_API_KEY");
    expect(body).toContain("https://api.wzrd.tech/v0/agent/sign-up");
    expect(body).toContain("https://mcp.mail.wzrd.tech/mcp");
    expect(body).toContain("wm_live_");
  });
});
