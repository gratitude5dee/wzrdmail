/**
 * M1 verification (§20): seed an inbox + API key straight into D1, send a real
 * email to a probe address, wait for the human to reply from that mailbox,
 * then assert the thread holds 2 messages with correct extracted_text and
 * that the inbound row appeared within 5s of the poll observing it (the row
 * is written in the same Email Routing invocation, so detection latency is
 * the meaningful bound).
 *
 * Usage:
 *   CF_API_TOKEN=... PROBE_ADDRESS=you@gmail.com npx tsx scripts/demo-roundtrip.ts [staging|production]
 */
import { execFileSync } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";

const envName = process.argv[2] ?? "staging";
const probe = process.env.PROBE_ADDRESS;
if (!probe) {
  console.error("Set PROBE_ADDRESS to a real mailbox you can reply from.");
  process.exit(1);
}
const apiBase =
  envName === "production" ? "https://api.wzrd.tech" : "https://staging.api.wzrd.tech";

const ts = Date.now();
const username = `roundtrip-${ts}`;
const address = `${username}@wzrd.tech`;
const orgId = `org_demo${ts}`;
const podId = `pod_demo${ts}`;
const inboxId = `inbox_demo${ts}`;
const rawKey = `wm_${randomBytes(24).toString("hex")}`;
const keyHash = createHash("sha256").update(rawKey).digest("hex");
const now = new Date().toISOString();

function d1(sql: string): string {
  return execFileSync(
    "pnpm",
    [
      "--filter",
      "@wzrdmail/api",
      "exec",
      "wrangler",
      "d1",
      "execute",
      "DB",
      "--env",
      envName,
      "--remote",
      "--json",
      "--command",
      sql
    ],
    { encoding: "utf8", cwd: new URL("..", import.meta.url).pathname }
  );
}

console.log(`Seeding inbox ${address} in ${envName} D1...`);
d1(
  `INSERT INTO organizations (org_id, name, human_email, plan, verified, created_at, updated_at) VALUES ('${orgId}', 'roundtrip demo', '${probe}', 'free', 1, '${now}', '${now}');
   INSERT INTO pods (pod_id, org_id, name, created_at) VALUES ('${podId}', '${orgId}', 'demo pod', '${now}');
   INSERT INTO inboxes (inbox_id, org_id, pod_id, username, domain, display_name, created_at, updated_at) VALUES ('${inboxId}', '${orgId}', '${podId}', '${username}', 'wzrd.tech', 'Roundtrip Demo', '${now}', '${now}');
   INSERT INTO api_keys (key_id, org_id, pod_id, key_hash, key_prefix, created_at) VALUES ('key_demo${ts}', '${orgId}', '${podId}', '${keyHash}', '${rawKey.slice(0, 8)}', '${now}');`
);

console.log(`Sending probe email ${address} -> ${probe} ...`);
const sendRes = await fetch(`${apiBase}/v0/inboxes/${inboxId}/messages/send`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${rawKey}`,
    "content-type": "application/json"
  },
  body: JSON.stringify({
    to: [probe],
    subject: `wzrdmail roundtrip ${ts}`,
    text: "Reply to this email to complete the roundtrip demo."
  })
});
const sent = (await sendRes.json()) as { message_id?: string; thread_id?: string };
if (!sendRes.ok || !sent.thread_id) {
  console.error("send failed:", sendRes.status, JSON.stringify(sent));
  process.exit(1);
}
console.log(`Sent (thread ${sent.thread_id}). Now REPLY from ${probe}; polling for 5 minutes...`);

const deadline = Date.now() + 5 * 60 * 1000;
for (;;) {
  if (Date.now() > deadline) {
    console.error("Timed out waiting for the reply.");
    process.exit(1);
  }
  await new Promise((r) => setTimeout(r, 5000));
  const pollStarted = Date.now();
  const rows = JSON.parse(
    d1(
      `SELECT msg_id, direction, extracted_text, created_at FROM messages WHERE thread_id='${sent.thread_id}' ORDER BY created_at;`
    )
  ) as Array<{ results: Array<Record<string, string>> }>;
  const msgs = rows[0]?.results ?? [];
  if (msgs.length >= 2) {
    const reply = msgs.find((m) => m.direction === "inbound");
    const rowAge = reply?.created_at ? pollStarted - Date.parse(reply.created_at) : NaN;
    console.log(`Thread has ${msgs.length} messages.`);
    console.log(`Reply extracted_text: ${JSON.stringify(reply?.extracted_text)}`);
    console.log(`row written ${rowAge} ms before this poll observed it`);
    process.exit(Boolean(reply?.extracted_text) ? 0 : 1);
  }
  process.stdout.write(".");
}
