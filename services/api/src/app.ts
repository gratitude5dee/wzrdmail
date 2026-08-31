import { ApiError } from "@wzrdmail/core";
import { Hono } from "hono";
import type { Env } from "./env.js";
import { health } from "./routes/health.js";
import { messages } from "./routes/messages.js";

export function createApp(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();

  app.route("/v0", health);
  app.route("/v0", messages);

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
