import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  generateWebhookSecret,
  signWebhook,
  verifyWebhook
} from "../src/webhook-signing.js";

const SECRET = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
const PAYLOAD = '{"test": 2432232314}';
const ID = "msg_p5jXN8AQM9LWM0D4loKWxJek";
const TIMESTAMP = 1614265330;

describe("signWebhook", () => {
  it("matches an independent HMAC-SHA256 computation (Standard Webhooks scheme)", async () => {
    const headers = await signWebhook(SECRET, ID, TIMESTAMP, PAYLOAD);
    const key = Buffer.from(SECRET.slice(6), "base64");
    const expected = createHmac("sha256", key)
      .update(`${ID}.${TIMESTAMP}.${PAYLOAD}`)
      .digest("base64");
    expect(headers["svix-signature"]).toBe(`v1,${expected}`);
    expect(headers["svix-id"]).toBe(ID);
    expect(headers["svix-timestamp"]).toBe(String(TIMESTAMP));
  });
});

describe("verifyWebhook", () => {
  it("round-trips", async () => {
    const secret = generateWebhookSecret();
    const now = Math.floor(Date.now() / 1000);
    const headers = await signWebhook(secret, "evt_1", now, PAYLOAD);
    expect(await verifyWebhook(secret, { ...headers }, PAYLOAD)).toBe(true);
  });

  it("rejects tampered payloads", async () => {
    const secret = generateWebhookSecret();
    const now = Math.floor(Date.now() / 1000);
    const headers = await signWebhook(secret, "evt_1", now, PAYLOAD);
    expect(await verifyWebhook(secret, { ...headers }, PAYLOAD + " ")).toBe(false);
  });

  it("rejects stale timestamps", async () => {
    const secret = generateWebhookSecret();
    const old = Math.floor(Date.now() / 1000) - 3600;
    const headers = await signWebhook(secret, "evt_1", old, PAYLOAD);
    expect(await verifyWebhook(secret, { ...headers }, PAYLOAD)).toBe(false);
  });

  it("accepts multiple space-delimited signatures if one matches", async () => {
    const secret = generateWebhookSecret();
    const now = Math.floor(Date.now() / 1000);
    const headers = await signWebhook(secret, "evt_1", now, PAYLOAD);
    const combined = `v1,bm90LXRoZS1zaWc= ${headers["svix-signature"]}`;
    expect(
      await verifyWebhook(
        secret,
        { ...headers, "svix-signature": combined },
        PAYLOAD
      )
    ).toBe(true);
  });
});
