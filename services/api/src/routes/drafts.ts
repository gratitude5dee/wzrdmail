import {
  ApiError,
  CreateDraftInput,
  newId,
  SendDraftInput,
  UpdateDraftInput,
  type SendMessageInput
} from "@wzrdmail/core";
import { Hono } from "hono";
import type { Context } from "hono";
import { authenticate, requirePermission, type AuthedKey } from "../auth.js";
import { CloudflareEmailProvider } from "../egress/provider.js";
import { sendMessage, type SendContext } from "../egress/send.js";
import type { Env } from "../env.js";
import {
  collection,
  parseBody,
  parsePagination,
  withIdempotency,
  requireInbox,
  type InboxRow
} from "../lib/http.js";
import { draftJson, type DraftRow } from "../lib/serialize.js";

export const drafts = new Hono<{ Bindings: Env }>();

const DRAFT_COLUMNS =
  "draft_id, org_id, pod_id, inbox_id, thread_id, in_reply_to, to_addrs, cc_addrs, bcc_addrs, subject, text, html, reply_to, headers, labels, client_id, sent_msg_id, created_at, updated_at";

async function requireDraft(
  c: Context<{ Bindings: Env }>,
  inbox: InboxRow,
  draftId: string
): Promise<DraftRow> {
  const row = await c.env.DB.prepare(
    `SELECT ${DRAFT_COLUMNS} FROM drafts WHERE draft_id = ? AND inbox_id = ?`
  )
    .bind(draftId, inbox.inbox_id)
    .first<DraftRow>();
  if (!row) throw new ApiError("not_found", "no such draft");
  return row;
}

drafts.post("/inboxes/:inbox_id/drafts", async (c) => {
  const auth = await authenticate(c);
  requirePermission(auth, "drafts");
  const inbox = await requireInbox(c, auth, c.req.param("inbox_id"));
  const input = await parseBody(c, CreateDraftInput);
  const result = await withIdempotency(
    c.env.DB,
    auth.org_id,
    "draft",
    input.client_id,
    async () => {
      const draftId = newId("draft");
      const now = new Date().toISOString();
      await c.env.DB.prepare(
        `INSERT INTO drafts (draft_id, org_id, pod_id, inbox_id, thread_id, in_reply_to,
           to_addrs, cc_addrs, bcc_addrs, subject, text, html, reply_to, headers, labels,
           client_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(
          draftId,
          inbox.org_id,
          inbox.pod_id,
          inbox.inbox_id,
          input.in_reply_to ?? null,
          JSON.stringify(input.to ?? []),
          JSON.stringify(input.cc ?? []),
          JSON.stringify(input.bcc ?? []),
          input.subject ?? "",
          input.text ?? null,
          input.html ?? null,
          input.reply_to ?? null,
          JSON.stringify(input.headers ?? {}),
          JSON.stringify(input.labels ?? []),
          input.client_id ?? null,
          now,
          now
        )
        .run();
      const row = await requireDraft(c, inbox, draftId);
      return draftJson(row);
    }
  );
  return c.json(result, 201);
});

drafts.get("/inboxes/:inbox_id/drafts", async (c) => {
  const auth = await authenticate(c);
  requirePermission(auth, "read");
  const inbox = await requireInbox(c, auth, c.req.param("inbox_id"));
  const { limit, cursor } = parsePagination(c);
  const conditions = ["inbox_id = ?"];
  const binds: (string | number)[] = [inbox.inbox_id];
  if (cursor) {
    conditions.push("(created_at < ? OR (created_at = ? AND draft_id < ?))");
    binds.push(cursor.v, cursor.v, cursor.id);
  }
  const rows = (
    await c.env.DB.prepare(
      `SELECT ${DRAFT_COLUMNS} FROM drafts WHERE ${conditions.join(" AND ")}
       ORDER BY created_at DESC, draft_id DESC LIMIT ?`
    )
      .bind(...binds, limit + 1)
      .all<DraftRow>()
  ).results;
  const page = collection(rows, limit, (r) => ({ v: r.created_at, id: r.draft_id }));
  return c.json({
    drafts: page.items.map((r) => draftJson(r)),
    ...(page.next_page_token ? { next_page_token: page.next_page_token } : {})
  });
});

drafts.get("/inboxes/:inbox_id/drafts/:draft_id", async (c) => {
  const auth = await authenticate(c);
  requirePermission(auth, "read");
  const inbox = await requireInbox(c, auth, c.req.param("inbox_id"));
  const row = await requireDraft(c, inbox, c.req.param("draft_id"));
  return c.json(draftJson(row));
});

drafts.patch("/inboxes/:inbox_id/drafts/:draft_id", async (c) => {
  const auth = await authenticate(c);
  requirePermission(auth, "drafts");
  const inbox = await requireInbox(c, auth, c.req.param("inbox_id"));
  const row = await requireDraft(c, inbox, c.req.param("draft_id"));
  if (row.sent_msg_id) {
    throw new ApiError("conflict", "draft has already been sent");
  }
  const patch = await parseBody(c, UpdateDraftInput);
  const now = new Date().toISOString();
  await c.env.DB.prepare(
    `UPDATE drafts SET to_addrs = ?, cc_addrs = ?, bcc_addrs = ?, subject = ?, text = ?,
       html = ?, reply_to = ?, headers = ?, labels = ?, in_reply_to = ?, updated_at = ?
     WHERE draft_id = ?`
  )
    .bind(
      patch.to !== undefined ? JSON.stringify(patch.to) : row.to_addrs,
      patch.cc !== undefined ? JSON.stringify(patch.cc) : row.cc_addrs,
      patch.bcc !== undefined ? JSON.stringify(patch.bcc) : row.bcc_addrs,
      patch.subject !== undefined ? patch.subject : row.subject,
      patch.text !== undefined ? patch.text : row.text,
      patch.html !== undefined ? patch.html : row.html,
      patch.reply_to !== undefined ? patch.reply_to : row.reply_to,
      patch.headers !== undefined ? JSON.stringify(patch.headers) : row.headers,
      patch.labels !== undefined ? JSON.stringify(patch.labels) : row.labels,
      patch.in_reply_to !== undefined ? patch.in_reply_to : row.in_reply_to,
      now,
      row.draft_id
    )
    .run();
  const updated = await requireDraft(c, inbox, row.draft_id);
  return c.json(draftJson(updated));
});

drafts.delete("/inboxes/:inbox_id/drafts/:draft_id", async (c) => {
  const auth = await authenticate(c);
  requirePermission(auth, "drafts");
  const inbox = await requireInbox(c, auth, c.req.param("inbox_id"));
  const row = await requireDraft(c, inbox, c.req.param("draft_id"));
  await c.env.DB.prepare("DELETE FROM drafts WHERE draft_id = ?").bind(row.draft_id).run();
  return c.body(null, 204);
});

drafts.post("/inboxes/:inbox_id/drafts/:draft_id/send", async (c) => {
  const auth = await authenticate(c);
  // Sending a draft is a real send: `drafts` alone is not enough.
  requirePermission(auth, "send");
  const inbox = await requireInbox(c, auth, c.req.param("inbox_id"));
  const row = await requireDraft(c, inbox, c.req.param("draft_id"));
  if (row.sent_msg_id) {
    throw new ApiError("conflict", "draft has already been sent");
  }
  const rawBody = await c.req.text();
  const body =
    rawBody.trim() === ""
      ? SendDraftInput.parse({})
      : await parseBody(c, SendDraftInput);
  const to = JSON.parse(row.to_addrs) as string[];
  if (to.length === 0) {
    throw new ApiError("validation_error", "draft has no recipients");
  }
  const headers = JSON.parse(row.headers) as Record<string, string>;
  // Reply linkage rides the In-Reply-To header, which the send pipeline uses
  // for thread resolution.
  if (row.in_reply_to && !headers["In-Reply-To"]) {
    headers["In-Reply-To"] = row.in_reply_to;
  }
  const input: SendMessageInput = {
    to,
    cc: JSON.parse(row.cc_addrs) as string[],
    bcc: JSON.parse(row.bcc_addrs) as string[],
    subject: row.subject,
    text: row.text ?? undefined,
    html: row.html ?? undefined,
    reply_to: row.reply_to ?? undefined,
    headers,
    labels: JSON.parse(row.labels) as string[],
    // Draft sends are idempotent per draft identity: every send of a draft
    // shares one idempotency key, so concurrent or repeated sends (whatever
    // the caller supplies) resolve to a single message.
    client_id: `draft-send:${row.draft_id}`,
    ...(body.send_at ? { send_at: body.send_at } : {})
  };
  const result = await sendFromDraft(c, auth, inbox, input);
  await c.env.DB.prepare(
    "UPDATE drafts SET sent_msg_id = ?, thread_id = ?, updated_at = ? WHERE draft_id = ?"
  )
    .bind(result.message_id, result.thread_id, new Date().toISOString(), row.draft_id)
    .run();
  return c.json(result, 200);
});

async function sendFromDraft(
  c: Context<{ Bindings: Env }>,
  auth: AuthedKey,
  inbox: InboxRow,
  input: SendMessageInput
): Promise<{ message_id: string; thread_id: string }> {
  const ctx: SendContext = {
    inbox_id: inbox.inbox_id,
    org_id: inbox.org_id,
    pod_id: inbox.pod_id,
    org_verified: auth.org_verified,
    human_email: auth.human_email
  };
  const provider = new CloudflareEmailProvider(c.env);
  return sendMessage(c.env, provider, ctx, input);
}
