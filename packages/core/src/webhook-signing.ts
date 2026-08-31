/**
 * Standard Webhooks / Svix-compatible signing (§8.2).
 * Signature: `v1,` + base64(HMAC-SHA256 over `{id}.{timestamp}.{payload}`)
 * with the base64-decoded portion of a `whsec_` secret as the key.
 * Existing Svix consumer code must verify these unchanged.
 */

const encoder = new TextEncoder();

function secretBytes(secret: string): Uint8Array<ArrayBuffer> {
  const b64 = secret.startsWith("whsec_") ? secret.slice(6) : secret;
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    secretBytes(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
}

function toBase64(buf: ArrayBuffer): string {
  let bin = "";
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin);
}

export interface WebhookHeaders {
  "svix-id": string;
  "svix-timestamp": string;
  "svix-signature": string;
}

export async function signWebhook(
  secret: string,
  id: string,
  timestampSeconds: number,
  payload: string
): Promise<WebhookHeaders> {
  const key = await hmacKey(secret);
  const toSign = `${id}.${timestampSeconds}.${payload}`;
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(toSign));
  return {
    "svix-id": id,
    "svix-timestamp": String(timestampSeconds),
    "svix-signature": `v1,${toBase64(sig)}`
  };
}

const DEFAULT_TOLERANCE_SECONDS = 5 * 60;

export async function verifyWebhook(
  secret: string,
  headers: Record<string, string>,
  payload: string,
  nowSeconds: number = Math.floor(Date.now() / 1000)
): Promise<boolean> {
  const id = headers["svix-id"];
  const timestamp = headers["svix-timestamp"];
  const signatures = headers["svix-signature"];
  if (!id || !timestamp || !signatures) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(nowSeconds - ts) > DEFAULT_TOLERANCE_SECONDS) return false;
  const expected = (await signWebhook(secret, id, ts, payload))["svix-signature"];
  const expectedSig = expected.slice(3);
  for (const candidate of signatures.split(" ")) {
    const [version, sig] = candidate.split(",", 2);
    if (version !== "v1" || !sig) continue;
    if (timingSafeEqual(sig, expectedSig)) return true;
  }
  return false;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function generateWebhookSecret(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return `whsec_${btoa(bin)}`;
}
