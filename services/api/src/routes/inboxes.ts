import {
  ApiError,
  CreateInboxInput,
  PLANS,
  UpdateInboxInput,
  normalizeDomainName,
  ulid,
  validateUsername,
  type PlanName
} from "@wzrdmail/core";
import { Hono } from "hono";
import type { Context } from "hono";
import { authenticate, requirePermission, type AuthedKey } from "../auth.js";
import type { Env } from "../env.js";
import {
  collection,
  parseBody,
  parsePagination,
  releaseClientId,
  requireInbox,
  requireNotInboxScoped,
  withIdempotency,
  type InboxRow
} from "../lib/http.js";

export const inboxes = new Hono<{ Bindings: Env }>();

const SHARED_DOMAIN = "wzrd.tech";

function inboxJson(row: InboxRow): Record<string, unknown> {
  return {
    inbox_id: row.inbox_id,
    organization_id: row.org_id,
    pod_id: row.pod_id,
    username: row.username,
    domain: row.domain,
    display_name: row.display_name,
    client_id: row.client_id,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

inboxes.get("/inboxes", async (c) => {
  const auth = await authenticate(c);
  requirePermission(auth, "read");
  const { limit, cursor } = parsePagination(c);
  const rows = (
    await c.env.DB.prepare(
      `SELECT inbox_id, org_id, pod_id, username, domain, display_name, client_id, created_at, updated_at
       FROM inboxes
       WHERE org_id = ? AND deleted_at IS NULL
         AND (? IS NULL OR pod_id = ?)
         AND (? IS NULL OR inbox_id = ?)
         AND (? IS NULL OR created_at > ? OR (created_at = ? AND inbox_id > ?))
       ORDER BY created_at, inbox_id LIMIT ?`
    )
      .bind(
        auth.org_id,
        auth.pod_id,
        auth.pod_id,
        auth.inbox_id,
        auth.inbox_id,
        cursor?.v ?? null,
        cursor?.v ?? null,
        cursor?.v ?? null,
        cursor?.id ?? null,
        limit + 1
      )
      .all<InboxRow>()
  ).results;
  const page = collection(rows, limit, (r) => ({ v: r.created_at, id: r.inbox_id }));
  return c.json({ inboxes: page.items.map(inboxJson), next_page_token: page.next_page_token ?? null });
});

inboxes.post("/inboxes", async (c) => {
  const auth = await authenticate(c);
  requirePermission(auth, "admin");
  requireNotInboxScoped(auth, "inbox creation");
  const input = await parseBody(c, CreateInboxInput);
  return createInbox(c, auth, input);
});

/** AgentMail-compatible alias: create an inbox inside a specific pod. */
inboxes.post("/pods/:pod_id/inboxes", async (c) => {
  const auth = await authenticate(c);
  requirePermission(auth, "admin");
  requireNotInboxScoped(auth, "inbox creation");
  const input = await parseBody(c, CreateInboxInput);
  return createInbox(c, auth, { ...input, pod_id: c.req.param("pod_id") });
});

async function resolvePodId(
  c: Context<{ Bindings: Env }>,
  auth: AuthedKey,
  requested: string | undefined
): Promise<string> {
  if (requested) {
    if (auth.pod_id && auth.pod_id !== requested) {
      throw new ApiError("forbidden", "key is scoped to a different pod");
    }
    const pod = await c.env.DB.prepare(
      "SELECT pod_id FROM pods WHERE pod_id = ? AND org_id = ? AND deleted_at IS NULL"
    )
      .bind(requested, auth.org_id)
      .first<{ pod_id: string }>();
    if (!pod) throw new ApiError("not_found", "pod not found");
    return pod.pod_id;
  }
  const podId =
    auth.pod_id ??
    (
      await c.env.DB.prepare(
        "SELECT pod_id FROM pods WHERE org_id = ? AND deleted_at IS NULL ORDER BY created_at LIMIT 1"
      )
        .bind(auth.org_id)
        .first<{ pod_id: string }>()
    )?.pod_id;
  if (!podId) throw new ApiError("internal_error", "organization has no pod");
  return podId;
}

async function createInbox(
  c: Context<{ Bindings: Env }>,
  auth: AuthedKey,
  input: CreateInboxInput
): Promise<Response> {
  const domain = normalizeDomainName(input.domain ?? SHARED_DOMAIN);

  let username: string;
  if (input.username) {
    const verdict = validateUsername(input.username);
    if (!verdict.ok) throw new ApiError("validation_error", `username is ${verdict.reason}`);
    username = verdict.username;
  } else {
    username = `agent-${ulid().slice(-10).toLowerCase()}`;
  }

  const result = await withIdempotency(c.env.DB, auth.org_id, "inbox", input.client_id, async () => {
    if (domain !== SHARED_DOMAIN) {
      const owned = await c.env.DB.prepare(
        "SELECT domain_id FROM domains WHERE name = ? AND org_id = ? AND status = 'verified'"
      )
        .bind(domain, auth.org_id)
        .first<{ domain_id: string }>();
      if (!owned) {
        throw new ApiError("validation_error", `domain ${domain} is not verified for this organization`);
      }
    }

    const org = await c.env.DB.prepare(
      "SELECT plan FROM organizations WHERE org_id = ?"
    )
      .bind(auth.org_id)
      .first<{ plan: string }>();
    const plan = PLANS[(org?.plan ?? "free") as PlanName] ?? PLANS.free;
    const count = await c.env.DB.prepare(
      "SELECT COUNT(*) AS n FROM inboxes WHERE org_id = ? AND deleted_at IS NULL"
    )
      .bind(auth.org_id)
      .first<{ n: number }>();
    if ((count?.n ?? 0) >= plan.inboxes) {
      throw new ApiError("plan_limit_exceeded", `plan allows at most ${plan.inboxes} inboxes`);
    }

    const podId = await resolvePodId(c, auth, input.pod_id);

    const inboxId = `${username}@${domain}`;
    const now = new Date().toISOString();
    const inserted = await c.env.DB.prepare(
      `INSERT INTO inboxes (inbox_id, org_id, pod_id, username, domain, display_name, client_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`
    )
      .bind(inboxId, auth.org_id, podId, username, domain, input.display_name ?? null, input.client_id ?? null, now, now)
      .run();
    if (inserted.meta.changes === 0) {
      throw new ApiError("conflict", `inbox ${inboxId} already exists`);
    }
    return {
      inbox_id: inboxId,
      organization_id: auth.org_id,
      pod_id: podId,
      username,
      domain,
      display_name: input.display_name ?? null,
      client_id: input.client_id ?? null,
      created_at: now,
      updated_at: now
    };
  });
  return c.json(result, 201);
}

inboxes.get("/inboxes/:inbox_id", async (c) => {
  const auth = await authenticate(c);
  requirePermission(auth, "read");
  const inbox = await requireInbox(c, auth, c.req.param("inbox_id"));
  return c.json(inboxJson(inbox));
});

inboxes.patch("/inboxes/:inbox_id", async (c) => {
  const auth = await authenticate(c);
  requirePermission(auth, "admin");
  const inbox = await requireInbox(c, auth, c.req.param("inbox_id"));
  const input = await parseBody(c, UpdateInboxInput);
  const now = new Date().toISOString();
  const displayName =
    input.display_name === undefined ? inbox.display_name : input.display_name;
  await c.env.DB.prepare(
    "UPDATE inboxes SET display_name = ?, updated_at = ? WHERE inbox_id = ?"
  )
    .bind(displayName, now, inbox.inbox_id)
    .run();
  return c.json(inboxJson({ ...inbox, display_name: displayName, updated_at: now }));
});

inboxes.delete("/inboxes/:inbox_id", async (c) => {
  const auth = await authenticate(c);
  requirePermission(auth, "admin");
  const inbox = await requireInbox(c, auth, c.req.param("inbox_id"));
  const now = new Date().toISOString();
  await c.env.DB.batch([
    c.env.DB.prepare(
      "UPDATE inboxes SET deleted_at = ?, updated_at = ? WHERE inbox_id = ?"
    ).bind(now, now, inbox.inbox_id),
    releaseClientId(c.env.DB, auth.org_id, "inbox", inbox.client_id)
  ]);
  return c.body(null, 204);
});
