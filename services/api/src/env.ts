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
   * Shared secret the MCP Worker presents on /v0/connect/* (muse.md §7.1).
   * Until it is provisioned those routes answer 404, so the API can ship
   * before the connector exists.
   */
  CONNECT_SECRET?: string;
}
