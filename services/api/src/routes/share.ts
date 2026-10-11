import { ApiError } from "@wzrdmail/core";
import { Hono } from "hono";
import type { Env } from "../env.js";
import { SHARE_CSP, shareTextDocument } from "../lib/share.js";

export const share = new Hono<{ Bindings: Env }>();

interface ShareRow {
  share_id: string;
  html_snapshot: string | null;
  text_snapshot: string | null;
  expires_at: string;
}

/**
 * Public, unauthenticated by design: the share_id is unguessable, the
 * snapshot is immutable (minted once), and expiry is enforced at read.
 * Nothing else in the org is reachable through this route.
 */
share.get("/share/:share_id", async (c) => {
  const row = await c.env.DB.prepare(
    "SELECT share_id, html_snapshot, text_snapshot, expires_at FROM share_links WHERE share_id = ?"
  )
    .bind(c.req.param("share_id"))
    .first<ShareRow>();
  if (!row || new Date(row.expires_at).getTime() <= Date.now()) {
    throw new ApiError("not_found", "share link not found or expired");
  }
  const doc = row.html_snapshot ?? shareTextDocument(row.text_snapshot ?? "");
  return new Response(doc, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": SHARE_CSP,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store"
    }
  });
});
