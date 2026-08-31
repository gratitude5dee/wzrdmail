import { Hono } from "hono";
import { accepts } from "./accept.js";
import appleTouchIcon from "./assets/apple-touch-icon.png";
import faviconIco from "./assets/favicon.ico";
import favicon32 from "./assets/favicon-32.png";
import icon192 from "./assets/icon-192.png";
import logoPng from "./assets/logo.png";
import type { Env } from "./env.js";
import { LLMS_TXT } from "./llms.js";
import { landingHtml } from "./page.js";

const ASSETS: Record<string, { body: ArrayBuffer; type: string }> = {
  "/logo.png": { body: logoPng, type: "image/png" },
  "/favicon.ico": { body: faviconIco, type: "image/x-icon" },
  "/favicon-32.png": { body: favicon32, type: "image/png" },
  "/icon-192.png": { body: icon192, type: "image/png" },
  "/apple-touch-icon.png": { body: appleTouchIcon, type: "image/png" }
};

function docsHost(env: Env): string {
  return env.WZRDMAIL_ENV === "staging"
    ? "staging.docs.mail.wzrd.tech"
    : "docs.mail.wzrd.tech";
}

export function createApp(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();

  for (const [path, asset] of Object.entries(ASSETS)) {
    app.get(path, () =>
      new Response(asset.body, {
        headers: {
          "Content-Type": asset.type,
          "Cache-Control": "public, max-age=86400"
        }
      })
    );
  }

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

  // §14.1: docs live on their own hostname; /docs paths 301 there.
  const redirectToDocs = (c: { req: { path: string }; env: Env }): Response => {
    const path = c.req.path === "/docs" ? "/" : c.req.path.slice("/docs".length);
    return Response.redirect(`https://${docsHost(c.env)}${path}`, 301);
  };
  app.all("/docs", (c) => redirectToDocs(c));
  app.all("/docs/*", (c) => redirectToDocs(c));

  app.notFound((c) =>
    c.json({ name: "not_found", message: "no such page" }, 404)
  );

  return app;
}
