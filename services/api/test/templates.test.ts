import { env } from "cloudflare:test";
import type { MailProvider, OutboundMime, SendOutcome } from "@wzrdmail/core";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { hashApiKey } from "../src/auth.js";
import { sendMessage, type SendContext } from "../src/egress/send.js";
import { seedInbox, NOW } from "./helpers.js";

const app = createApp();

class StubProvider implements MailProvider {
  sent: OutboundMime[] = [];
  send(msg: OutboundMime): Promise<SendOutcome> {
    this.sent.push(msg);
    return Promise.resolve({ providerMessageId: "prov-1", accepted: [...msg.to], rejected: [] });
  }
  requiredDnsRecords(): never[] {
    return [];
  }
  verifyDomain(): Promise<{ verified: boolean; pending: never[] }> {
    return Promise.resolve({ verified: true, pending: [] });
  }
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

async function seedKey(orgId: string, permissions = "admin"): Promise<string> {
  const key = `wm_test_${crypto.randomUUID().replaceAll("-", "")}`;
  await env.DB.prepare(
    "INSERT INTO api_keys (key_id, org_id, key_hash, key_prefix, permissions, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  )
    .bind(`key_${crypto.randomUUID().slice(0, 8)}`, orgId, await hashApiKey(key), key.slice(0, 12), permissions, NOW)
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

async function createTemplate(
  key: string,
  body: Record<string, unknown>
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await app.request(
    "/v0/templates",
    authed(key, { method: "POST", body: JSON.stringify(body) }),
    env
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const TEMPLATE_BODY = {
  name: "Welcome",
  alias: "welcome-v1",
  subject: "Welcome, {{name}}!",
  text: "Hi {{name}}, your code is {{{code}}}.",
  html: "<p>Hi {{name}}</p>",
  variables: [
    { key: "name", type: "string" },
    { key: "code", type: "string", fallback_value: "000000" }
  ]
};

describe("templates CRUD", () => {
  it("creates, lists, reads, updates and deletes a template", async () => {
    const inbox = await seedInbox();
    const key = await seedKey(inbox.org_id);

    const created = await createTemplate(key, TEMPLATE_BODY);
    expect(created.status).toBe(201);
    const t = created.body;
    expect(t.template_id).toMatch(/^tpl_/);
    expect(t.status).toBe("draft");
    expect(t.published).toBeNull();
    expect(t.organization_id).toBe(inbox.org_id);

    const list = await app.request("/v0/templates", authed(key), env);
    expect(list.status).toBe(200);
    const listBody = await list.json<{ templates: { template_id: string }[] }>();
    expect(listBody.templates.map((x) => x.template_id)).toContain(t.template_id);

    const get = await app.request(`/v0/templates/${t.template_id}`, authed(key), env);
    expect(get.status).toBe(200);
    expect(await get.json<{ name: string }>()).toMatchObject({ name: "Welcome" });

    const patch = await app.request(
      `/v0/templates/${t.template_id}`,
      authed(key, { method: "PATCH", body: JSON.stringify({ name: "Welcome v2" }) }),
      env
    );
    expect(patch.status).toBe(200);
    expect(await patch.json<{ name: string }>()).toMatchObject({ name: "Welcome v2" });

    const del = await app.request(`/v0/templates/${t.template_id}`, authed(key, { method: "DELETE" }), env);
    expect(del.status).toBe(204);
    const gone = await app.request(`/v0/templates/${t.template_id}`, authed(key), env);
    expect(gone.status).toBe(404);
  });

  it("replays creates on client_id", async () => {
    const inbox = await seedInbox();
    const key = await seedKey(inbox.org_id);
    const first = await createTemplate(key, { ...TEMPLATE_BODY, client_id: "c-1" });
    const second = await createTemplate(key, { ...TEMPLATE_BODY, client_id: "c-1" });
    expect(first.body.template_id).toBe(second.body.template_id);
  });

  it("rejects duplicate aliases", async () => {
    const inbox = await seedInbox();
    const key = await seedKey(inbox.org_id);
    await createTemplate(key, TEMPLATE_BODY);
    const dup = await createTemplate(key, { ...TEMPLATE_BODY, name: "Other" });
    expect(dup.status).toBe(409);
    expect(dup.body).toMatchObject({ name: "conflict" });
  });

  it("enforces permissions: read key cannot write, admin can read", async () => {
    const inbox = await seedInbox();
    const readKey = await seedKey(inbox.org_id, "read");
    const write = await createTemplate(readKey, TEMPLATE_BODY);
    expect(write.status).toBe(403);
    const read = await app.request("/v0/templates", authed(readKey), env);
    expect(read.status).toBe(200);
  });

  it("isolates templates per org", async () => {
    const a = await seedInbox({ address: "a@wzrd.tech" });
    const b = await seedInbox({ address: "b@wzrd.tech" });
    const keyA = await seedKey(a.org_id);
    const keyB = await seedKey(b.org_id);
    const created = await createTemplate(keyA, TEMPLATE_BODY);
    const res = await app.request(`/v0/templates/${created.body.template_id}`, authed(keyB), env);
    expect(res.status).toBe(404);
  });
});

describe("publish + duplicate", () => {
  it("publish snapshots the draft; duplicate makes an unpublished copy", async () => {
    const inbox = await seedInbox();
    const key = await seedKey(inbox.org_id);
    const created = await createTemplate(key, TEMPLATE_BODY);
    const id = created.body.template_id as string;

    const pub = await app.request(`/v0/templates/${id}/publish`, authed(key, { method: "POST" }), env);
    expect(pub.status).toBe(200);
    const pubBody = await pub.json<{ status: string; published: { subject: string } | null }>();
    expect(pubBody.status).toBe("published");
    expect(pubBody.published?.subject).toBe("Welcome, {{name}}!");

    const dup = await app.request(`/v0/templates/${id}/duplicate`, authed(key, { method: "POST" }), env);
    expect(dup.status).toBe(201);
    const dupBody = await dup.json<{ name: string; status: string; alias: string | null }>();
    expect(dupBody.name).toBe("Welcome (copy)");
    expect(dupBody.status).toBe("draft");
    expect(dupBody.alias).toBeNull();
  });

  it("refuses to publish a bodiless template", async () => {
    const inbox = await seedInbox();
    const key = await seedKey(inbox.org_id);
    const created = await createTemplate(key, { name: "Empty", subject: "hi" });
    const pub = await app.request(
      `/v0/templates/${created.body.template_id}/publish`,
      authed(key, { method: "POST" }),
      env
    );
    expect(pub.status).toBe(400);
  });
});

describe("send with template", () => {
  it("renders the published snapshot with variables at send time", async () => {
    const inbox = await seedInbox();
    const key = await seedKey(inbox.org_id);
    const created = await createTemplate(key, TEMPLATE_BODY);
    const id = created.body.template_id as string;
    await app.request(`/v0/templates/${id}/publish`, authed(key, { method: "POST" }), env);

    const provider = new StubProvider();
    const result = await sendMessage(env, provider, ctxFor(inbox), {
      to: ["dest@example.com"],
      subject: "",
      template: { id, variables: { name: "Ada" } }
    });
    expect(result.state).toBe("sent");
    expect(provider.sent[0]!.raw).toContain("Hi Ada, your code is 000000.");

    const msg = await env.DB.prepare("SELECT subject, text FROM messages WHERE msg_id = ?")
      .bind(result.message_id)
      .first<{ subject: string; text: string }>();
    expect(msg?.subject).toBe("Welcome, Ada!");
    expect(msg?.text).toContain("your code is 000000");
  });

  it("looks up templates by alias", async () => {
    const inbox = await seedInbox();
    const key = await seedKey(inbox.org_id);
    const created = await createTemplate(key, TEMPLATE_BODY);
    await app.request(
      `/v0/templates/${created.body.template_id}/publish`,
      authed(key, { method: "POST" }),
      env
    );
    const provider = new StubProvider();
    const result = await sendMessage(env, provider, ctxFor(inbox), {
      to: ["dest@example.com"],
      subject: "",
      template: { id: "welcome-v1", variables: { name: "Grace" } }
    });
    expect(result.state).toBe("sent");
    const msg = await env.DB.prepare("SELECT subject FROM messages WHERE msg_id = ?")
      .bind(result.message_id)
      .first<{ subject: string }>();
    expect(msg?.subject).toBe("Welcome, Grace!");
  });

  it("400s on missing required variables", async () => {
    const inbox = await seedInbox();
    const key = await seedKey(inbox.org_id);
    const created = await createTemplate(key, TEMPLATE_BODY);
    const id = created.body.template_id as string;
    await app.request(`/v0/templates/${id}/publish`, authed(key, { method: "POST" }), env);

    const res = await app.request(
      `/v0/inboxes/${encodeURIComponent(inbox.inbox_id)}/messages/send`,
      authed(key, {
        method: "POST",
        body: JSON.stringify({ to: ["dest@example.com"], template: { id, variables: {} } })
      }),
      env
    );
    expect(res.status).toBe(400);
    expect(await res.json<{ name: string; message: string }>()).toMatchObject({
      name: "validation_error"
    });
  });

  it("400s on type-mismatched variable values", async () => {
    const inbox = await seedInbox();
    const key = await seedKey(inbox.org_id);
    const created = await createTemplate(key, TEMPLATE_BODY);
    const id = created.body.template_id as string;
    await app.request(`/v0/templates/${id}/publish`, authed(key, { method: "POST" }), env);

    const provider = new StubProvider();
    await expect(
      sendMessage(env, provider, ctxFor(inbox), {
        to: ["dest@example.com"],
        subject: "",
        template: { id, variables: { name: 42 } }
      })
    ).rejects.toMatchObject({ name: "validation_error" });
    expect(provider.sent).toHaveLength(0);
  });

  it("keeps sends on the published snapshot when the draft changes", async () => {
    const inbox = await seedInbox();
    const key = await seedKey(inbox.org_id);
    const created = await createTemplate(key, TEMPLATE_BODY);
    const id = created.body.template_id as string;
    await app.request(`/v0/templates/${id}/publish`, authed(key, { method: "POST" }), env);

    // Edit the draft — sends must still render the published body.
    await app.request(
      `/v0/templates/${id}`,
      authed(key, { method: "PATCH", body: JSON.stringify({ text: "DRAFT ONLY {{name}}" }) }),
      env
    );
    const provider = new StubProvider();
    const result = await sendMessage(env, provider, ctxFor(inbox), {
      to: ["dest@example.com"],
      subject: "",
      template: { id, variables: { name: "Ada" } }
    });
    expect(result.state).toBe("sent");
    expect(provider.sent[0]!.raw).toContain("your code is 000000");
    expect(provider.sent[0]!.raw).not.toContain("DRAFT ONLY");

    // Republish picks up the edit.
    await app.request(`/v0/templates/${id}/publish`, authed(key, { method: "POST" }), env);
    const provider2 = new StubProvider();
    await sendMessage(env, provider2, ctxFor(inbox), {
      to: ["dest@example.com"],
      subject: "",
      template: { id, variables: { name: "Ada" } }
    });
    expect(provider2.sent[0]!.raw).toContain("DRAFT ONLY Ada");
  });

  it("rejects send while the template is still a draft", async () => {
    const inbox = await seedInbox();
    const key = await seedKey(inbox.org_id);
    const created = await createTemplate(key, TEMPLATE_BODY);
    const provider = new StubProvider();
    await expect(
      sendMessage(env, provider, ctxFor(inbox), {
        to: ["dest@example.com"],
        subject: "",
        template: { id: created.body.template_id as string, variables: { name: "x" } }
      })
    ).rejects.toMatchObject({ name: "validation_error" });
  });

  it("rejects template+text at the route and render layers", async () => {
    const inbox = await seedInbox();
    const key = await seedKey(inbox.org_id);
    const created = await createTemplate(key, TEMPLATE_BODY);
    const id = created.body.template_id as string;
    await app.request(`/v0/templates/${id}/publish`, authed(key, { method: "POST" }), env);

    const res = await app.request(
      `/v0/inboxes/${encodeURIComponent(inbox.inbox_id)}/messages/send`,
      authed(key, {
        method: "POST",
        body: JSON.stringify({ to: ["dest@example.com"], text: "hi", template: { id } })
      }),
      env
    );
    expect(res.status).toBe(400);
    await expect(
      sendMessage(env, new StubProvider(), ctxFor(inbox), {
        to: ["dest@example.com"],
        subject: "",
        text: "hi",
        template: { id }
      } as Parameters<typeof sendMessage>[3])
    ).rejects.toMatchObject({ name: "validation_error" });
  });

  it("escapes {{var}} in html but not {{{var}}}", async () => {
    const inbox = await seedInbox();
    const key = await seedKey(inbox.org_id);
    const created = await createTemplate(key, {
      name: "Esc",
      html: "<b>{{name}}</b><i>{{{name}}}</i>",
      text: "{{name}}",
      variables: [{ key: "name", type: "string" }]
    });
    const id = created.body.template_id as string;
    await app.request(`/v0/templates/${id}/publish`, authed(key, { method: "POST" }), env);
    const provider = new StubProvider();
    await sendMessage(env, provider, ctxFor(inbox), {
      to: ["dest@example.com"],
      subject: "",
      template: { id, variables: { name: "<u>Ada</u>" } }
    });
    const raw = provider.sent[0]!.raw;
    expect(raw).toContain("<b>&lt;u&gt;Ada&lt;/u&gt;</b>");
    expect(raw).toContain("<i><u>Ada</u></i>");
  });
});
