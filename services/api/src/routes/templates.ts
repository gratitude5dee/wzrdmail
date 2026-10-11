import { ApiError, CreateTemplateInput, UpdateTemplateInput, newId } from "@wzrdmail/core";
import { Hono } from "hono";
import type { Context } from "hono";
import { authenticate, requirePermission, type AuthedKey } from "../auth.js";
import type { Env } from "../env.js";
import {
  collection,
  parseBody,
  parsePagination,
  releaseClientId,
  requireNotInboxScoped,
  withIdempotency
} from "../lib/http.js";
import { templateJson, type TemplateRow } from "../lib/serialize.js";

export const templates = new Hono<{ Bindings: Env }>();

const TEMPLATE_COLUMNS =
  "template_id, org_id, name, alias, subject, text, html, variables, " +
  "published_subject, published_text, published_html, published_variables, " +
  "published_at, client_id, created_at, updated_at";

/** Templates are org-wide: pod- or inbox-scoped keys may not write them. */
function requireOrgScope(auth: AuthedKey): void {
  requireNotInboxScoped(auth, "templates");
  if (auth.pod_id) {
    throw new ApiError(
      "forbidden",
      "templates are organization-wide and require an organization-scoped key"
    );
  }
}

async function requireTemplate(
  c: Context<{ Bindings: Env }>,
  auth: AuthedKey,
  templateId: string
): Promise<TemplateRow> {
  const row = await c.env.DB.prepare(
    `SELECT ${TEMPLATE_COLUMNS} FROM templates WHERE template_id = ? AND org_id = ?`
  )
    .bind(templateId, auth.org_id)
    .first<TemplateRow>();
  if (!row) throw new ApiError("not_found", "no such template");
  return row;
}

templates.get("/templates", async (c) => {
  const auth = await authenticate(c);
  requirePermission(auth, "read");
  requireNotInboxScoped(auth, "templates");
  const { limit, cursor } = parsePagination(c);
  const conditions = ["org_id = ?"];
  const binds: string[] = [auth.org_id];
  const status = c.req.query("status");
  if (status !== undefined) {
    if (status === "draft") conditions.push("published_at IS NULL");
    else if (status === "published") conditions.push("published_at IS NOT NULL");
    else throw new ApiError("validation_error", "status must be 'draft' or 'published'");
  }
  if (cursor) {
    conditions.push("(created_at > ? OR (created_at = ? AND template_id > ?))");
    binds.push(cursor.v, cursor.v, cursor.id);
  }
  const rows = (
    await c.env.DB.prepare(
      `SELECT ${TEMPLATE_COLUMNS} FROM templates WHERE ${conditions.join(" AND ")}
       ORDER BY created_at, template_id LIMIT ?`
    )
      .bind(...binds, limit + 1)
      .all<TemplateRow>()
  ).results;
  const page = collection(rows, limit, (r) => ({ v: r.created_at, id: r.template_id }));
  return c.json({
    templates: page.items.map((r) => templateJson(r)),
    next_page_token: page.next_page_token ?? null
  });
});

templates.post("/templates", async (c) => {
  const auth = await authenticate(c);
  requirePermission(auth, "admin");
  requireOrgScope(auth);
  const input = await parseBody(c, CreateTemplateInput);
  const result = await withIdempotency(
    c.env.DB,
    auth.org_id,
    "template",
    input.client_id,
    async () => {
      const now = new Date().toISOString();
      const row: TemplateRow = {
        template_id: newId("tpl"),
        org_id: auth.org_id,
        name: input.name,
        alias: input.alias ?? null,
        subject: input.subject ?? "",
        text: input.text ?? null,
        html: input.html ?? null,
        variables: JSON.stringify(input.variables ?? []),
        published_subject: null,
        published_text: null,
        published_html: null,
        published_variables: null,
        published_at: null,
        client_id: input.client_id ?? null,
        created_at: now,
        updated_at: now
      };
      try {
        await c.env.DB.prepare(
          `INSERT INTO templates (template_id, org_id, name, alias, subject, text, html, variables,
             client_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
          .bind(
            row.template_id,
            row.org_id,
            row.name,
            row.alias,
            row.subject,
            row.text,
            row.html,
            row.variables,
            row.client_id,
            row.created_at,
            row.updated_at
          )
          .run();
      } catch (err) {
        if (String(err).includes("UNIQUE constraint failed")) {
          throw new ApiError("conflict", `template alias '${input.alias}' is already in use`);
        }
        throw err;
      }
      return templateJson(row);
    }
  );
  return c.json(result, 201);
});

templates.get("/templates/:template_id", async (c) => {
  const auth = await authenticate(c);
  requirePermission(auth, "read");
  requireNotInboxScoped(auth, "templates");
  const row = await requireTemplate(c, auth, c.req.param("template_id"));
  return c.json(templateJson(row));
});

templates.patch("/templates/:template_id", async (c) => {
  const auth = await authenticate(c);
  requirePermission(auth, "admin");
  requireOrgScope(auth);
  const row = await requireTemplate(c, auth, c.req.param("template_id"));
  const input = await parseBody(c, UpdateTemplateInput);
  const sets: string[] = [];
  const binds: (string | null)[] = [];
  if (input.name !== undefined) {
    sets.push("name = ?");
    binds.push(input.name);
  }
  if (input.alias !== undefined) {
    sets.push("alias = ?");
    binds.push(input.alias);
  }
  if (input.subject !== undefined) {
    sets.push("subject = ?");
    binds.push(input.subject);
  }
  if (input.text !== undefined) {
    sets.push("text = ?");
    binds.push(input.text);
  }
  if (input.html !== undefined) {
    sets.push("html = ?");
    binds.push(input.html);
  }
  if (input.variables !== undefined) {
    sets.push("variables = ?");
    binds.push(JSON.stringify(input.variables));
  }
  if (sets.length === 0) return c.json(templateJson(row));
  sets.push("updated_at = ?");
  binds.push(new Date().toISOString());
  try {
    await c.env.DB.prepare(
      `UPDATE templates SET ${sets.join(", ")} WHERE template_id = ? AND org_id = ?`
    )
      .bind(...binds, row.template_id, auth.org_id)
      .run();
  } catch (err) {
    if (String(err).includes("UNIQUE constraint failed")) {
      throw new ApiError("conflict", `template alias '${input.alias}' is already in use`);
    }
    throw err;
  }
  const updated = await c.env.DB.prepare(
    `SELECT ${TEMPLATE_COLUMNS} FROM templates WHERE template_id = ?`
  )
    .bind(row.template_id)
    .first<TemplateRow>();
  return c.json(templateJson(updated as TemplateRow));
});

templates.delete("/templates/:template_id", async (c) => {
  const auth = await authenticate(c);
  requirePermission(auth, "admin");
  requireOrgScope(auth);
  const row = await requireTemplate(c, auth, c.req.param("template_id"));
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM templates WHERE template_id = ? AND org_id = ?").bind(
      row.template_id,
      auth.org_id
    ),
    releaseClientId(c.env.DB, auth.org_id, "template", row.client_id)
  ]);
  return c.body(null, 204);
});

/** Snapshot the draft fields into the immutable published version. */
templates.post("/templates/:template_id/publish", async (c) => {
  const auth = await authenticate(c);
  requirePermission(auth, "admin");
  requireOrgScope(auth);
  const row = await requireTemplate(c, auth, c.req.param("template_id"));
  if (row.text === null && row.html === null) {
    throw new ApiError(
      "validation_error",
      "cannot publish a template with no text or html body"
    );
  }
  const now = new Date().toISOString();
  await c.env.DB.prepare(
    `UPDATE templates
     SET published_subject = subject, published_text = text, published_html = html,
         published_variables = variables, published_at = ?, updated_at = ?
     WHERE template_id = ? AND org_id = ?`
  )
    .bind(now, now, row.template_id, auth.org_id)
    .run();
  const updated = await c.env.DB.prepare(
    `SELECT ${TEMPLATE_COLUMNS} FROM templates WHERE template_id = ?`
  )
    .bind(row.template_id)
    .first<TemplateRow>();
  return c.json(templateJson(updated as TemplateRow));
});

/** Copy a template into a new draft (alias cleared; never published). */
templates.post("/templates/:template_id/duplicate", async (c) => {
  const auth = await authenticate(c);
  requirePermission(auth, "admin");
  requireOrgScope(auth);
  const row = await requireTemplate(c, auth, c.req.param("template_id"));
  const now = new Date().toISOString();
  const copy: TemplateRow = {
    ...row,
    template_id: newId("tpl"),
    name: `${row.name} (copy)`.slice(0, 200),
    alias: null,
    published_subject: null,
    published_text: null,
    published_html: null,
    published_variables: null,
    published_at: null,
    client_id: null,
    created_at: now,
    updated_at: now
  };
  await c.env.DB.prepare(
    `INSERT INTO templates (template_id, org_id, name, alias, subject, text, html, variables,
       client_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      copy.template_id,
      copy.org_id,
      copy.name,
      copy.alias,
      copy.subject,
      copy.text,
      copy.html,
      copy.variables,
      copy.client_id,
      copy.created_at,
      copy.updated_at
    )
    .run();
  return c.json(templateJson(copy), 201);
});
