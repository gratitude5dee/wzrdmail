import { ApiError, SendMessageInput } from "@wzrdmail/core";
import { Hono } from "hono";
import { authenticate } from "../auth.js";
import { CloudflareEmailProvider } from "../egress/provider.js";
import { sendMessage, type SendContext } from "../egress/send.js";
import type { Env } from "../env.js";

export const messages = new Hono<{ Bindings: Env }>();

messages.post("/inboxes/:inbox_id/messages/send", async (c) => {
  const auth = await authenticate(c);
  const inboxId = decodeURIComponent(c.req.param("inbox_id")).toLowerCase();
  const inbox = await c.env.DB.prepare(
    "SELECT inbox_id, org_id, pod_id FROM inboxes WHERE inbox_id = ? AND deleted_at IS NULL"
  )
    .bind(inboxId)
    .first<{ inbox_id: string; org_id: string; pod_id: string }>();
  if (!inbox || inbox.org_id !== auth.org_id) {
    throw new ApiError("not_found", "no such inbox");
  }
  if (auth.pod_id && auth.pod_id !== inbox.pod_id) {
    throw new ApiError("forbidden", "key is scoped to a different pod");
  }

  const parsed = SendMessageInput.safeParse(await c.req.json());
  if (!parsed.success) {
    throw new ApiError("validation_error", parsed.error.issues[0]?.message ?? "invalid body");
  }

  const ctx: SendContext = {
    inbox_id: inbox.inbox_id,
    org_id: inbox.org_id,
    pod_id: inbox.pod_id,
    org_verified: auth.org_verified,
    human_email: auth.human_email
  };
  const provider = new CloudflareEmailProvider(c.env);
  const result = await sendMessage(c.env, provider, ctx, parsed.data);
  return c.json(result, 200);
});
