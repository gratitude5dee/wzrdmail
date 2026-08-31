import { Hono } from "hono";
import type { Env } from "./env.js";
import { LLMS_TXT } from "./llms.js";
import { landingHtml } from "./page.js";

export function createApp(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();

  app.get("/llms.txt", (c) =>
    c.text(LLMS_TXT, 200, { "Content-Type": "text/plain; charset=utf-8" })
  );

  app.get("/health", (c) => c.json({ ok: true, env: c.env.WZRDMAIL_ENV }));

  app.get("/", (c) => {
    // §14.2: text/plain-ish agents (e.g. plain `curl wzrd.tech`) get the
    // llms.txt onboarding header as the root page's alternate; anything
    // that explicitly accepts text/html gets the landing page.
    const accept = c.req.header("Accept") ?? "";
    if (!accept.includes("text/html")) {
      return c.text(LLMS_TXT, 200, {
        "Content-Type": "text/plain; charset=utf-8"
      });
    }
    return c.html(landingHtml());
  });

  app.notFound((c) =>
    c.json({ name: "not_found", message: "no such page" }, 404)
  );

  return app;
}
