/** Reserved local-parts on wzrd.tech (§5) — rejected at inbox creation. */
export const RESERVED_LOCAL_PARTS: ReadonlySet<string> = new Set([
  "admin",
  "abuse",
  "billing",
  "dmarc-reports",
  "founders",
  "hello",
  "help",
  "hostmaster",
  "legal",
  "mailer-daemon",
  "noreply",
  "postmaster",
  "privacy",
  "root",
  "sales",
  "security",
  "support",
  "team",
  "webmaster"
]);

/** Baseline impersonation denylist; the live list is KV-editable (§5). */
export const USERNAME_DENYLIST: ReadonlySet<string> = new Set([
  "stripe",
  "cloudflare",
  "agentmail",
  "paypal",
  "apple",
  "google",
  "microsoft",
  "wzrdmail"
]);

const USERNAME_RE = /^[a-z0-9](?:[a-z0-9._-]{1,62}[a-z0-9])?$/;
const SEPARATOR_RUN_RE = /[._-]{2,}/;

export type UsernameVerdict =
  | { ok: true; username: string }
  | { ok: false; reason: "invalid" | "reserved" | "denylisted" };

export function validateUsername(raw: string): UsernameVerdict {
  const username = raw.toLowerCase();
  if (
    username.length < 3 ||
    !USERNAME_RE.test(username) ||
    SEPARATOR_RUN_RE.test(username)
  ) {
    return { ok: false, reason: "invalid" };
  }
  if (RESERVED_LOCAL_PARTS.has(username)) return { ok: false, reason: "reserved" };
  if (USERNAME_DENYLIST.has(username)) return { ok: false, reason: "denylisted" };
  return { ok: true, username };
}
