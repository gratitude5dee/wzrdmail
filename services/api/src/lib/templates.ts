/**
 * Transactional templates (R-MAIL-06). Placeholder syntax: `{{key}}` inserts an
 * HTML-escaped value in the html part (raw in text/subject), `{{{key}}}` always
 * inserts the raw value — Resend parity.
 */
import { ApiError, type TemplateVariable } from "@wzrdmail/core";
import type { TemplateRow } from "./serialize.js";

const PLACEHOLDER_RE =
  /\{\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}\}|\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;"
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch] as string);
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

/** Substitute `{{key}}`/`{{{key}}}` placeholders; unprovided keys stay literal. */
export function renderTemplateString(
  body: string,
  vars: Record<string, unknown>,
  htmlEscape: boolean
): string {
  return body.replace(PLACEHOLDER_RE, (match, rawKey: string | undefined, escKey: string | undefined) => {
    const key = (rawKey ?? escKey) as string;
    if (!(key in vars)) return match;
    const value = stringify(vars[key] ?? "");
    return htmlEscape && escKey !== undefined ? escapeHtml(value) : value;
  });
}

function matchesType(value: unknown, type: TemplateVariable["type"]): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number";
    case "boolean":
      return typeof value === "boolean";
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
    case "list":
      return Array.isArray(value);
  }
}

/**
 * Merge declared fallbacks with caller-provided values. A declared variable
 * with no fallback and no provided value is required — missing or
 * type-mismatched values fail with 400.
 */
export function resolveTemplateVariables(
  declared: TemplateVariable[],
  provided: Record<string, unknown> | undefined
): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  const missing: string[] = [];
  for (const d of declared) {
    const p = provided?.[d.key];
    const value = p === undefined || p === null ? d.fallback_value : p;
    if (value === undefined) {
      missing.push(d.key);
      continue;
    }
    if (!matchesType(value, d.type)) {
      throw new ApiError(
        "validation_error",
        `template variable ${d.key} must be of type ${d.type}`
      );
    }
    values[d.key] = value;
  }
  if (missing.length > 0) {
    throw new ApiError(
      "validation_error",
      `missing required template variable${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}`
    );
  }
  // Values for undeclared placeholders pass through so callers are not forced
  // to declare every key.
  for (const [key, value] of Object.entries(provided ?? {})) {
    if (!(key in values) && value !== undefined && value !== null) values[key] = value;
  }
  return values;
}

export function parseTemplateVariables(raw: string | null): TemplateVariable[] {
  try {
    const parsed = JSON.parse(raw ?? "[]") as unknown;
    return Array.isArray(parsed) ? (parsed as TemplateVariable[]) : [];
  } catch {
    return [];
  }
}

/**
 * Load the immutable published snapshot for a send. `idOrAlias` accepts either
 * a `tpl_…` id or the org-unique alias (Resend `template.id` semantics).
 */
export async function loadPublishedTemplate(
  db: D1Database,
  orgId: string,
  idOrAlias: string
): Promise<TemplateRow> {
  const row = await db
    .prepare(
      `SELECT template_id, org_id, name, alias, subject, text, html, variables,
              published_subject, published_text, published_html, published_variables,
              published_at, client_id, created_at, updated_at
       FROM templates WHERE org_id = ? AND (template_id = ? OR alias = ?)`
    )
    .bind(orgId, idOrAlias, idOrAlias)
    .first<TemplateRow>();
  if (!row) throw new ApiError("not_found", "no such template");
  if (!row.published_at) {
    throw new ApiError(
      "validation_error",
      "template has no published version — publish it before sending"
    );
  }
  return row;
}

/** Render a published template row into send bodies. */
export function renderPublishedTemplate(
  row: TemplateRow,
  provided: Record<string, unknown> | undefined
): { subject: string; text?: string; html?: string } {
  const vars = resolveTemplateVariables(
    parseTemplateVariables(row.published_variables),
    provided
  );
  return {
    subject: renderTemplateString(row.published_subject ?? "", vars, false),
    text:
      row.published_text !== null
        ? renderTemplateString(row.published_text, vars, false)
        : undefined,
    html:
      row.published_html !== null
        ? renderTemplateString(row.published_html, vars, true)
        : undefined
  };
}
