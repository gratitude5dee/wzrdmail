import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ingestEmail } from "../src/ingress/pipeline.js";
import { fixtureBuffer, seedInbox, NOW } from "./helpers.js";

function ingest(name: string, envelopeTo = "scout@wzrd.tech") {
  return ingestEmail(env, {
    raw: fixtureBuffer(env.TEST_FIXTURES, name),
    rawKey: `raw/test/${crypto.randomUUID()}.eml`,
    envelopeFrom: "sender@example.com",
    envelopeTo
  });
}

describe("inbound pipeline (§6.1)", () => {
  it("returns unrouted when no inbox matches", async () => {
    const result = await ingest("simple.eml", "nobody@wzrd.tech");
    expect(result.kind).toBe("unrouted");
  });

  it("stores a simple message with thread, lookup row, and event", async () => {
    const inbox = await seedInbox();
    const result = await ingest("simple.eml");
    expect(result.kind).toBe("stored");
    if (result.kind !== "stored") return;

    const msg = await env.DB.prepare("SELECT * FROM messages WHERE msg_id = ?")
      .bind(result.msg_id)
      .first<Record<string, unknown>>();
    expect(msg?.inbox_id).toBe(inbox.inbox_id);
    expect(msg?.direction).toBe("inbound");
    expect(msg?.state).toBe("received");
    expect(msg?.from_addr).toBe("ada@example.com");
    expect(msg?.subject).toBe("Quarterly numbers");
    expect(msg?.extracted_text).toContain("quarterly numbers");
    expect(msg?.rfc822_message_id).toBe("<orig-1@example.com>");

    const thread = await env.DB.prepare("SELECT * FROM threads WHERE thread_id = ?")
      .bind(result.thread_id)
      .first<Record<string, unknown>>();
    expect(thread?.message_count).toBe(1);
    expect(thread?.normalized_subject).toBe("quarterly numbers");
    expect(JSON.parse(thread?.participants as string)).toContain("ada@example.com");
    expect(JSON.parse(thread?.labels as string)).toContain("unread");

    const lookup = await env.DB.prepare(
      "SELECT thread_id FROM message_id_lookup WHERE inbox_id = ? AND rfc822_message_id = ?"
    )
      .bind(inbox.inbox_id, "<orig-1@example.com>")
      .first<{ thread_id: string }>();
    expect(lookup?.thread_id).toBe(result.thread_id);

    const event = await env.DB.prepare(
      "SELECT payload FROM events WHERE org_id = ? AND type = 'message.received'"
    )
      .bind(inbox.org_id)
      .first<{ payload: string }>();
    const envelope = JSON.parse(event!.payload) as {
      data: { message: { extracted_text: string } };
    };
    expect(envelope.data.message.extracted_text).toContain("quarterly numbers");
  });

  it("threads a reply via References and strips quoted history", async () => {
    await seedInbox();
    const first = await ingest("simple.eml");
    expect(first.kind).toBe("stored");
    if (first.kind !== "stored") return;

    const reply = await ingest("reply-quoted.eml");
    expect(reply.kind).toBe("stored");
    if (reply.kind !== "stored") return;
    expect(reply.thread_id).toBe(first.thread_id);

    const msg = await env.DB.prepare("SELECT extracted_text FROM messages WHERE msg_id = ?")
      .bind(reply.msg_id)
      .first<{ extracted_text: string }>();
    expect(msg?.extracted_text).toContain("use the EU numbers");
    expect(msg?.extracted_text).not.toContain("wrote:");
    expect(msg?.extracted_text).not.toContain("EU region too");

    const thread = await env.DB.prepare("SELECT message_count FROM threads WHERE thread_id = ?")
      .bind(first.thread_id)
      .first<{ message_count: number }>();
    expect(thread?.message_count).toBe(2);
  });

  it("threads by normalized subject + participants when references are unknown", async () => {
    await seedInbox();
    // Reply arrives first (its references match nothing), original second.
    const reply = await ingest("reply-quoted.eml");
    const original = await ingest("simple.eml");
    expect(reply.kind).toBe("stored");
    expect(original.kind).toBe("stored");
    if (reply.kind !== "stored" || original.kind !== "stored") return;
    // "Re: Quarterly numbers" normalizes to "quarterly numbers"; same sender.
    expect(original.thread_id).toBe(reply.thread_id);
  });

  it("treats redelivery of the same Message-ID as a duplicate, not a new row", async () => {
    await seedInbox();
    const first = await ingest("simple.eml");
    expect(first.kind).toBe("stored");
    if (first.kind !== "stored") return;
    const again = await ingest("simple.eml");
    expect(again.kind).toBe("duplicate");
    if (again.kind !== "duplicate") return;
    expect(again.msg_id).toBe(first.msg_id);
    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM messages WHERE rfc822_message_id = '<orig-1@example.com>'"
    ).first<{ n: number }>();
    expect(count?.n).toBe(1);
    const thread = await env.DB.prepare("SELECT message_count FROM threads WHERE thread_id = ?")
      .bind(first.thread_id)
      .first<{ message_count: number }>();
    expect(thread?.message_count).toBe(1);
  });

  it("defers redelivery while another invocation holds a fresh claim", async () => {
    const inbox = await seedInbox();
    await env.DB.prepare(
      `INSERT INTO message_id_lookup (inbox_id, rfc822_message_id, thread_id, msg_id, committed, claimed_at)
       VALUES (?, '<orig-1@example.com>', 'thread_pending', 'msg_pending', 0, ?)`
    )
      .bind(inbox.inbox_id, new Date().toISOString())
      .run();
    await expect(ingest("simple.eml")).rejects.toMatchObject({ name: "IngestInFlightError" });
    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM messages WHERE rfc822_message_id = '<orig-1@example.com>'"
    ).first<{ n: number }>();
    expect(count?.n).toBe(0);
  });

  it("reclaims an abandoned pending claim and stores the message", async () => {
    const inbox = await seedInbox();
    const staleAt = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    await env.DB.prepare(
      `INSERT INTO message_id_lookup (inbox_id, rfc822_message_id, thread_id, msg_id, committed, claimed_at)
       VALUES (?, '<orig-1@example.com>', 'thread_dead', 'msg_dead', 0, ?)`
    )
      .bind(inbox.inbox_id, staleAt)
      .run();
    const result = await ingest("simple.eml");
    expect(result.kind).toBe("stored");
    if (result.kind !== "stored") return;
    const lookup = await env.DB.prepare(
      "SELECT msg_id, committed FROM message_id_lookup WHERE inbox_id = ? AND rfc822_message_id = '<orig-1@example.com>'"
    )
      .bind(inbox.inbox_id)
      .first<{ msg_id: string; committed: number }>();
    expect(lookup?.msg_id).toBe(result.msg_id);
    expect(lookup?.committed).toBe(1);
    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM messages WHERE rfc822_message_id = '<orig-1@example.com>'"
    ).first<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  it("does not merge unrelated senders' threads that share a subject", async () => {
    await seedInbox();
    const first = await ingestEmail(env, {
      raw: fixtureBuffer(env.TEST_FIXTURES, "simple.eml"),
      rawKey: "raw/test/a.eml",
      envelopeFrom: "ada@example.com",
      envelopeTo: "scout@wzrd.tech"
    });
    expect(first.kind).toBe("stored");
    if (first.kind !== "stored") return;
    // Same subject, different sender, no references.
    const otherRaw = new TextEncoder().encode(
      [
        "From: mallory@elsewhere.com",
        "To: scout@wzrd.tech",
        "Subject: Quarterly numbers",
        "Message-ID: <other-1@elsewhere.com>",
        "Content-Type: text/plain",
        "",
        "unrelated conversation"
      ].join("\r\n")
    ).buffer as ArrayBuffer;
    const other = await ingestEmail(env, {
      raw: otherRaw,
      rawKey: "raw/test/b.eml",
      envelopeFrom: "mallory@elsewhere.com",
      envelopeTo: "scout@wzrd.tech"
    });
    expect(other.kind).toBe("stored");
    if (other.kind !== "stored") return;
    expect(other.thread_id).not.toBe(first.thread_id);
  });

  it("truncates oversized bodies and sets body_truncated", async () => {
    await seedInbox();
    const bigBody = "x".repeat(70 * 1024);
    const raw = new TextEncoder().encode(
      [
        "From: ada@example.com",
        "To: scout@wzrd.tech",
        "Subject: big one",
        "Message-ID: <big-1@example.com>",
        "Content-Type: text/plain",
        "",
        bigBody
      ].join("\r\n")
    ).buffer as ArrayBuffer;
    const result = await ingestEmail(env, {
      raw,
      rawKey: "raw/test/big.eml",
      envelopeFrom: "ada@example.com",
      envelopeTo: "scout@wzrd.tech"
    });
    expect(result.kind).toBe("stored");
    if (result.kind !== "stored") return;
    const msg = await env.DB.prepare(
      "SELECT text, body_truncated, raw_key FROM messages WHERE msg_id = ?"
    )
      .bind(result.msg_id)
      .first<{ text: string; body_truncated: number; raw_key: string }>();
    expect(msg?.body_truncated).toBe(1);
    expect(msg?.text.length).toBe(64 * 1024);
    expect(msg?.raw_key).toBe("raw/test/big.eml");
  });

  it("extracts html and extracted_html from multipart messages", async () => {
    await seedInbox();
    const result = await ingest("multipart-html.eml");
    expect(result.kind).toBe("stored");
    if (result.kind !== "stored") return;
    const msg = await env.DB.prepare(
      "SELECT html, extracted_html FROM messages WHERE msg_id = ?"
    )
      .bind(result.msg_id)
      .first<{ html: string; extracted_html: string }>();
    expect(msg?.html).toContain("blockquote");
    expect(msg?.extracted_html).not.toContain("blockquote");
    expect(msg?.extracted_html).toContain("Ship it");
  });

  it("stores attachments in R2 and D1", async () => {
    const inbox = await seedInbox();
    const result = await ingest("attachment.eml");
    expect(result.kind).toBe("stored");
    if (result.kind !== "stored") return;
    const att = await env.DB.prepare("SELECT * FROM attachments WHERE msg_id = ?")
      .bind(result.msg_id)
      .first<Record<string, unknown>>();
    expect(att?.filename).toBe("report.csv");
    expect(att?.content_type).toBe("text/csv");
    const object = await env.MAIL.get(`att/${inbox.inbox_id}/${result.msg_id}/${att?.att_id as string}`);
    expect(await object?.text()).toContain("EU,100");
  });

  it("turns a DSN bounce into message.bounced + suppression, not stored mail", async () => {
    const inbox = await seedInbox();
    // Seed the original outbound message the DSN references.
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO threads (thread_id, org_id, pod_id, inbox_id, last_message_at, created_at, updated_at)
         VALUES ('thread_t1', ?, ?, ?, ?, ?, ?)`
      ).bind(inbox.org_id, inbox.pod_id, inbox.inbox_id, NOW, NOW, NOW),
      env.DB.prepare(
        `INSERT INTO messages (msg_id, org_id, pod_id, inbox_id, thread_id, direction, state, from_addr, created_at, updated_at)
         VALUES ('msg_t1', ?, ?, ?, 'thread_t1', 'outbound', 'sent', ?, ?, ?)`
      ).bind(inbox.org_id, inbox.pod_id, inbox.inbox_id, inbox.inbox_id, NOW, NOW),
      env.DB.prepare(
        `INSERT INTO message_id_lookup (inbox_id, rfc822_message_id, thread_id, msg_id)
         VALUES (?, '<msg_bounce_target@wzrd.tech>', 'thread_t1', 'msg_t1')`
      ).bind(inbox.inbox_id)
    ]);

    const result = await ingest("dsn-bounce.eml");
    expect(result).toEqual({ kind: "dsn", event: "message.bounced" });

    const original = await env.DB.prepare("SELECT state FROM messages WHERE msg_id = 'msg_t1'")
      .first<{ state: string }>();
    expect(original?.state).toBe("bounced");

    const suppression = await env.DB.prepare(
      "SELECT reason, source_msg_id FROM suppressions WHERE address = 'gone@nowhere.example.com'"
    ).first<{ reason: string; source_msg_id: string }>();
    expect(suppression?.reason).toBe("bounce");
    expect(suppression?.source_msg_id).toBe("msg_t1");

    const stored = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM messages WHERE direction = 'inbound' AND inbox_id = ?"
    )
      .bind(inbox.inbox_id)
      .first<{ n: number }>();
    expect(stored?.n).toBe(0);
  });

  it("turns an ARF report into message.complained + suppression", async () => {
    const inbox = await seedInbox();
    const result = await ingest("arf-complaint.eml");
    expect(result).toEqual({ kind: "dsn", event: "message.complained" });
    const suppression = await env.DB.prepare(
      "SELECT reason FROM suppressions WHERE address = 'complainer@freemail.example.org'"
    ).first<{ reason: string }>();
    expect(suppression?.reason).toBe("complaint");
    const event = await env.DB.prepare(
      "SELECT event_id FROM events WHERE org_id = ? AND type = 'message.complained'"
    )
      .bind(inbox.org_id)
      .first();
    expect(event).not.toBeNull();
  });
});
