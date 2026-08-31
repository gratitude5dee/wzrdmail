import {
  ApiError,
  CreateDomainInput,
  PLANS,
  newId,
  type DnsRecord,
  type DomainStatus,
  type PlanName
} from "@wzrdmail/core";
import { Hono } from "hono";
import type { Context } from "hono";
import { authenticate, requirePermission, type AuthedKey } from "../auth.js";
import type { Env } from "../env.js";
import { DnsLookupError, lookupDns } from "../lib/dns.js";
import { buildEvent } from "../lib/events.js";
import { collection, parseBody, parsePagination, withIdempotency } from "../lib/http.js";

export const domains = new Hono<{ Bindings: Env }>();

const SHARED_DOMAIN = "wzrd.tech";
const MX_TARGET = "route.wzrd.tech";
const SPF_INCLUDE = "_spf.wzrd.tech";

const DOMAIN_COLUMNS =
  "domain_id, org_id, name, status, verification_token, verified_at, last_checked_at, failure_reason, created_at, updated_at";

export interface DomainRow {
  domain_id: string;
  org_id: string;
  name: string;
  status: DomainStatus;
  verification_token: string;
  verified_at: string | null;
  last_checked_at: string | null;
  failure_reason: string | null;
  created_at: string;
  updated_at: string;
}

/** The records the customer must create in their DNS (§6.6, DoH-verified). */
export function requiredDnsRecords(name: string, token: string): DnsRecord[] {
  return [
    { type: "TXT", name: `_wzrdmail.${name}`, value: `wzrdmail-verify=${token}` },
    { type: "MX", name, value: MX_TARGET, priority: 10 },
    { type: "TXT", name, value: `v=spf1 include:${SPF_INCLUDE} ~all` }
  ];
}

function domainJson(row: DomainRow): Record<string, unknown> {
  return {
    domain_id: row.domain_id,
    organization_id: row.org_id,
    name: row.name,
    status: row.status,
    verified: row.status === "verified",
    failure_reason: row.failure_reason,
    verified_at: row.verified_at,
    last_checked_at: row.last_checked_at,
    dns_records: requiredDnsRecords(row.name, row.verification_token),
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

function randomToken(): string {
  const buf = new Uint8Array(16);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function requireDomain(
  c: Context<{ Bindings: Env }>,
  auth: AuthedKey,
  domainId: string
): Promise<DomainRow> {
  const row = await c.env.DB.prepare(
    `SELECT ${DOMAIN_COLUMNS} FROM domains WHERE domain_id = ?`
  )
    .bind(domainId)
    .first<DomainRow>();
  if (!row || row.org_id !== auth.org_id) {
    throw new ApiError("not_found", "no such domain");
  }
  return row;
}

/** Domains are org-level resources; pod-scoped keys may not manage them. */
function requireOrgScope(auth: AuthedKey): void {
  if (auth.pod_id) {
    throw new ApiError("forbidden", "domains require an org-scoped key");
  }
}

domains.get("/domains", async (c) => {
  const auth = await authenticate(c);
  requirePermission(auth, "read");
  requireOrgScope(auth);
  const { limit, cursor } = parsePagination(c);
  const rows = (
    await c.env.DB.prepare(
      `SELECT ${DOMAIN_COLUMNS} FROM domains
       WHERE org_id = ?
         AND (? IS NULL OR created_at > ? OR (created_at = ? AND domain_id > ?))
       ORDER BY created_at, domain_id LIMIT ?`
    )
      .bind(
        auth.org_id,
        cursor?.v ?? null,
        cursor?.v ?? null,
        cursor?.v ?? null,
        cursor?.id ?? null,
        limit + 1
      )
      .all<DomainRow>()
  ).results;
  const page = collection(rows, limit, (r) => ({ v: r.created_at, id: r.domain_id }));
  return c.json({ domains: page.items.map(domainJson), next_page_token: page.next_page_token ?? null });
});

domains.post("/domains", async (c) => {
  const auth = await authenticate(c);
  requirePermission(auth, "admin");
  requireOrgScope(auth);
  const input = await parseBody(c, CreateDomainInput);
  const name = input.domain;
  if (name === SHARED_DOMAIN || name.endsWith(`.${SHARED_DOMAIN}`)) {
    throw new ApiError("validation_error", `${SHARED_DOMAIN} is the shared platform domain`);
  }

  const result = await withIdempotency(c.env.DB, auth.org_id, "domain", input.client_id, async () => {
    const org = await c.env.DB.prepare("SELECT plan FROM organizations WHERE org_id = ?")
      .bind(auth.org_id)
      .first<{ plan: string }>();
    const plan = PLANS[(org?.plan ?? "free") as PlanName] ?? PLANS.free;
    const count = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM domains WHERE org_id = ?")
      .bind(auth.org_id)
      .first<{ n: number }>();
    if ((count?.n ?? 0) >= plan.customDomains) {
      throw new ApiError("plan_limit_exceeded", `plan allows at most ${plan.customDomains} custom domains`);
    }

    const domainId = newId("dom");
    const token = randomToken();
    const now = new Date().toISOString();
    const inserted = await c.env.DB.prepare(
      `INSERT INTO domains (domain_id, org_id, name, verified, status, verification_token, created_at, updated_at)
       VALUES (?, ?, ?, 0, 'pending', ?, ?, ?) ON CONFLICT DO NOTHING`
    )
      .bind(domainId, auth.org_id, name, token, now, now)
      .run();
    if (inserted.meta.changes === 0) {
      throw new ApiError("conflict", `domain ${name} is already registered`);
    }
    return domainJson({
      domain_id: domainId,
      org_id: auth.org_id,
      name,
      status: "pending",
      verification_token: token,
      verified_at: null,
      last_checked_at: null,
      failure_reason: null,
      created_at: now,
      updated_at: now
    });
  });
  return c.json(result, 201);
});

domains.get("/domains/:domain_id", async (c) => {
  const auth = await authenticate(c);
  requirePermission(auth, "read");
  requireOrgScope(auth);
  const row = await requireDomain(c, auth, c.req.param("domain_id"));
  return c.json(domainJson(row));
});

interface DnsCheck {
  record: DnsRecord;
  ok: boolean;
  found: string[];
}

/** Strip a trailing dot for host comparisons (`route.wzrd.tech.`). */
function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/\.$/, "");
}

async function runChecks(row: DomainRow): Promise<DnsCheck[]> {
  const [ownership, mx, apexTxt] = await Promise.all([
    lookupDns(`_wzrdmail.${row.name}`, "TXT"),
    lookupDns(row.name, "MX"),
    lookupDns(row.name, "TXT")
  ]);
  const [ownershipRecord, mxRecord, spfRecord] = requiredDnsRecords(
    row.name,
    row.verification_token
  ) as [DnsRecord, DnsRecord, DnsRecord];
  const spf = apexTxt.filter((v) => v.toLowerCase().startsWith("v=spf1"));
  return [
    {
      record: ownershipRecord,
      ok: ownership.some((v) => v.trim() === `wzrdmail-verify=${row.verification_token}`),
      found: ownership
    },
    {
      record: mxRecord,
      ok: mx.some((v) => normalizeHost(v.split(/\s+/).pop() ?? "") === MX_TARGET),
      found: mx
    },
    {
      record: spfRecord,
      ok: spf.some((v) =>
        v.split(/\s+/).some((mech) => mech.toLowerCase() === `include:${SPF_INCLUDE}`)
      ),
      found: spf
    }
  ];
}

domains.post("/domains/:domain_id/verify", async (c) => {
  const auth = await authenticate(c);
  requirePermission(auth, "admin");
  requireOrgScope(auth);
  const row = await requireDomain(c, auth, c.req.param("domain_id"));

  let checks: DnsCheck[];
  try {
    checks = await runChecks(row);
  } catch (err) {
    if (err instanceof DnsLookupError) {
      throw new ApiError("internal_error", err.message);
    }
    throw err;
  }

  const failed = checks.filter((check) => !check.ok);
  const now = new Date().toISOString();
  const status: DomainStatus = failed.length === 0 ? "verified" : "failed";
  const failureReason =
    failed.length === 0
      ? null
      : `missing or wrong DNS records: ${failed
          .map((check) => `${check.record.type} ${check.record.name}`)
          .join(", ")}`;
  const update = c.env.DB.prepare(
    `UPDATE domains SET status = ?, verified = ?, verified_at = ?, last_checked_at = ?,
       failure_reason = ?, updated_at = ? WHERE domain_id = ?`
  ).bind(
    status,
    status === "verified" ? 1 : 0,
    status === "verified" ? (row.verified_at ?? now) : null,
    now,
    failureReason,
    now,
    row.domain_id
  );

  let batched = false;
  if (status === "verified") {
    const pod = await c.env.DB.prepare(
      "SELECT pod_id FROM pods WHERE org_id = ? ORDER BY created_at LIMIT 1"
    )
      .bind(auth.org_id)
      .first<{ pod_id: string }>();
    if (pod) {
      const event = buildEvent({
        type: "domain.verified",
        org_id: auth.org_id,
        pod_id: pod.pod_id,
        data: { domain_id: row.domain_id, name: row.name }
      });
      // Emit domain.verified exactly once: the guarded insert only fires for
      // the request that performs the non-verified -> verified transition,
      // atomically with the state change.
      const guardedInsert = c.env.DB.prepare(
        `INSERT INTO events (event_id, type, org_id, pod_id, inbox_id, payload, created_at)
         SELECT ?, ?, ?, ?, ?, ?, ?
         WHERE (SELECT status FROM domains WHERE domain_id = ?) != 'verified'`
      ).bind(...event.values, row.domain_id);
      await c.env.DB.batch([guardedInsert, update]);
      batched = true;
    }
  }
  if (!batched) {
    await update.run();
  }

  return c.json({
    ...domainJson({
      ...row,
      status,
      verified_at: status === "verified" ? (row.verified_at ?? now) : null,
      last_checked_at: now,
      failure_reason: failureReason,
      updated_at: now
    }),
    checks: checks.map((check) => ({
      type: check.record.type,
      name: check.record.name,
      expected: check.record.value,
      ok: check.ok,
      found: check.found
    }))
  });
});

domains.delete("/domains/:domain_id", async (c) => {
  const auth = await authenticate(c);
  requirePermission(auth, "admin");
  requireOrgScope(auth);
  const row = await requireDomain(c, auth, c.req.param("domain_id"));
  const inUse = await c.env.DB.prepare(
    "SELECT COUNT(*) AS n FROM inboxes WHERE org_id = ? AND domain = ? AND deleted_at IS NULL"
  )
    .bind(auth.org_id, row.name)
    .first<{ n: number }>();
  if ((inUse?.n ?? 0) > 0) {
    throw new ApiError("conflict", `domain ${row.name} still has active inboxes`);
  }
  await c.env.DB.prepare("DELETE FROM domains WHERE domain_id = ?").bind(row.domain_id).run();
  return c.body(null, 204);
});
