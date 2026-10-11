import type { Env } from "../env.js";

/**
 * Open/click tracking (resend-parity spec §3 P3, §4).
 *
 * Tracking links are stateless: no link table. `tok`/`sig` are truncated
 * HMAC-SHA256 digests over the message id (opens) or message id + target URL
 * (clicks), keyed by TRACKING_SECRET — a receiver can open the pixel or follow
 * a click redirect but cannot forge hits against other messages.
 */

/** Tokens are 128 bits of HMAC-SHA256 — unguessable, short enough for URLs. */
const TOKEN_HEX_LEN = 32;

/** Consecutive opens from the same msg+UA inside this window count once. */
export const OPEN_DEDUPE_TTL_S = 15 * 60;

const encoder = new TextEncoder();

/** Public base the tracking URLs are built on (`/v0/o`, `/v0/c` routes). */
export function trackingBase(env: Env): string {
  return (env.TRACKING_BASE_URL ?? "https://api.wzrd.tech/v0").replace(/\/+$/, "");
}

export function trackingSecret(env: Env): string {
  // Dev-only default so local runs and tests need no secret provisioning;
  // production sets TRACKING_SECRET (wrangler secret) — without it anyone who
  // reads this source could forge tracking hits.
  return env.TRACKING_SECRET ?? "wzrdmail-dev-tracking-secret";
}

async function hmacHex(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(data));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function openToken(msgId: string, secret: string): Promise<string> {
  const hex = await hmacHex(secret, `o:${msgId}`);
  return hex.slice(0, TOKEN_HEX_LEN);
}

export async function clickSignature(
  msgId: string,
  url: string,
  secret: string
): Promise<string> {
  const hex = await hmacHex(secret, `c:${msgId}:${url}`);
  return hex.slice(0, TOKEN_HEX_LEN);
}

/** Constant-time compare; mismatched lengths fail without leaking position. */
export function tokenEquals(expected: string, given: string): boolean {
  if (expected.length !== given.length || expected.length === 0) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ given.charCodeAt(i);
  }
  return diff === 0;
}

const PIXEL_TAG = (src: string) =>
  `<img src="${src}" width="1" height="1" alt="" style="display:none;border:0" />`;

const HREF_RE = /\bhref\s*=\s*("([^"]*)"|'([^']*)')/gi;

export interface InjectTrackingOptions {
  html: string;
  msgId: string;
  env: Env;
  open: boolean;
  click: boolean;
}

/**
 * Returns the HTML to send: tracked links rewritten to `/v0/c/...` redirects
 * and a 1px `/v0/o/...` pixel appended before `</body>` (or at the end).
 * Only http(s) hrefs are rewritten — mailto:, cid:, tel:, anchors untouched.
 */
export async function injectTracking({
  html,
  msgId,
  env,
  open,
  click
}: InjectTrackingOptions): Promise<string> {
  const base = trackingBase(env);
  const secret = trackingSecret(env);
  let out = html;

  if (click) {
    const matches = [...out.matchAll(HREF_RE)];
    // Distinct hrefs each need their own signature; compute once per URL.
    const replacements = new Map<string, string>();
    for (const m of matches) {
      const quote = m[1]!;
      const url = m[2] ?? m[3] ?? "";
      if (!/^https?:\/\//i.test(url) || replacements.has(url)) continue;
      const sig = await clickSignature(msgId, url, secret);
      const tracked = `${base}/c/${encodeURIComponent(msgId)}/${sig}?u=${encodeURIComponent(url)}`;
      replacements.set(url, `${quote[0]}${tracked}${quote[0]}`);
    }
    out = out.replace(HREF_RE, (whole, _quoted, dq, sq) => {
      const url = dq ?? sq ?? "";
      return replacements.has(url)
        ? `href=${replacements.get(url)!}`
        : whole;
    });
  }

  if (open) {
    const tok = await openToken(msgId, secret);
    const pixel = PIXEL_TAG(`${base}/o/${encodeURIComponent(msgId)}/${tok}`);
    out = /<\/body\s*>/i.test(out)
      ? out.replace(/<\/body\s*>/i, `${pixel}</body>`)
      : out + pixel;
  }

  return out;
}

/**
 * KV dedupe key for opens: one counted open per msg+user-agent per window.
 * KV is best-effort here — a lost edge key can double-count, never drop.
 */
export async function openDedupeKey(msgId: string, userAgent: string): Promise<string> {
  const hash = await hmacHex("wzrdmail-ua", `${msgId}:${userAgent}`);
  return `track:open:${msgId}:${hash.slice(0, TOKEN_HEX_LEN)}`;
}

/** Standard 1×1 transparent GIF. */
export const PIXEL_GIF = Uint8Array.from(
  atob("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"),
  (ch) => ch.charCodeAt(0)
);
