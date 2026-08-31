import { Hono } from "hono";
import { accepts } from "./accept.js";
import type { Env } from "./env.js";
import { LLMS_TXT } from "./llms.js";
import { landingHtml } from "./page.js";

function forwardToDocs(env: Env, request: Request): Response | Promise<Response> {
  if (!env.DOCS) {
    return new Response(
      JSON.stringify({ name: "not_found", message: "docs are not bound" }),
      { status: 404, headers: { "Content-Type": "application/json" } }
    );
  }
  return env.DOCS.fetch(request);
}

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
    if (!accepts(c.req.header("Accept") ?? "", "text/html")) {
      return c.text(LLMS_TXT, 200, {
        "Content-Type": "text/plain; charset=utf-8"
      });
    }
    return c.html(landingHtml());
  });

  // §14.1: the docs Worker is mounted at /docs on this hostname; it renders
  // its own links under the same prefix (DOCS_BASE_PATH).
  app.all("/docs", (c) => forwardToDocs(c.env, c.req.raw));
  app.all("/docs/*", (c) => forwardToDocs(c.env, c.req.raw));

  app.notFound((c) =>
    c.json({ name: "not_found", message: "no such page" }, 404)
  );

  return app;
}
