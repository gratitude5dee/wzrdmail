import { ApiError } from "@wzrdmail/core";
import type { Env } from "../env.js";

/**
 * The slice of a Hono context these helpers need. Kept structural (like
 * `throttleSignup` in routes/console.ts) so callers can pass `c` directly.
 */
export interface ThrottleContext {
  env: Env;
  req: { header: (name: string) => string | undefined };
  header: (name: string, value: string) => void;
}

/**
 * Best-effort KV counter (muse.md §7.5). KV is eventually consistent and its
 * writes are not atomic, so this bounds abuse rather than enforcing an exact
 * quota; the counter's TTL resets on each write, which makes the full window
 * the conservative upper bound on when a retry is allowed.
 */
export async function throttle(
  c: ThrottleContext,
  key: string,
  limit: number,
  windowSeconds: number,
  message: string
): Promise<void> {
  const count = Number((await c.env.CACHE.get(key)) ?? "0");
  if (count >= limit) {
    c.header("Retry-After", String(windowSeconds));
    throw new ApiError("rate_limited", message);
  }
  await c.env.CACHE.put(key, String(count + 1), { expirationTtl: windowSeconds });
}

/** The address Cloudflare observed for this request; a client cannot spoof it. */
export function directIp(c: ThrottleContext): string {
  return c.req.header("cf-connecting-ip") ?? "unknown";
}

/**
 * The browser's address as reported by the MCP Worker, which proxies
 * `/v0/connect/*` (the API never sees the browser). Only ever trusted behind
 * the connect secret, where the caller has already proved it is our Worker;
 * everything else uses `directIp`.
 */
export function forwardedIp(c: ThrottleContext): string {
  const forwarded =
    c.req.header("x-wzrdmail-client-ip") ?? c.req.header("x-forwarded-for")?.split(",")[0];
  const trimmed = forwarded?.trim();
  return trimmed ? trimmed : directIp(c);
}
