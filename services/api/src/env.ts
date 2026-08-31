export interface Env {
  WZRDMAIL_ENV: "dev" | "staging" | "prod";
  BUILD_SHA: string;
  DB: D1Database;
  MAIL: R2Bucket;
  CACHE: KVNamespace;
}
