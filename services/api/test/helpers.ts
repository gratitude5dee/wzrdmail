import { env } from "cloudflare:test";

export const NOW = new Date().toISOString();

export async function seedInbox(options?: {
  verified?: boolean;
  address?: string;
}): Promise<{ org_id: string; pod_id: string; inbox_id: string }> {
  const address = options?.address ?? "scout@wzrd.tech";
  const [username, domain] = address.split("@") as [string, string];
  const orgId = `org_test_${crypto.randomUUID().slice(0, 8)}`;
  const podId = `pod_test_${crypto.randomUUID().slice(0, 8)}`;
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO organizations (org_id, name, human_email, verified, created_at, updated_at) VALUES (?, 'test', ?, ?, ?, ?)"
    ).bind(orgId, `${orgId}@example.com`, options?.verified === false ? 0 : 1, NOW, NOW),
    env.DB.prepare(
      "INSERT INTO pods (pod_id, org_id, created_at) VALUES (?, ?, ?)"
    ).bind(podId, orgId, NOW),
    env.DB.prepare(
      "INSERT INTO inboxes (inbox_id, org_id, pod_id, username, domain, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).bind(address, orgId, podId, username, domain, NOW, NOW)
  ]);
  return { org_id: orgId, pod_id: podId, inbox_id: address };
}

export function fixtureBuffer(fixtures: Record<string, string>, name: string): ArrayBuffer {
  const text = fixtures[name];
  if (!text) throw new Error(`missing fixture ${name}`);
  const bytes = new TextEncoder().encode(text.replace(/\r?\n/g, "\r\n"));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
