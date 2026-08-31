export interface Env {
  WZRDMAIL_ENV: "dev" | "staging" | "prod";
  /** The docs Worker, mounted at /docs. Absent in local dev. */
  DOCS?: Fetcher;
}
