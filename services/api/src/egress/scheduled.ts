import type { MailProvider } from "@wzrdmail/core";
import type { Env } from "../env.js";
import { bumpUsage, emitEvent } from "../lib/events.js";

/** Trashed rows older than this are purged permanently. */
const TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** How many due messages one cron tick will dispatch. */
const DISPATCH_BATCH = 25;

interface ScheduledRow {
  msg_id: string;
  org_id: string;
  pod_id: string;
  inbox_id: string;
  thread_id: string;
  from_addr: string;
  to_addrs: string;
  cc_addrs: string;
  bcc_addrs: string;
  subject: string;
  text: string | null;
  html: string | null;
  rfc822_message_id: string | null;
  raw_key: string | null;
  created_at: string;
}

function addrs(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    return [];
  }
}

/**
 * Deliver scheduled messages whose send_at has passed. Each row is claimed
 * with a guarded state transition (scheduled → queued) so overlapping cron
 * ticks never double-send.
 */
export async function deliverDueScheduled(
  env: Env,
  provider: MailProvider,
  now: Date = new Date()
): Promise<number> {
  const due = (
    await env.DB.prepare(
      `SELECT msg_id, org_id, pod_id, inbox_id, thread_id, from_addr, to_addrs, cc_addrs,
              bcc_addrs, subject, text, html, rfc822_message_id, raw_key, created_at
       FROM messages
       WHERE state = 'scheduled' AND deleted_at IS NULL AND send_at <= ?
       ORDER BY send_at LIMIT ?`
    )
      .bind(now.toISOString(), DISPATCH_BATCH)
      .all<ScheduledRow>()
  ).results;

  let dispatched = 0;
  for (const row of due) {
    const claimed = await env.DB.prepare(
      "UPDATE messages SET state = 'queued', updated_at = ? WHERE msg_id = ? AND state = 'scheduled'"
    )
      .bind(new Date().toISOString(), row.msg_id)
      .run();
    if (claimed.meta.changes === 0) continue;
    await dispatchOne(env, provider, row);
    dispatched++;
  }
  return dispatched;
}

async function dispatchOne(env: Env, provider: MailProvider, row: ScheduledRow): Promise<void> {
  const to = addrs(row.to_addrs);
  const cc = addrs(row.cc_addrs);
  const bcc = addrs(row.bcc_addrs);
  const recipients = [...new Set([...to, ...cc, ...bcc])];

  let state: "sent" | "rejected" = "rejected";
  let providerError: string | null = null;
  let rejectedRecipients: { address: string; error: string }[] = [];

  // Re-check suppressions at dispatch time: a bounce may have landed between
  // scheduling and delivery.
  const suppressed =
    recipients.length === 0
      ? null
      : await env.DB.prepare(
          `SELECT address FROM suppressions
           WHERE (org_id = ? OR org_id IS NULL)
             AND address IN (${recipients.map(() => "?").join(",")})`
        )
          .bind(row.org_id, ...recipients)
          .first<{ address: string }>();

  if (suppressed) {
    providerError = `recipient ${suppressed.address} is suppressed (previous bounce or complaint)`;
  } else {
    const raw = row.raw_key ? await env.MAIL.get(row.raw_key) : null;
    if (!raw) {
      providerError = "raw MIME for scheduled message is missing";
    } else {
      try {
        const outcome = await provider.send({
          from: row.from_addr,
          to: recipients,
          raw: await raw.text()
        });
        rejectedRecipients = outcome.rejected;
        state = outcome.accepted.length > 0 ? "sent" : "rejected";
        if (state === "rejected" && outcome.rejected.length > 0) {
          providerError = outcome.rejected.map((r) => `${r.address}: ${r.error}`).join("; ");
        }
      } catch (err) {
        providerError = String(err);
      }
    }
  }

  const now = new Date().toISOString();
  await env.DB.prepare("UPDATE messages SET state = ?, updated_at = ? WHERE msg_id = ?")
    .bind(state, now, row.msg_id)
    .run();
  await bumpUsage(env.DB, row.org_id, "emails_sent", 1);
  await emitEvent(env.DB, {
    type: state === "sent" ? "message.sent" : "message.rejected",
    org_id: row.org_id,
    pod_id: row.pod_id,
    inbox_id: row.inbox_id,
    data: {
      message: {
        message_id: row.msg_id,
        inbox_id: row.inbox_id,
        thread_id: row.thread_id,
        organization_id: row.org_id,
        pod_id: row.pod_id,
        direction: "outbound",
        state,
        from: row.from_addr,
        to,
        cc,
        bcc,
        subject: row.subject,
        text: row.text,
        html: row.html,
        rfc822_message_id: row.rfc822_message_id,
        created_at: row.created_at,
        updated_at: now
      },
      ...(providerError ? { provider_error: providerError } : {}),
      ...(rejectedRecipients.length > 0 ? { rejected_recipients: rejectedRecipients } : {})
    }
  });
  if (state === "rejected") {
    console.error(
      JSON.stringify({ msg: "scheduled_send_rejected", msg_id: row.msg_id, error: providerError })
    );
  }
}

/** Permanently remove messages and threads trashed more than 30 days ago. */
export async function purgeExpiredTrash(env: Env, now: Date = new Date()): Promise<void> {
  const cutoff = new Date(now.getTime() - TRASH_RETENTION_MS).toISOString();
  await env.DB.batch([
    env.DB.prepare(
      "DELETE FROM attachments WHERE msg_id IN (SELECT msg_id FROM messages WHERE deleted_at < ?)"
    ).bind(cutoff),
    env.DB.prepare(
      "DELETE FROM message_id_lookup WHERE msg_id IN (SELECT msg_id FROM messages WHERE deleted_at < ?)"
    ).bind(cutoff),
    env.DB.prepare("DELETE FROM messages WHERE deleted_at < ?").bind(cutoff),
    env.DB.prepare("DELETE FROM threads WHERE deleted_at < ?").bind(cutoff)
  ]);
}
