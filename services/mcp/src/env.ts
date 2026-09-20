/**
 * Worker bindings for services/mcp (muse.md §9.2).
 *
 * `OAUTH_KV`, `CONNECT_SECRET` and `MCP_PUBLIC_ORIGIN` arrive with the OAuth
 * lane; they are optional in the type so a deployment that has not been
 * provisioned yet still typechecks and simply keeps the OAuth routes dark.
 */
export interface Env {
  API_BASE_URL: string;
  MCP_OBJECT: DurableObjectNamespace;
  /** Public origin of this Worker, e.g. https://mcp.mail.wzrd.tech. */
  MCP_PUBLIC_ORIGIN?: string;
  /** Shared secret for the server-to-server /v0/connect/* calls. */
  CONNECT_SECRET?: string;
  /** Storage for the OAuth authorization server. */
  OAUTH_KV?: KVNamespace;
}
