import type { Email } from "postal-mime";

/**
 * DSN (RFC 3464) / ARF (RFC 5965) detection. Reports from remote MTAs are
 * matched back to the original outbound message and re-emitted as
 * message.bounced / message.complained plus a suppression insert (§6.1.6);
 * they are never stored as ordinary mail.
 */

export interface DsnReport {
  kind: "bounce" | "complaint";
  /** rfc822 message-ids referencing the original outbound message */
  originalMessageIds: string[];
  /** recipient addresses the report is about */
  recipients: string[];
}

const MESSAGE_ID_RE = /<[^<>\s]+@[^<>\s]+>/g;

function decodeAttachment(content: ArrayBuffer | Uint8Array | string): string {
  if (typeof content === "string") return content;
  return new TextDecoder().decode(content);
}

export function detectDsn(email: Email): DsnReport | null {
  const deliveryStatus = email.attachments.find(
    (a) => a.mimeType === "message/delivery-status"
  );
  const feedbackReport = email.attachments.find(
    (a) => a.mimeType === "message/feedback-report"
  );
  if (!deliveryStatus && !feedbackReport) return null;

  const kind: DsnReport["kind"] = feedbackReport ? "complaint" : "bounce";
  const reportText = decodeAttachment((feedbackReport ?? deliveryStatus)!.content);

  if (kind === "bounce") {
    // Only failed deliveries suppress; delayed/relayed notifications do not.
    const action = /^Action:\s*(\S+)/im.exec(reportText)?.[1]?.toLowerCase();
    if (action && action !== "failed") return null;
  }

  const recipients = [
    ...reportText.matchAll(/^(?:Final|Original)-Recipient:\s*(?:rfc822;)?\s*(\S+)/gim)
  ].map((m) => m[1]!.toLowerCase());

  const originalMessageIds = new Set<string>();
  for (const header of ["in-reply-to", "references"]) {
    const value = email.headers.find((h) => h.key === header)?.value;
    for (const id of value?.match(MESSAGE_ID_RE) ?? []) originalMessageIds.add(id);
  }
  // The embedded message/rfc822 part carries the original Message-ID.
  const rfc822 = email.attachments.find(
    (a) => a.mimeType === "message/rfc822" || a.mimeType === "text/rfc822-headers"
  );
  if (rfc822) {
    const original = decodeAttachment(rfc822.content);
    const mid = /^Message-ID:\s*(<[^<>\s]+>)/im.exec(original)?.[1];
    if (mid) originalMessageIds.add(mid);
  }

  return {
    kind,
    originalMessageIds: [...originalMessageIds],
    recipients: [...new Set(recipients)]
  };
}
