import { Hono } from "hono";
import type { Env } from "../env.js";

export const health = new Hono<{ Bindings: Env }>();

health.get("/health", async (c) => {
  let migrationHead: string | null = null;
  try {
    const row = await c.env.DB.prepare(
      "SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1"
    ).first<{ name: string }>();
    migrationHead = row?.name ?? null;
  } catch {
    migrationHead = null;
  }
  return c.json({
    ok: true,
    env: c.env.WZRDMAIL_ENV,
    build_sha: c.env.BUILD_SHA,
    migration_head: migrationHead
  });
});
