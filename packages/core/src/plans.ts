/**
 * Every plan number lives here and only here (§13 of goal.md).
 * Platform limits observed from Cloudflare docs on 2026-08-31
 * (https://developers.cloudflare.com/email-service/platform/limits/):
 * outbound message cap 5 MiB (25 MiB to verified destinations),
 * <=50 recipients per message, 200 routing rules / 30 routed domains per zone.
 */
export const PLATFORM_LIMITS = {
  maxRecipientsPerMessage: 50,
  maxOutboundBytes: 5 * 1024 * 1024,
  maxInboundStoredBytes: 25 * 1024 * 1024
} as const;

export type PlanName = "free" | "developer" | "startup" | "enterprise";

export interface PlanLimits {
  priceUsdMonthly: number | null;
  inboxes: number;
  emailsPerMonth: number;
  storageBytes: number;
  customDomains: number;
  seats: number;
  sendsPerDay: number;
}

const GB = 1024 * 1024 * 1024;

export const PLANS: Record<PlanName, PlanLimits> = {
  free: {
    priceUsdMonthly: 0,
    inboxes: 3,
    emailsPerMonth: 3_000,
    storageBytes: 3 * GB,
    customDomains: 0,
    seats: 1,
    sendsPerDay: 100
  },
  developer: {
    priceUsdMonthly: 20,
    inboxes: 10,
    emailsPerMonth: 10_000,
    storageBytes: 10 * GB,
    customDomains: 10,
    seats: 2,
    sendsPerDay: 1_000
  },
  startup: {
    priceUsdMonthly: 200,
    inboxes: 150,
    emailsPerMonth: 150_000,
    storageBytes: 100 * GB,
    customDomains: 150,
    seats: 10,
    sendsPerDay: 10_000
  },
  enterprise: {
    priceUsdMonthly: null,
    inboxes: Number.MAX_SAFE_INTEGER,
    emailsPerMonth: Number.MAX_SAFE_INTEGER,
    storageBytes: Number.MAX_SAFE_INTEGER,
    customDomains: Number.MAX_SAFE_INTEGER,
    seats: Number.MAX_SAFE_INTEGER,
    sendsPerDay: Number.MAX_SAFE_INTEGER
  }
};

export type UsageMetric =
  | "emails_sent"
  | "emails_received"
  | "storage_bytes"
  | "inboxes"
  | "domains"
  | "seats";
