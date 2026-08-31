import { ApiError } from "@wzrdmail/core";
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "./env.js";
import { agent } from "./routes/agent.js";
import { consoleAuth } from "./routes/console.js";
import { domains } from "./routes/domains.js";
import { health } from "./routes/health.js";
import { inboxes } from "./routes/inboxes.js";
import { keys } from "./routes/keys.js";
import { lists } from "./routes/lists.js";
import { messages } from "./routes/messages.js";
import { threads } from "./routes/threads.js";
import { usage } from "./routes/usage.js";
import { webhooks } from "./routes/webhooks.js";

const CONSOLE_ORIGINS = [
  "https://console.mail.wzrd.tech",
  "https://staging.console.mail.wzrd.tech",
  "http://localhost:5173"
];

export function createApp(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();

  app.use(
    "/v0/*",
    cors({
      origin: (origin) => (CONSOLE_ORIGINS.includes(origin) ? origin : null),
      credentials: true,
      allowHeaders: ["authorization", "content-type", "x-api-key"],
      allowMethods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"]
    })
  );

  // CSRF guard: session cookies use SameSite=None (cross-origin console), so
  // any state-changing request carrying one must come from a known console
  // origin. API-key requests carry no cookie and are unaffected.
  app.use("/v0/*", async (c, next) => {
    const method = c.req.method;
    if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
      const cookie = c.req.header("cookie") ?? "";
      if (/(?:^|;\s*)wm_session=/.test(cookie)) {
        const origin = c.req.header("origin");
        if (!origin || !CONSOLE_ORIGINS.includes(origin)) {
          throw new ApiError("forbidden", "cross-site request blocked");
        }
      }
    }
    await next();
  });

  app.route("/v0", health);
  app.route("/v0", agent);
  app.route("/v0", consoleAuth);
  app.route("/v0", domains);
  app.route("/v0", inboxes);
  app.route("/v0", keys);
  app.route("/v0", lists);
  app.route("/v0", messages);
  app.route("/v0", threads);
  app.route("/v0", usage);
  app.route("/v0", webhooks);

  app.notFound((c) =>
    c.json({ name: "not_found", message: "no such endpoint" }, 404)
  );

  app.onError((err, c) => {
    if (err instanceof ApiError) {
      return c.json(err.toEnvelope(), err.status as 400);
    }
    console.error(JSON.stringify({ msg: "unhandled_error", error: String(err) }));
    return c.json(
      { name: "internal_error", message: "internal error" },
      500
    );
  });

  return app;
}
