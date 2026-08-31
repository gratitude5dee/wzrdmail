import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { PAGES } from "../src/content.js";

const app = createApp();

describe("docs routes", () => {
  it("serves rendered HTML at / for browsers", async () => {
    const res = await app.request("/", { headers: { Accept: "text/html" } }, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain("<h1>wzrdmail docs</h1>");
  });

  it("serves every docs page as HTML", async () => {
    for (const page of PAGES) {
      const res = await app.request(`/${page.slug}`, {}, env);
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toContain("text/html");
    }
  });

  it("returns the error envelope on unknown pages", async () => {
    const res = await app.request("/nope", {}, env);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      name: "not_found",
      message: "no such page"
    });
  });
});

describe("markdown content negotiation", () => {
  it("returns raw markdown for Accept: text/markdown", async () => {
    const res = await app.request(
      "/quickstart",
      { headers: { Accept: "text/markdown" } },
      env
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/markdown");
    const body = await res.text();
    expect(body).toContain("# Quickstart");
    expect(body).not.toContain("<html");
  });

  it("returns raw markdown for a .md suffix", async () => {
    const res = await app.request("/migrate-from-agentmail.md", {}, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/markdown");
    expect(await res.text()).toContain("# Migrate from AgentMail");
  });

  it("negotiates markdown on nested api pages", async () => {
    const res = await app.request(
      "/api/webhooks",
      { headers: { Accept: "text/markdown" } },
      env
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("svix-signature");
  });
});

describe("llms.txt routes", () => {
  it("serves the llms.txt index", async () => {
    const res = await app.request("/llms.txt", {}, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/plain");
    const body = await res.text();
    expect(body).toContain("# wzrdmail");
    for (const page of PAGES) {
      expect(body).toContain(`https://docs.wzrd.tech/${page.slug}.md`);
    }
  });

  it("serves the full corpus at /llms-full.txt", async () => {
    const res = await app.request("/llms-full.txt", {}, env);
    expect(res.status).toBe(200);
    const body = await res.text();
    for (const page of PAGES) {
      expect(body).toContain(page.markdown.trim());
    }
  });
});

describe("API shape fidelity in content", () => {
  it("quickstart shows the golden-path sign-up shape", async () => {
    const res = await app.request("/quickstart.md", {}, env);
    const body = await res.text();
    expect(body).toContain("/v0/agent/sign-up");
    expect(body).toContain('"human_email"');
    expect(body).toContain("wm_live_");
    expect(body).toContain('"inbox_id"');
  });

  it("docs use the {name, message} error envelope", async () => {
    const res = await app.request("/api/auth.md", {}, env);
    const body = await res.text();
    expect(body).toContain('"name": "forbidden"');
    expect(body).toContain('"message"');
  });
});
