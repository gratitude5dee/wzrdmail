import { env } from "cloudflare:test";
import type { MailProvider, OutboundMime, SendOutcome } from "@wzrdmail/core";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { hashApiKey } from "../src/auth.js";
import { deliverDueScheduled, purgeExpiredTrash } from "../src/egress/scheduled.js";
import { sendMessage, type SendContext } from "../src/egress/send.js";
import { seedInbox, NOW } from "./helpers.js";

const app = createApp();

class StubProvider implements MailProvider {
  sent: OutboundMime[] = [];
  send(msg: OutboundMime): Promise<SendOutcome> {
    this.sent.push(msg);
    return Promise.resolve({ providerMessageId: "prov-1", accepted: msg.to, rejected: [] });
  }
  requiredDnsRecords(): never[] {
    return [];
  }
  verifyDomain(): Promise<{ verified: boolean; pending: never[] }> {
    return Promise.resolve({ verified: true, pending: [] });
  }
}

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

function ctxFor(inbox: { org_id: string; pod_id: string; inbox_id: string }): SendContext {
  return {
    inbox_id: inbox.inbox_id,
    org_id: inbox.org_id,
    pod_id: inbox.pod_id,
    org_verified: true,
    human_email: "owner@example.com"
  };
}

async function seedMessage(
  inbox: { org_id: string; pod_id: string; inbox_id: string },
  overrides?: Partial<{ subject: string; created_at: string; deleted_at: string | null }>
): Promise<{ msg_id: string; thread_id: string }> {
  const msgId = `msg_${crypto.randomUUID().slice(0, 12)}`;
  const threadId = `thread_${crypto.randomUUID().slice(0, 12)}`;
  const createdAt = overrides?.created_at ?? NOW;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO threads (thread_id, org_id, pod_id, inbox_id, subject, normalized_subject, preview, last_message_at, message_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
    ).bind(
      threadId,
      inbox.org_id,
      inbox.pod_id,
      inbox.inbox_id,
      overrides?.subject ?? "Hello",
      (overrides?.subject ?? "hello").toLowerCase(),
      "hi",
      createdAt,
      createdAt,
      createdAt
    ),
    env.DB.prepare(
      `INSERT INTO messages (msg_id, org_id, pod_id, inbox_id, thread_id, direction, state, from_addr, to_addrs, subject, text, labels, deleted_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'inbound', 'received', 'sender@example.com', ?, ?, 'hi', '[]', ?, ?, ?)`
    ).bind(
      msgId,
      inbox.org_id,
      inbox.pod_id,
      inbox.inbox_id,
      threadId,
      JSON.stringify([inbox.inbox_id]),
      overrides?.subject ?? "Hello",
      overrides?.deleted_at ?? null,
      createdAt,
      createdAt
    )
  ]);
  return { msg_id: msgId, thread_id: threadId };
}

const FUTURE = new Date(Date.now() + 60 * 60 * 1000).toISOString();

describe("drafts API", () => {
  it("creates, lists, gets, updates, and deletes drafts", async () => {
    const inbox = await seedInbox({ address: `d1-${crypto.randomUUID().slice(0, 6)}@wzrd.tech` });
    const key = await seedKey(inbox.org_id);
    const base = `/v0/inboxes/${encodeURIComponent(inbox.inbox_id)}/drafts`;

    const created = await app.request(
      base,
      authed(key, {
        method: "POST",
        body: JSON.stringify({ to: ["dest@example.com"], subject: "Hi", text: "hello" })
      }),
      env
    );
    expect(created.status).toBe(201);
    const draft = (await created.json()) as { draft_id: string; to: string[]; subject: string };
    expect(draft.draft_id).toMatch(/^draft_/);
    expect(draft.to).toEqual(["dest@example.com"]);

    const list = await app.request(base, authed(key), env);
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as { drafts: { draft_id: string }[] };
    expect(listBody.drafts.map((d) => d.draft_id)).toContain(draft.draft_id);

    const got = await app.request(`${base}/${draft.draft_id}`, authed(key), env);
    expect(got.status).toBe(200);

    const patched = await app.request(
      `${base}/${draft.draft_id}`,
      authed(key, { method: "PATCH", body: JSON.stringify({ subject: "Updated" }) }),
      env
    );
    expect(patched.status).toBe(200);
    const patchedBody = (await patched.json()) as { subject: string; to: string[] };
    expect(patchedBody.subject).toBe("Updated");
    expect(patchedBody.to).toEqual(["dest@example.com"]);

    const deleted = await app.request(`${base}/${draft.draft_id}`, authed(key, { method: "DELETE" }), env);
    expect(deleted.status).toBe(204);
    const gone = await app.request(`${base}/${draft.draft_id}`, authed(key), env);
    expect(gone.status).toBe(404);
  });

  it("replays draft creation on the same client_id", async () => {
    const inbox = await seedInbox({ address: `d2-${crypto.randomUUID().slice(0, 6)}@wzrd.tech` });
    const key = await seedKey(inbox.org_id);
    const base = `/v0/inboxes/${encodeURIComponent(inbox.inbox_id)}/drafts`;
    const body = JSON.stringify({ to: ["a@example.com"], client_id: "draft-dupe-1" });
    const first = (await (await app.request(base, authed(key, { method: "POST", body }), env)).json()) as {
      draft_id: string;
    };
    const second = (await (await app.request(base, authed(key, { method: "POST", body }), env)).json()) as {
      draft_id: string;
    };
    expect(second.draft_id).toBe(first.draft_id);
  });

  it("separates draft-create and draft-send permissions", async () => {
    const inbox = await seedInbox({ address: `d3-${crypto.randomUUID().slice(0, 6)}@wzrd.tech` });
    const draftsOnly = await seedKey(inbox.org_id, { permissions: "read,drafts" });
    const base = `/v0/inboxes/${encodeURIComponent(inbox.inbox_id)}/drafts`;

    const created = await app.request(
      base,
      authed(draftsOnly, {
        method: "POST",
        body: JSON.stringify({ to: ["dest@example.com"], text: "hello" })
      }),
      env
    );
    expect(created.status).toBe(201);
    const draft = (await created.json()) as { draft_id: string };

    const send = await app.request(
      `${base}/${draft.draft_id}/send`,
      authed(draftsOnly, { method: "POST", body: JSON.stringify({}) }),
      env
    );
    expect(send.status).toBe(403);

    // A `send` key may also create drafts.
    const sendKey = await seedKey(inbox.org_id, { permissions: "send" });
    const created2 = await app.request(
      base,
      authed(sendKey, { method: "POST", body: JSON.stringify({ to: ["x@example.com"] }) }),
      env
    );
    expect(created2.status).toBe(201);
  });

  it("sends a draft through the pipeline (scheduled) and blocks re-send", async () => {
    const inbox = await seedInbox({ address: `d4-${crypto.randomUUID().slice(0, 6)}@wzrd.tech` });
    const key = await seedKey(inbox.org_id);
    const base = `/v0/inboxes/${encodeURIComponent(inbox.inbox_id)}/drafts`;
    const created = await app.request(
      base,
      authed(key, {
        method: "POST",
        body: JSON.stringify({ to: ["dest@example.com"], subject: "Later", text: "soon" })
      }),
      env
    );
    const draft = (await created.json()) as { draft_id: string };

    const noRecipients = await app.request(
      base,
      authed(key, { method: "POST", body: JSON.stringify({ subject: "empty" }) }),
      env
    );
    const emptyDraft = (await noRecipients.json()) as { draft_id: string };
    const badSend = await app.request(
      `${base}/${emptyDraft.draft_id}/send`,
      authed(key, { method: "POST", body: JSON.stringify({}) }),
      env
    );
    expect(badSend.status).toBe(400);

    const sent = await app.request(
      `${base}/${draft.draft_id}/send`,
      authed(key, { method: "POST", body: JSON.stringify({ send_at: FUTURE }) }),
      env
    );
    expect(sent.status).toBe(200);
    const sentBody = (await sent.json()) as { message_id: string; state: string; send_at: string };
    expect(sentBody.state).toBe("scheduled");
    expect(sentBody.send_at).toBe(FUTURE);

    const after = await app.request(`${base}/${draft.draft_id}`, authed(key), env);
    const afterBody = (await after.json()) as { sent_message_id: string | null };
    expect(afterBody.sent_message_id).toBe(sentBody.message_id);

    const again = await app.request(
      `${base}/${draft.draft_id}/send`,
      authed(key, { method: "POST", body: JSON.stringify({}) }),
      env
    );
    expect(again.status).toBe(409);
  });
});

describe("scheduled send", () => {
  it("stores a scheduled message without calling the provider", async () => {
    const inbox = await seedInbox({ address: `s1-${crypto.randomUUID().slice(0, 6)}@wzrd.tech` });
    const provider = new StubProvider();
    const result = await sendMessage(env, provider, ctxFor(inbox), {
      to: ["later@example.com"],
      subject: "Scheduled",
      text: "See you then",
      send_at: FUTURE
    });
    expect(result.state).toBe("scheduled");
    expect(provider.sent).toHaveLength(0);
    const row = await env.DB.prepare("SELECT state, send_at FROM messages WHERE msg_id = ?")
      .bind(result.message_id)
      .first<{ state: string; send_at: string }>();
    expect(row?.state).toBe("scheduled");
    expect(row?.send_at).toBe(FUTURE);
  });

  it("delivers due scheduled messages via the cron sweep", async () => {
    const inbox = await seedInbox({ address: `s2-${crypto.randomUUID().slice(0, 6)}@wzrd.tech` });
    const provider = new StubProvider();
    const result = await sendMessage(env, provider, ctxFor(inbox), {
      to: ["due@example.com"],
      subject: "Due",
      text: "now",
      send_at: FUTURE
    });
    // Not due yet.
    expect(await deliverDueScheduled(env, provider)).toBe(0);
    // Due once the clock passes send_at.
    const later = new Date(new Date(FUTURE).getTime() + 1000);
    expect(await deliverDueScheduled(env, provider, later)).toBe(1);
    expect(provider.sent).toHaveLength(1);
    expect(provider.sent[0]!.to).toEqual(["due@example.com"]);
    const row = await env.DB.prepare("SELECT state FROM messages WHERE msg_id = ?")
      .bind(result.message_id)
      .first<{ state: string }>();
    expect(row?.state).toBe("sent");
    const event = await env.DB.prepare(
      "SELECT event_id FROM events WHERE org_id = ? AND type = 'message.sent'"
    )
      .bind(inbox.org_id)
      .first();
    expect(event).not.toBeNull();
  });

  it("cancels a pending scheduled send via DELETE and skips it in the sweep", async () => {
    const inbox = await seedInbox({ address: `s3-${crypto.randomUUID().slice(0, 6)}@wzrd.tech` });
    const key = await seedKey(inbox.org_id);
    const provider = new StubProvider();
    const result = await sendMessage(env, provider, ctxFor(inbox), {
      to: ["cancel@example.com"],
      subject: "Cancel me",
      text: "never",
      send_at: FUTURE
    });
    const del = await app.request(
      `/v0/inboxes/${encodeURIComponent(inbox.inbox_id)}/messages/${result.message_id}`,
      authed(key, { method: "DELETE" }),
      env
    );
    expect(del.status).toBe(204);
    const later = new Date(new Date(FUTURE).getTime() + 1000);
    expect(await deliverDueScheduled(env, provider, later)).toBe(0);
    expect(provider.sent).toHaveLength(0);
  });

  it("normalizes an offset send_at to UTC", async () => {
    const inbox = await seedInbox({ address: `s5-${crypto.randomUUID().slice(0, 6)}@wzrd.tech` });
    const provider = new StubProvider();
    // Naive wall-clock ten hours ahead with a +05:00 offset = five hours from now.
    const naive = new Date(Date.now() + 10 * 60 * 60 * 1000);
    const local = `${naive.toISOString().slice(0, 19)}+05:00`;
    const result = await sendMessage(env, provider, ctxFor(inbox), {
      to: ["tz@example.com"],
      subject: "Offset",
      send_at: local
    });
    const row = await env.DB.prepare("SELECT send_at FROM messages WHERE msg_id = ?")
      .bind(result.message_id)
      .first<{ send_at: string }>();
    expect(row?.send_at).toBe(new Date(local).toISOString());
    expect(row?.send_at?.endsWith("Z")).toBe(true);
  });

  it("settles abandoned queued claims as failed instead of stranding them", async () => {
    const inbox = await seedInbox({ address: `s6-${crypto.randomUUID().slice(0, 6)}@wzrd.tech` });
    const provider = new StubProvider();
    const result = await sendMessage(env, provider, ctxFor(inbox), {
      to: ["stuck@example.com"],
      subject: "Stuck",
      send_at: FUTURE
    });
    // Simulate a dispatch that claimed the row but died before finalizing.
    const stale = new Date(new Date(FUTURE).getTime() + 1000).toISOString();
    await env.DB.prepare("UPDATE messages SET state = 'queued', updated_at = ? WHERE msg_id = ?")
      .bind(stale, result.message_id)
      .run();
    const past = new Date(new Date(FUTURE).getTime() + 20 * 60 * 1000);
    await deliverDueScheduled(env, provider, past);
    const row = await env.DB.prepare("SELECT state FROM messages WHERE msg_id = ?")
      .bind(result.message_id)
      .first<{ state: string }>();
    expect(row?.state).toBe("failed");
    expect(provider.sent).toHaveLength(0);
  });

  it("lists scheduled messages with folder=scheduled", async () => {
    const inbox = await seedInbox({ address: `s4-${crypto.randomUUID().slice(0, 6)}@wzrd.tech` });
    const key = await seedKey(inbox.org_id);
    const provider = new StubProvider();
    const result = await sendMessage(env, provider, ctxFor(inbox), {
      to: ["folder@example.com"],
      subject: "In folder",
      send_at: FUTURE
    });
    await seedMessage(inbox);
    const res = await app.request(
      `/v0/inboxes/${encodeURIComponent(inbox.inbox_id)}/messages?folder=scheduled`,
      authed(key),
      env
    );
    const body = (await res.json()) as { messages: { message_id: string }[] };
    expect(body.messages.map((m) => m.message_id)).toEqual([result.message_id]);
  });
});

describe("trash and folders", () => {
  it("soft-deletes a message, hides it from default lists, shows in trash, restores", async () => {
    const inbox = await seedInbox({ address: `t1-${crypto.randomUUID().slice(0, 6)}@wzrd.tech` });
    const key = await seedKey(inbox.org_id);
    const { msg_id } = await seedMessage(inbox);
    const msgBase = `/v0/inboxes/${encodeURIComponent(inbox.inbox_id)}/messages`;

    const del = await app.request(`${msgBase}/${msg_id}`, authed(key, { method: "DELETE" }), env);
    expect(del.status).toBe(204);

    const still = await env.DB.prepare("SELECT deleted_at FROM messages WHERE msg_id = ?")
      .bind(msg_id)
      .first<{ deleted_at: string | null }>();
    expect(still?.deleted_at).not.toBeNull();

    const defaults = (await (await app.request(msgBase, authed(key), env)).json()) as {
      messages: { message_id: string }[];
    };
    expect(defaults.messages.map((m) => m.message_id)).not.toContain(msg_id);

    const trash = (await (
      await app.request(`${msgBase}?folder=trash`, authed(key), env)
    ).json()) as { messages: { message_id: string }[] };
    expect(trash.messages.map((m) => m.message_id)).toContain(msg_id);

    const restored = await app.request(
      `${msgBase}/${msg_id}/restore`,
      authed(key, { method: "POST" }),
      env
    );
    expect(restored.status).toBe(200);
    const back = (await (await app.request(msgBase, authed(key), env)).json()) as {
      messages: { message_id: string }[];
    };
    expect(back.messages.map((m) => m.message_id)).toContain(msg_id);
  });

  it("soft-deletes and restores a thread with its messages", async () => {
    const inbox = await seedInbox({ address: `t2-${crypto.randomUUID().slice(0, 6)}@wzrd.tech` });
    const key = await seedKey(inbox.org_id);
    const { msg_id, thread_id } = await seedMessage(inbox);
    const threadBase = `/v0/inboxes/${encodeURIComponent(inbox.inbox_id)}/threads`;

    const del = await app.request(`${threadBase}/${thread_id}`, authed(key, { method: "DELETE" }), env);
    expect(del.status).toBe(204);

    const defaults = (await (await app.request(threadBase, authed(key), env)).json()) as {
      threads: { thread_id: string }[];
    };
    expect(defaults.threads.map((t) => t.thread_id)).not.toContain(thread_id);

    const trash = (await (
      await app.request(`${threadBase}?folder=trash`, authed(key), env)
    ).json()) as { threads: { thread_id: string }[] };
    expect(trash.threads.map((t) => t.thread_id)).toContain(thread_id);

    const restored = await app.request(
      `${threadBase}/${thread_id}/restore`,
      authed(key, { method: "POST" }),
      env
    );
    expect(restored.status).toBe(200);
    const msgRow = await env.DB.prepare("SELECT deleted_at FROM messages WHERE msg_id = ?")
      .bind(msg_id)
      .first<{ deleted_at: string | null }>();
    expect(msgRow?.deleted_at).toBeNull();
    const back = (await (await app.request(threadBase, authed(key), env)).json()) as {
      threads: { thread_id: string }[];
    };
    expect(back.threads.map((t) => t.thread_id)).toContain(thread_id);
  });

  it("shows a trashed thread's messages in its detail view", async () => {
    const inbox = await seedInbox({ address: `t4-${crypto.randomUUID().slice(0, 6)}@wzrd.tech` });
    const key = await seedKey(inbox.org_id);
    const { msg_id, thread_id } = await seedMessage(inbox);
    const threadBase = `/v0/inboxes/${encodeURIComponent(inbox.inbox_id)}/threads`;
    await app.request(`${threadBase}/${thread_id}`, authed(key, { method: "DELETE" }), env);
    const detail = await app.request(`${threadBase}/${thread_id}`, authed(key), env);
    expect(detail.status).toBe(200);
    const body = (await detail.json()) as { messages: { message_id: string }[] };
    expect(body.messages.map((m) => m.message_id)).toContain(msg_id);
  });

  it("purges trash older than 30 days and keeps newer trash", async () => {
    const inbox = await seedInbox({ address: `t3-${crypto.randomUUID().slice(0, 6)}@wzrd.tech` });
    const old = await seedMessage(inbox, {
      deleted_at: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString()
    });
    const recent = await seedMessage(inbox, { deleted_at: new Date().toISOString() });
    await purgeExpiredTrash(env);
    const oldRow = await env.DB.prepare("SELECT msg_id FROM messages WHERE msg_id = ?")
      .bind(old.msg_id)
      .first();
    expect(oldRow).toBeNull();
    const recentRow = await env.DB.prepare("SELECT msg_id FROM messages WHERE msg_id = ?")
      .bind(recent.msg_id)
      .first();
    expect(recentRow).not.toBeNull();
  });
});

describe("inbox-scoped draft-only keys", () => {
  async function seedInboxKey(orgId: string, inboxId: string, permissions: string): Promise<string> {
    const key = `wm_test_${crypto.randomUUID().replaceAll("-", "")}`;
    await env.DB.prepare(
      "INSERT INTO api_keys (key_id, org_id, pod_id, inbox_id, key_hash, key_prefix, permissions, created_at) VALUES (?, ?, NULL, ?, ?, ?, ?, ?)"
    )
      .bind(`key_${crypto.randomUUID().slice(0, 8)}`, orgId, inboxId, await hashApiKey(key), key.slice(0, 12), permissions, NOW)
      .run();
    return key;
  }

  it("a read,drafts inbox key can draft but cannot send or reach other inboxes", async () => {
    const inbox = await seedInbox({ address: `idk-${crypto.randomUUID().slice(0, 6)}@wzrd.tech` });
    const sibling = await seedInbox({ address: `idk2-${crypto.randomUUID().slice(0, 6)}@wzrd.tech` });
    await env.DB.prepare("UPDATE inboxes SET org_id = ?, pod_id = ? WHERE inbox_id = ?")
      .bind(inbox.org_id, inbox.pod_id, sibling.inbox_id)
      .run();
    const key = await seedInboxKey(inbox.org_id, inbox.inbox_id, "read,drafts");
    const base = `/v0/inboxes/${encodeURIComponent(inbox.inbox_id)}`;

    const created = await app.request(
      `${base}/drafts`,
      authed(key, { method: "POST", body: JSON.stringify({ to: ["dest@example.com"], text: "hi" }) }),
      env
    );
    expect(created.status).toBe(201);
    const draft = (await created.json()) as { draft_id: string };

    const send = await app.request(
      `${base}/drafts/${draft.draft_id}/send`,
      authed(key, { method: "POST", body: JSON.stringify({}) }),
      env
    );
    expect(send.status).toBe(403);

    const direct = await app.request(
      `${base}/messages/send`,
      authed(key, { method: "POST", body: JSON.stringify({ to: ["dest@example.com"], text: "hi" }) }),
      env
    );
    expect(direct.status).toBe(403);

    const otherDraft = await app.request(
      `/v0/inboxes/${encodeURIComponent(sibling.inbox_id)}/drafts`,
      authed(key, { method: "POST", body: JSON.stringify({ to: ["dest@example.com"], text: "hi" }) }),
      env
    );
    expect(otherDraft.status).toBe(403);
    const otherList = await app.request(
      `/v0/inboxes/${encodeURIComponent(sibling.inbox_id)}/messages`,
      authed(key),
      env
    );
    expect(otherList.status).toBe(403);

    // Minting keys needs admin, so a draft-only key cannot escalate itself.
    const mint = await app.request(
      "/v0/api-keys",
      authed(key, { method: "POST", body: JSON.stringify({ name: "up", permissions: ["send"] }) }),
      env
    );
    expect(mint.status).toBe(403);
    const hooks = await app.request(
      "/v0/webhooks",
      authed(key, { method: "POST", body: JSON.stringify({ url: "https://example.com/hook" }) }),
      env
    );
    expect(hooks.status).toBe(403);
  });
});
