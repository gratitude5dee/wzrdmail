import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { hashApiKey } from "../src/auth.js";
import { NOW, seedInbox } from "./helpers.js";

const app = createApp();

async function seedKey(orgId: string, podId: string | null = null, permissions = "admin"): Promise<string> {
  const key = `wm_test_${crypto.randomUUID().replaceAll("-", "")}`;
  await env.DB.prepare(
    "INSERT INTO api_keys (key_id, org_id, pod_id, key_hash, key_prefix, permissions, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  )
    .bind(`key_${crypto.randomUUID().slice(0, 8)}`, orgId, podId, await hashApiKey(key), key.slice(0, 12), permissions, NOW)
    .run();
  return key;
}

function authed(key: string, init?: RequestInit): RequestInit {
  return {
    ...init,
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }
  };
}

describe("pods", () => {
  it("creates a pod with client_id, replays the same pod on retry, and lists it", async () => {
    const seeded = await seedInbox();
    const key = await seedKey(seeded.org_id);
    const body = JSON.stringify({ client_id: "user_123" });
    const first = await app.request("/v0/pods", authed(key, { method: "POST", body }), env);
    expect(first.status).toBe(201);
    const created = (await first.json()) as { pod_id: string; client_id: string; organization_id: string };
    expect(created.client_id).toBe("user_123");
    expect(created.organization_id).toBe(seeded.org_id);

    const retry = await app.request("/v0/pods", authed(key, { method: "POST", body }), env);
    expect(retry.status).toBe(201);
    expect(((await retry.json()) as { pod_id: string }).pod_id).toBe(created.pod_id);

    const list = await app.request("/v0/pods", authed(key), env);
    expect(list.status).toBe(200);
    const listed = (await list.json()) as { pods: Array<{ pod_id: string; client_id: string | null }> };
    expect(listed.pods.map((p) => p.pod_id)).toEqual(expect.arrayContaining([seeded.pod_id, created.pod_id]));
    expect(listed.pods.find((p) => p.pod_id === created.pod_id)?.client_id).toBe("user_123");

    const get = await app.request(`/v0/pods/${created.pod_id}`, authed(key), env);
    expect(get.status).toBe(200);
  });

  it("creates an inbox inside a chosen pod via body pod_id and the /pods/:id/inboxes alias", async () => {
    const seeded = await seedInbox();
    const key = await seedKey(seeded.org_id);
    const podRes = await app.request(
      "/v0/pods",
      authed(key, { method: "POST", body: JSON.stringify({ client_id: "user_a" }) }),
      env
    );
    const pod = (await podRes.json()) as { pod_id: string };

    const foreign = await app.request(
      "/v0/inboxes",
      authed(key, { method: "POST", body: JSON.stringify({ username: "nope", pod_id: "pod_does_not_exist" }) }),
      env
    );
    expect(foreign.status).toBe(404);

    const viaBody = await app.request(
      "/v0/inboxes",
      authed(key, { method: "POST", body: JSON.stringify({ username: "via-body", pod_id: pod.pod_id }) }),
      env
    );
    expect(viaBody.status).toBe(201);
    expect(((await viaBody.json()) as { pod_id: string }).pod_id).toBe(pod.pod_id);

    const viaAlias = await app.request(
      `/v0/pods/${pod.pod_id}/inboxes`,
      authed(key, { method: "POST", body: JSON.stringify({ username: "via-alias" }) }),
      env
    );
    expect(viaAlias.status).toBe(201);
    expect(((await viaAlias.json()) as { pod_id: string }).pod_id).toBe(pod.pod_id);
  });

  it("pod-scoped keys see only their pod and cannot create or delete pods", async () => {
    const seeded = await seedInbox();
    const adminKey = await seedKey(seeded.org_id);
    const otherRes = await app.request(
      "/v0/pods",
      authed(adminKey, { method: "POST", body: JSON.stringify({ client_id: "user_b" }) }),
      env
    );
    const other = (await otherRes.json()) as { pod_id: string };
    const podKey = await seedKey(seeded.org_id, seeded.pod_id);

    const list = await app.request("/v0/pods", authed(podKey), env);
    const listed = (await list.json()) as { pods: Array<{ pod_id: string }> };
    expect(listed.pods.map((p) => p.pod_id)).toEqual([seeded.pod_id]);

    expect((await app.request(`/v0/pods/${other.pod_id}`, authed(podKey), env)).status).toBe(404);
    expect(
      (await app.request("/v0/pods", authed(podKey, { method: "POST", body: JSON.stringify({}) }), env)).status
    ).toBe(403);
    expect((await app.request(`/v0/pods/${seeded.pod_id}`, authed(podKey, { method: "DELETE" }), env)).status).toBe(403);
    expect(
      (
        await app.request(
          "/v0/inboxes",
          authed(podKey, { method: "POST", body: JSON.stringify({ username: "cross", pod_id: other.pod_id }) }),
          env
        )
      ).status
    ).toBe(403);
  });

  it("deleting a pod soft-deletes its inboxes and revokes its scoped keys; the last pod cannot be deleted", async () => {
    const seeded = await seedInbox();
    const key = await seedKey(seeded.org_id);
    const podRes = await app.request(
      "/v0/pods",
      authed(key, { method: "POST", body: JSON.stringify({ client_id: "user_c" }) }),
      env
    );
    const pod = (await podRes.json()) as { pod_id: string };
    const inboxRes = await app.request(
      `/v0/pods/${pod.pod_id}/inboxes`,
      authed(key, { method: "POST", body: JSON.stringify({ username: "doomed" }) }),
      env
    );
    const inbox = (await inboxRes.json()) as { inbox_id: string };
    const podKey = await seedKey(seeded.org_id, pod.pod_id);
    const inboxKeyRes = await app.request(
      "/v0/api-keys",
      authed(key, {
        method: "POST",
        body: JSON.stringify({ name: "box", inbox_id: inbox.inbox_id, permissions: ["read", "drafts"] })
      }),
      env
    );
    const inboxKey = ((await inboxKeyRes.json()) as { api_key: string }).api_key;
    expect((await app.request("/v0/pods", authed(podKey), env)).status).toBe(200);
    expect((await app.request(`/v0/inboxes/${inbox.inbox_id}`, authed(inboxKey), env)).status).toBe(200);

    const del = await app.request(`/v0/pods/${pod.pod_id}`, authed(key, { method: "DELETE" }), env);
    expect(del.status).toBe(204);
    expect((await app.request(`/v0/pods/${pod.pod_id}`, authed(key), env)).status).toBe(404);
    expect((await app.request(`/v0/inboxes/${inbox.inbox_id}`, authed(key), env)).status).toBe(404);
    expect((await app.request("/v0/pods", authed(podKey), env)).status).toBe(401);
    expect((await app.request(`/v0/inboxes/${inbox.inbox_id}`, authed(inboxKey), env)).status).toBe(401);
    expect((await app.request("/v0/pods", authed(key), env)).status).toBe(200);

    const last = await app.request(`/v0/pods/${seeded.pod_id}`, authed(key, { method: "DELETE" }), env);
    expect(last.status).toBe(409);

    const recreate = await app.request(
      "/v0/pods",
      authed(key, { method: "POST", body: JSON.stringify({ client_id: "user_c" }) }),
      env
    );
    expect(recreate.status).toBe(201);
    const recreated = (await recreate.json()) as { pod_id: string };
    expect(recreated.pod_id).not.toBe(pod.pod_id);
    expect((await app.request(`/v0/pods/${recreated.pod_id}`, authed(key), env)).status).toBe(200);
  });
});
