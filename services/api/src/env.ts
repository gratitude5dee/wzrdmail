export interface Env {
  WZRDMAIL_ENV: "dev" | "staging" | "prod";
  BUILD_SHA: string;
  DB: D1Database;
  MAIL: R2Bucket;
  CACHE: KVNamespace;
  /** Cloudflare send_email binding (absent in local dev/tests). */
  EMAIL?: SendEmail;
  /** thirdweb project client id; when set, email OTPs go through thirdweb auth. */
  THIRDWEB_CLIENT_ID?: string;
  /**
   * Shared, server-to-server credential for the Air × Muse connector.
   * It never reaches the console browser.  Its sole purpose is redemption of
   * short-lived WZRDMail identity and phone-verification handoffs.
   */
  MUSE_CONNECTOR_TOKEN?: string;
}
