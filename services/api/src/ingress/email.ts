import type { Env } from "../env.js";

/**
 * Ingress Email Worker handler (§6.1). M0 scope: log-only — record the
 * envelope and store raw MIME to R2 so the M0 Verify block ("a manual email
 * to probe@wzrd.tech appears in ingress logs") passes. Parsing, threading,
 * D1 insert, and event emission land in M1.
 */
export async function handleEmail(
  message: ForwardableEmailMessage,
  env: Env
): Promise<void> {
  const key = `raw/unrouted/${crypto.randomUUID()}.eml`;
  await env.MAIL.put(key, message.raw, {
    customMetadata: { from: message.from, to: message.to }
  });
  console.log(
    JSON.stringify({
      msg: "email_received",
      from: message.from,
      to: message.to,
      size: message.rawSize,
      r2_key: key
    })
  );
}
