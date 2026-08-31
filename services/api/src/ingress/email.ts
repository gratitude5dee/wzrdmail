import { PLATFORM_LIMITS } from "@wzrdmail/core";
import type { Env } from "../env.js";
import { processDueDeliveries } from "../lib/webhook-delivery.js";
import { ingestEmail } from "./pipeline.js";

/**
 * Inbound pipeline entry (§6.1). Raw MIME goes to R2 first (source of
 * truth), then the parsed message is persisted to D1. SMTP is acked only
 * after both writes commit; a throw here makes the sender retry.
 */
export async function handleEmail(
  message: ForwardableEmailMessage,
  env: Env,
  ctx: ExecutionContext
): Promise<void> {
  if (message.rawSize > PLATFORM_LIMITS.maxInboundStoredBytes) {
    message.setReject("552 message exceeds size limit");
    return;
  }

  const raw = await new Response(message.raw).arrayBuffer();
  const rawKey = `raw/${message.to.toLowerCase()}/${crypto.randomUUID()}.eml`;
  await env.MAIL.put(rawKey, raw, {
    customMetadata: { from: message.from, to: message.to }
  });

  const result = await ingestEmail(env, {
    raw,
    rawKey,
    envelopeFrom: message.from,
    envelopeTo: message.to
  });

  if (result.kind === "blocked") {
    // Raw cleanup is best-effort: the policy rejection already happened, so a
    // transient R2 failure must not convert it into an SMTP retry.
    try {
      await env.MAIL.delete(rawKey);
    } catch (err) {
      console.log(
        JSON.stringify({
          msg: "blocked_raw_cleanup_failed",
          r2_key: rawKey,
          error: err instanceof Error ? err.message : String(err)
        })
      );
    }
    message.setReject("550 sender address rejected by policy");
  }

  ctx.waitUntil(processDueDeliveries(env));

  console.log(
    JSON.stringify({
      msg: "email_received",
      from: message.from,
      to: message.to,
      size: message.rawSize,
      r2_key: rawKey,
      result
    })
  );
}
