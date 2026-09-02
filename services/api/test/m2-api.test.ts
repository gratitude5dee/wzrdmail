import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { hashApiKey } from "../src/auth.js";
import { seedInbox, NOW } from "./helpers.js";

const app = createApp();

async function seedKey(
  orgId: string,
  options?: { permissions?: string; podId?: string | null }
): Promise<string> {
  const key = `wm_test_${crypto.randomUUID().replaceAll("-", "")}`;
  await env.DB.prepare(
    "INSERT INTO api_keys (key_id, org_id, pod_id, key_hash, key_prefix, permissions, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  )
    .bind(
      `key_${crypto.randomUUID().slice(0, 8)}`,
      orgId,
      options?.podId ?? null,
      await hashApiKey(key),
      key.slice(0, 12),
      options?.permissions ?? "admin",
      NOW
    )
    .run();
  return key;
}

async function seedOtp(orgId: string, code: string, createdAt?: string): Promise<void> {
  const created = createdAt ?? new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO otp_codes (org_id, purpose, code_hash, attempts, expires_at, created_at)
     VALUES (?, 'agent_verify', ?, 0, ?, ?)
     ON CONFLICT (org_id, purpose) DO UPDATE
       SET code_hash = excluded.code_hash, attempts = 0,
           expires_at = excluded.expires_at, created_at = excluded.created_at`
  )
    .bind(orgId, await hashApiKey(code), new Date(Date.now() + 600_000).toISOString(), created)
    .run();
}

function authed(key: string, init?: RequestInit): RequestInit {
  return {
    ...init,
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      ...(init?.headers as Record<string, string> | undefined)
    }
  };
}

async function seedMessage(
  inbox: { org_id: string; pod_id: string; inbox_id: string },
  overrides?: Partial<{
    msg_id: string;
    thread_id: string;
    subject: string;
    text: string;
    from_addr: string;
    labels: string[];
    created_at: string;
    raw_key: string | null;
  }>
): Promise<{ msg_id: string; thread_id: string }> {
  const msgId = overrides?.msg_id ?? `msg_${crypto.randomUUID().slice(0, 12)}`;
  const threadId = overrides?.thread_id ?? `thread_${crypto.randomUUID().slice(0, 12)}`;
  const createdAt = overrides?.created_at ?? NOW;
  const existingThread = await env.DB.prepare(
    "SELECT thread_id FROM threads WHERE thread_id = ?"
  )
    .bind(threadId)
    .first();
  if (!existingThread) {
    await env.DB.prepare(
      `INSERT INTO threads (thread_id, org_id, pod_id, inbox_id, subject, normalized_subject, preview, last_message_at, message_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
    )
      .bind(
        threadId,
        inbox.org_id,
        inbox.pod_id,
        inbox.inbox_id,
        overrides?.subject ?? "Hello",
        (overrides?.subject ?? "hello").toLowerCase(),
        overrides?.text ?? "hi",
        createdAt,
        createdAt,
        createdAt
      )
      .run();
  }
  await env.DB.prepare(
    `INSERT INTO messages (msg_id, org_id, pod_id, inbox_id, thread_id, direction, state, from_addr, to_addrs, subject, text, labels, raw_key, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'inbound', 'received', ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      msgId,
      inbox.org_id,
      inbox.pod_id,
      inbox.inbox_id,
      threadId,
      overrides?.from_addr ?? "sender@example.com",
      JSON.stringify([inbox.inbox_id]),
      overrides?.subject ?? "Hello",
      overrides?.text ?? "hi",
      JSON.stringify(overrides?.labels ?? []),
      overrides?.raw_key ?? null,
      createdAt,
      createdAt
    )
    .run();
  return { msg_id: msgId, thread_id: threadId };
}

describe("agent onboarding (§M2)", () => {
  it("signs up, returns a key + inbox, and rejects duplicates", async () => {
    const res = await app.request(
      "/v0/agent/sign-up",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ human_email: "new-owner@example.com", username: "fresh-agent" })
      },
      env
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.api_key).toMatch(/^wm_live_/);
    expect(body.inbox_id).toBe("fresh-agent@wzrd.tech");
    expect(body.verified).toBe(false);

    const me = await app.request("/v0/auth/me", authed(body.api_key as string), env);
    expect(me.status).toBe(200);
    const meBody = (await me.json()) as { organization: { verified: boolean } };
    expect(meBody.organization.verified).toBe(false);

    const dupEmail = await app.request(
      "/v0/agent/sign-up",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ human_email: "new-owner@example.com", username: "other-name" })
      },
      env
    );
    expect(dupEmail.status).toBe(409);
    const dupUser = await app.request(
      "/v0/agent/sign-up",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ human_email: "someone-else@example.com", username: "fresh-agent" })
      },
      env
    );
    expect(dupUser.status).toBe(409);
  });

  it("verifies with the OTP code and flips the org to verified", async () => {
    const res = await app.request(
      "/v0/agent/sign-up",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ human_email: "verify-me@example.com", username: "verify-agent" })
      },
      env
    );
    const body = (await res.json()) as { api_key: string; organization_id: string };

    // OTP delivery fails in tests (no EMAIL binding), so seed a known code.
    await seedOtp(body.organization_id, "482913");

    const wrong = await app.request(
      "/v0/agent/verify",
      authed(body.api_key, { method: "POST", body: JSON.stringify({ otp_code: "000000" }) }),
      env
    );
    expect(wrong.status).toBe(400);
    const ok = await app.request(
      "/v0/agent/verify",
      authed(body.api_key, { method: "POST", body: JSON.stringify({ otp_code: "482913" }) }),
      env
    );
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { verified: boolean }).verified).toBe(true);
  });

  it("rate-limits resend and preserves the pending code on delivery failure", async () => {
    const res = await app.request(
      "/v0/agent/sign-up",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ human_email: "resend-me@example.com", username: "resend-agent" })
      },
      env
    );
    const body = (await res.json()) as { api_key: string; organization_id: string };

    // A code issued moments ago blocks an immediate resend.
    await seedOtp(body.organization_id, "111222");
    const tooSoon = await app.request(
      "/v0/agent/verify/resend",
      authed(body.api_key, { method: "POST" }),
      env
    );
    expect(tooSoon.status).toBe(429);
    expect(Number(tooSoon.headers.get("Retry-After"))).toBeGreaterThan(0);

    // Past the cooldown, delivery fails in tests (no EMAIL binding) — the
    // pending code must survive.
    await seedOtp(body.organization_id, "111222", new Date(Date.now() - 120_000).toISOString());
    const failed = await app.request(
      "/v0/agent/verify/resend",
      authed(body.api_key, { method: "POST" }),
      env
    );
    expect(failed.status).toBe(500);

    // A failed delivery must not start a cooldown: retrying immediately is
    // allowed (and fails on delivery again, not on rate limiting).
    const retry = await app.request(
      "/v0/agent/verify/resend",
      authed(body.api_key, { method: "POST" }),
      env
    );
    expect(retry.status).toBe(500);

    const ok = await app.request(
      "/v0/agent/verify",
      authed(body.api_key, { method: "POST", body: JSON.stringify({ otp_code: "111222" }) }),
      env
    );
    expect(ok.status).toBe(200);
  });

  it("hides foreign organizations", async () => {
    const inbox = await seedInbox({ address: `iso-${crypto.randomUUID().slice(0, 6)}@wzrd.tech` });
    const key = await seedKey(inbox.org_id);
    const res = await app.request("/v0/organizations/org_someone_else", authed(key), env);
    expect(res.status).toBe(404);
  });
});

describe("inbox CRUD (§M2)", () => {
  it("creates, lists, gets, patches, and deletes an inbox", async () => {
    const inbox = await seedInbox({ address: `crud-${crypto.randomUUID().slice(0, 6)}@wzrd.tech` });
    const key = await seedKey(inbox.org_id);

    const created = await app.request(
      "/v0/inboxes",
      authed(key, {
        method: "POST",
        body: JSON.stringify({ username: `made-${crypto.randomUUID().slice(0, 6)}`, client_id: "inbox-cli-1" })
      }),
      env
    );
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as { inbox_id: string };
    expect(createdBody.inbox_id).toMatch(/@wzrd\.tech$/);

    const replay = await app.request(
      "/v0/inboxes",
      authed(key, {
        method: "POST",
        body: JSON.stringify({ username: `other-${crypto.randomUUID().slice(0, 6)}`, client_id: "inbox-cli-1" })
      }),
      env
    );
    expect(((await replay.json()) as { inbox_id: string }).inbox_id).toBe(createdBody.inbox_id);

    const list = await app.request("/v0/inboxes?limit=1", authed(key), env);
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as { inboxes: unknown[]; next_page_token: string | null };
    expect(listBody.inboxes).toHaveLength(1);
    expect(listBody.next_page_token).not.toBeNull();

    const page2 = await app.request(
      `/v0/inboxes?limit=10&page_token=${encodeURIComponent(listBody.next_page_token!)}`,
      authed(key),
      env
    );
    const page2Body = (await page2.json()) as { inboxes: { inbox_id: string }[] };
    expect(page2Body.inboxes.length).toBeGreaterThanOrEqual(1);

    const got = await app.request(
      `/v0/inboxes/${encodeURIComponent(createdBody.inbox_id)}`,
      authed(key),
      env
    );
    expect(got.status).toBe(200);

    const patched = await app.request(
      `/v0/inboxes/${encodeURIComponent(createdBody.inbox_id)}`,
      authed(key, { method: "PATCH", body: JSON.stringify({ display_name: "Scout" }) }),
      env
    );
    expect(patched.status).toBe(200);
    expect(((await patched.json()) as { display_name: string }).display_name).toBe("Scout");

    const deleted = await app.request(
      `/v0/inboxes/${encodeURIComponent(createdBody.inbox_id)}`,
      authed(key, { method: "DELETE" }),
      env
    );
    expect(deleted.status).toBe(204);
    const gone = await app.request(
      `/v0/inboxes/${encodeURIComponent(createdBody.inbox_id)}`,
      authed(key),
      env
    );
    expect(gone.status).toBe(404);
  });

  it("never exposes another org's inboxes", async () => {
    const mine = await seedInbox({ address: `mine-${crypto.randomUUID().slice(0, 6)}@wzrd.tech` });
    const theirs = await seedInbox({ address: `theirs-${crypto.randomUUID().slice(0, 6)}@wzrd.tech` });
    const key = await seedKey(mine.org_id);
    const res = await app.request(
      `/v0/inboxes/${encodeURIComponent(theirs.inbox_id)}`,
      authed(key),
      env
    );
    expect(res.status).toBe(404);
  });

  it("requires admin permission to create", async () => {
    const inbox = await seedInbox({ address: `ro-${crypto.randomUUID().slice(0, 6)}@wzrd.tech` });
    const key = await seedKey(inbox.org_id, { permissions: "read" });
    const res = await app.request(
      "/v0/inboxes",
      authed(key, { method: "POST", body: JSON.stringify({ username: "nope" }) }),
      env
    );
    expect(res.status).toBe(403);
  });
});

describe("message endpoints (§M2)", () => {
  it("lists, filters by label, paginates, and gets a message", async () => {
    const inbox = await seedInbox({ address: `msg-${crypto.randomUUID().slice(0, 6)}@wzrd.tech` });
    const key = await seedKey(inbox.org_id);
    const early = await seedMessage(inbox, { created_at: "2026-01-01T00:00:00.000Z", labels: ["work"] });
    const late = await seedMessage(inbox, { created_at: "2026-02-01T00:00:00.000Z" });

    const base = `/v0/inboxes/${encodeURIComponent(inbox.inbox_id)}/messages`;
    const list = await app.request(`${base}?limit=1`, authed(key), env);
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as {
      messages: { message_id: string }[];
      next_page_token: string | null;
    };
    expect(listBody.messages[0]!.message_id).toBe(late.msg_id);
    expect(listBody.next_page_token).not.toBeNull();

    const page2 = await app.request(
      `${base}?limit=1&page_token=${encodeURIComponent(listBody.next_page_token!)}`,
      authed(key),
      env
    );
    const page2Body = (await page2.json()) as { messages: { message_id: string }[] };
    expect(page2Body.messages[0]!.message_id).toBe(early.msg_id);

    const labeled = await app.request(`${base}?labels=work`, authed(key), env);
    const labeledBody = (await labeled.json()) as { messages: { message_id: string }[] };
    expect(labeledBody.messages.map((m) => m.message_id)).toEqual([early.msg_id]);

    const got = await app.request(`${base}/${early.msg_id}`, authed(key), env);
    expect(got.status).toBe(200);
    const gotBody = (await got.json()) as { message_id: string; labels: string[] };
    expect(gotBody.message_id).toBe(early.msg_id);
    expect(gotBody.labels).toEqual(["work"]);
  });

  it("searches by subject/sender", async () => {
    const inbox = await seedInbox({ address: `srch-${crypto.randomUUID().slice(0, 6)}@wzrd.tech` });
    const key = await seedKey(inbox.org_id);
    const hit = await seedMessage(inbox, { subject: "Quarterly zebra report" });
    await seedMessage(inbox, { subject: "unrelated" });
    const res = await app.request(
      `/v0/inboxes/${encodeURIComponent(inbox.inbox_id)}/messages/search?query=zebra`,
      authed(key),
      env
    );
    const body = (await res.json()) as { messages: { message_id: string }[] };
    expect(body.messages.map((m) => m.message_id)).toEqual([hit.msg_id]);
  });

  it("serves raw MIME from R2", async () => {
    const inbox = await seedInbox({ address: `raw-${crypto.randomUUID().slice(0, 6)}@wzrd.tech` });
    const key = await seedKey(inbox.org_id);
    const rawKey = `raw/${inbox.inbox_id}/test.eml`;
    await env.MAIL.put(rawKey, "From: sender@example.com\r\n\r\nraw body");
    const msg = await seedMessage(inbox, { raw_key: rawKey });
    const res = await app.request(
      `/v0/inboxes/${encodeURIComponent(inbox.inbox_id)}/messages/${msg.msg_id}/raw`,
      authed(key),
      env
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("message/rfc822");
    expect(await res.text()).toContain("raw body");
  });

  it("patches labels and batch-updates", async () => {
    const inbox = await seedInbox({ address: `lbl-${crypto.randomUUID().slice(0, 6)}@wzrd.tech` });
    const key = await seedKey(inbox.org_id);
    const msg = await seedMessage(inbox, { labels: ["a"] });
    const base = `/v0/inboxes/${encodeURIComponent(inbox.inbox_id)}/messages`;

    const patched = await app.request(
      `${base}/${msg.msg_id}`,
      authed(key, {
        method: "PATCH",
        body: JSON.stringify({ add_labels: ["b"], remove_labels: ["a"] })
      }),
      env
    );
    expect(patched.status).toBe(200);
    expect(((await patched.json()) as { labels: string[] }).labels).toEqual(["b"]);

    const other = await seedMessage(inbox);
    const batch = await app.request(
      `${base}/batch-update`,
      authed(key, {
        method: "PATCH",
        body: JSON.stringify({ message_ids: [msg.msg_id, other.msg_id], add_labels: ["seen"] })
      }),
      env
    );
    expect(batch.status).toBe(200);

    const batchGet = await app.request(
      `${base}/batch-get`,
      authed(key, {
        method: "POST",
        body: JSON.stringify({ message_ids: [msg.msg_id, other.msg_id] })
      }),
      env
    );
    const batchBody = (await batchGet.json()) as { messages: { labels: string[] }[] };
    expect(batchBody.messages).toHaveLength(2);
    for (const item of batchBody.messages) expect(item.labels).toContain("seen");
  });

  it("maps read updates onto the unread label", async () => {
    const inbox = await seedInbox({ address: `rd-${crypto.randomUUID().slice(0, 6)}@wzrd.tech` });
    const key = await seedKey(inbox.org_id);
    const msg = await seedMessage(inbox, { labels: ["unread"] });
    const base = `/v0/inboxes/${encodeURIComponent(inbox.inbox_id)}/messages`;

    const read = await app.request(
      `${base}/${msg.msg_id}`,
      authed(key, { method: "PATCH", body: JSON.stringify({ read: true }) }),
      env
    );
    expect(((await read.json()) as { labels: string[] }).labels).not.toContain("unread");

    const unread = await app.request(
      `${base}/${msg.msg_id}`,
      authed(key, { method: "PATCH", body: JSON.stringify({ read: false }) }),
      env
    );
    expect(((await unread.json()) as { labels: string[] }).labels).toContain("unread");
  });

  it("blocks cross-org message reads", async () => {
    const mine = await seedInbox({ address: `xm-${crypto.randomUUID().slice(0, 6)}@wzrd.tech` });
    const theirs = await seedInbox({ address: `xt-${crypto.randomUUID().slice(0, 6)}@wzrd.tech` });
    const msg = await seedMessage(theirs);
    const key = await seedKey(mine.org_id);
    const res = await app.request(
      `/v0/inboxes/${encodeURIComponent(theirs.inbox_id)}/messages/${msg.msg_id}`,
      authed(key),
      env
    );
    expect(res.status).toBe(404);
  });
});

describe("thread endpoints (§M2)", () => {
  it("lists, gets (with messages), searches, patches, and deletes threads", async () => {
    const inbox = await seedInbox({ address: `thr-${crypto.randomUUID().slice(0, 6)}@wzrd.tech` });
    const key = await seedKey(inbox.org_id);
    const msg = await seedMessage(inbox, { subject: "Walrus plans" });

    const base = `/v0/inboxes/${encodeURIComponent(inbox.inbox_id)}/threads`;
    const list = await app.request(base, authed(key), env);
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as { threads: { thread_id: string }[] };
    expect(listBody.threads.map((t) => t.thread_id)).toContain(msg.thread_id);

    const got = await app.request(`${base}/${msg.thread_id}`, authed(key), env);
    expect(got.status).toBe(200);
    const gotBody = (await got.json()) as { messages: { message_id: string }[] };
    expect(gotBody.messages.map((m) => m.message_id)).toEqual([msg.msg_id]);

    const search = await app.request(`${base}/search?query=walrus`, authed(key), env);
    const searchBody = (await search.json()) as { threads: { thread_id: string }[] };
    expect(searchBody.threads.map((t) => t.thread_id)).toEqual([msg.thread_id]);

    const orgWide = await app.request(`/v0/threads/${msg.thread_id}`, authed(key), env);
    expect(orgWide.status).toBe(200);

    const patched = await app.request(
      `${base}/${msg.thread_id}`,
      authed(key, { method: "PATCH", body: JSON.stringify({ add_labels: ["starred"] }) }),
      env
    );
    expect(((await patched.json()) as { labels: string[] }).labels).toEqual(["starred"]);

    const deleted = await app.request(
      `${base}/${msg.thread_id}`,
      authed(key, { method: "DELETE" }),
      env
    );
    expect(deleted.status).toBe(204);
    // Delete is a soft delete: the thread leaves the default list but stays
    // fetchable (trash) until purged.
    const afterDelete = await app.request(base, authed(key), env);
    const afterBody = (await afterDelete.json()) as { threads: { thread_id: string }[] };
    expect(afterBody.threads.map((t) => t.thread_id)).not.toContain(msg.thread_id);
  });

  it("hides foreign threads from org-wide routes", async () => {
    const mine = await seedInbox({ address: `to-${crypto.randomUUID().slice(0, 6)}@wzrd.tech` });
    const theirs = await seedInbox({ address: `tf-${crypto.randomUUID().slice(0, 6)}@wzrd.tech` });
    const msg = await seedMessage(theirs);
    const key = await seedKey(mine.org_id);
    const res = await app.request(`/v0/threads/${msg.thread_id}`, authed(key), env);
    expect(res.status).toBe(404);
  });
});

describe("webhook CRUD (§M2)", () => {
  it("creates, lists, gets, patches headers, and deletes a webhook", async () => {
    const inbox = await seedInbox({ address: `wh-${crypto.randomUUID().slice(0, 6)}@wzrd.tech` });
    const key = await seedKey(inbox.org_id);

    const created = await app.request(
      "/v0/webhooks",
      authed(key, {
        method: "POST",
        body: JSON.stringify({ url: "https://example.com/hook", client_id: "wh-cli-1" })
      }),
      env
    );
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as { webhook_id: string; secret: string };
    expect(createdBody.secret).toMatch(/^whsec_/);

    const replay = await app.request(
      "/v0/webhooks",
      authed(key, {
        method: "POST",
        body: JSON.stringify({ url: "https://example.com/other", client_id: "wh-cli-1" })
      }),
      env
    );
    expect(((await replay.json()) as { webhook_id: string }).webhook_id).toBe(
      createdBody.webhook_id
    );

    const list = await app.request("/v0/webhooks", authed(key), env);
    const listBody = (await list.json()) as { webhooks: { webhook_id: string; secret?: string }[] };
    expect(listBody.webhooks.map((w) => w.webhook_id)).toContain(createdBody.webhook_id);
    for (const w of listBody.webhooks) expect(w.secret).toBeUndefined();

    const got = await app.request(`/v0/webhooks/${createdBody.webhook_id}`, authed(key), env);
    expect(((await got.json()) as { secret?: string }).secret).toBeUndefined();

    const patched = await app.request(
      `/v0/webhooks/${createdBody.webhook_id}`,
      authed(key, { method: "PATCH", body: JSON.stringify({ enabled: false }) }),
      env
    );
    expect(((await patched.json()) as { enabled: boolean }).enabled).toBe(false);

    const headers = await app.request(
      `/v0/webhooks/${createdBody.webhook_id}/headers`,
      authed(key, { method: "PATCH", body: JSON.stringify({ "X-Custom": "yes" }) }),
      env
    );
    expect(((await headers.json()) as Record<string, string>)["X-Custom"]).toBe("yes");
    const gotHeaders = await app.request(
      `/v0/webhooks/${createdBody.webhook_id}/headers`,
      authed(key),
      env
    );
    expect(((await gotHeaders.json()) as Record<string, string>)["X-Custom"]).toBe("yes");

    const deleted = await app.request(
      `/v0/webhooks/${createdBody.webhook_id}`,
      authed(key, { method: "DELETE" }),
      env
    );
    expect(deleted.status).toBe(204);
    const gone = await app.request(`/v0/webhooks/${createdBody.webhook_id}`, authed(key), env);
    expect(gone.status).toBe(404);
  });

  it("scopes inbox webhooks and hides them from other inboxes", async () => {
    const inbox = await seedInbox({ address: `whi-${crypto.randomUUID().slice(0, 6)}@wzrd.tech` });
    const other = await seedInbox({ address: `who-${crypto.randomUUID().slice(0, 6)}@wzrd.tech` });
    const key = await seedKey(inbox.org_id);
    const otherKey = await seedKey(other.org_id);

    const created = await app.request(
      `/v0/inboxes/${encodeURIComponent(inbox.inbox_id)}/webhooks`,
      authed(key, { method: "POST", body: JSON.stringify({ url: "https://example.com/inbox-hook" }) }),
      env
    );
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as { webhook_id: string; inbox_id: string };
    expect(createdBody.inbox_id).toBe(inbox.inbox_id);

    const cross = await app.request(
      `/v0/webhooks/${createdBody.webhook_id}`,
      authed(otherKey),
      env
    );
    expect(cross.status).toBe(404);
  });

  it("rejects non-https and private webhook urls", async () => {
    const inbox = await seedInbox({ address: `whs-${crypto.randomUUID().slice(0, 6)}@wzrd.tech` });
    const key = await seedKey(inbox.org_id);
    for (const url of [
      "http://example.com/hook",
      "https://10.0.0.5/hook",
      "https://169.254.169.254/latest/meta-data",
      "https://metadata.google.internal/x"
    ]) {
      const res = await app.request(
        "/v0/webhooks",
        authed(key, { method: "POST", body: JSON.stringify({ url }) }),
        env
      );
      expect(res.status, url).toBe(400);
    }
  });
});

describe("webhook pod_ids (AgentMail parity)", () => {
  it("accepts pod_ids + client_id, persists them, and rejects foreign pods", async () => {
    const inbox = await seedInbox({ address: `whp-${crypto.randomUUID().slice(0, 6)}@wzrd.tech` });
    const foreign = await seedInbox({ address: `whp2-${crypto.randomUUID().slice(0, 6)}@wzrd.tech` });
    const key = await seedKey(inbox.org_id);

    const created = await app.request(
      "/v0/webhooks",
      authed(key, {
        method: "POST",
        body: JSON.stringify({
          url: "https://example.com/hook",
          pod_ids: [inbox.pod_id, inbox.pod_id],
          client_id: `air-${crypto.randomUUID().slice(0, 6)}`
        })
      }),
      env
    );
    expect(created.status).toBe(201);
    const body = (await created.json()) as { webhook_id: string; pod_ids: string[] };
    expect(body.pod_ids).toEqual([inbox.pod_id]);

    const fetched = await app.request(`/v0/webhooks/${body.webhook_id}`, authed(key), env);
    expect(((await fetched.json()) as { pod_ids: string[] }).pod_ids).toEqual([inbox.pod_id]);

    const bad = await app.request(
      "/v0/webhooks",
      authed(key, {
        method: "POST",
        body: JSON.stringify({ url: "https://example.com/hook", pod_ids: [foreign.pod_id] })
      }),
      env
    );
    expect(bad.status).toBe(404);

    const podKey = await seedKey(inbox.org_id, { podId: inbox.pod_id });
    const otherPod = await app.request(
      "/v0/webhooks",
      authed(podKey, {
        method: "POST",
        body: JSON.stringify({ url: "https://example.com/hook", pod_ids: [foreign.pod_id] })
      }),
      env
    );
    expect(otherPod.status).toBe(403);
  });

  it("frees the client_id when a webhook is deleted so it can be reused", async () => {
    const inbox = await seedInbox({ address: `whr-${crypto.randomUUID().slice(0, 6)}@wzrd.tech` });
    const key = await seedKey(inbox.org_id);
    const clientId = `air-${crypto.randomUUID().slice(0, 6)}`;
    const body = JSON.stringify({
      url: "https://example.com/hook",
      pod_ids: [inbox.pod_id],
      client_id: clientId
    });

    const first = await app.request("/v0/webhooks", authed(key, { method: "POST", body }), env);
    expect(first.status).toBe(201);
    const firstId = ((await first.json()) as { webhook_id: string }).webhook_id;

    const replay = await app.request("/v0/webhooks", authed(key, { method: "POST", body }), env);
    expect(((await replay.json()) as { webhook_id: string }).webhook_id).toBe(firstId);

    const del = await app.request(`/v0/webhooks/${firstId}`, authed(key, { method: "DELETE" }), env);
    expect(del.status).toBe(204);

    const recreated = await app.request("/v0/webhooks", authed(key, { method: "POST", body }), env);
    expect(recreated.status).toBe(201);
    const secondId = ((await recreated.json()) as { webhook_id: string }).webhook_id;
    expect(secondId).not.toBe(firstId);

    const fetched = await app.request(`/v0/webhooks/${secondId}`, authed(key), env);
    expect(fetched.status).toBe(200);
  });
});
