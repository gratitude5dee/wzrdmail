/**
 * Inbound allow/block list evaluation (§6.1). Entries are exact addresses or
 * `@domain` patterns, scoped org-wide (inbox_id NULL) or to one inbox.
 * Inbox-level entries take precedence over org-level ones; when any allow
 * entry applies to the inbox, the list runs in allowlist mode and unmatched
 * senders are blocked.
 */

interface ListEntryScope {
  inbox_id: string | null;
  kind: string;
  pattern: string;
}

export type SenderVerdict =
  | { verdict: "deliver" }
  | { verdict: "blocked"; reason: "block_entry" | "not_allowlisted"; pattern: string | null };

function matches(pattern: string, address: string): boolean {
  return pattern.startsWith("@") ? address.endsWith(pattern) : address === pattern;
}

export async function evaluateSenderLists(
  db: D1Database,
  orgId: string,
  inboxId: string,
  fromAddress: string
): Promise<SenderVerdict> {
  const from = fromAddress.toLowerCase();
  const entries = (
    await db
      .prepare(
        "SELECT inbox_id, kind, pattern FROM list_entries WHERE org_id = ? AND (inbox_id IS NULL OR inbox_id = ?)"
      )
      .bind(orgId, inboxId)
      .all<ListEntryScope>()
  ).results;
  if (entries.length === 0) return { verdict: "deliver" };

  for (const scope of ["inbox", "org"] as const) {
    const scoped = entries.filter((e) =>
      scope === "inbox" ? e.inbox_id !== null : e.inbox_id === null
    );
    const allowHit = scoped.find((e) => e.kind === "allow" && matches(e.pattern, from));
    if (allowHit) return { verdict: "deliver" };
    const blockHit = scoped.find((e) => e.kind === "block" && matches(e.pattern, from));
    if (blockHit) {
      return { verdict: "blocked", reason: "block_entry", pattern: blockHit.pattern };
    }
  }
  if (entries.some((e) => e.kind === "allow")) {
    return { verdict: "blocked", reason: "not_allowlisted", pattern: null };
  }
  return { verdict: "deliver" };
}
