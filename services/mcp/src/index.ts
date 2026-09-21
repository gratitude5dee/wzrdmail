import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { ApiClient } from "./api.js";
import {
  isMuseDiscoveryPath,
  isWzrdmailRequest,
  proxyMuse,
  sharedMcpMetadata
} from "./air-muse.js";
import { extractApiKey, sessionKeyGuard } from "./auth.js";
import { registerResources } from "./resources.js";
import { registerTools } from "./tools.js";

interface Env {
  API_BASE_URL: string;
  /** Optional Air × Muse upstream. Kept public: it is an origin, not a secret. */
  MUSE_ORIGIN?: string;
  MCP_OBJECT: DurableObjectNamespace;
}

interface Props extends Record<string, unknown> {
  apiKey: string;
}

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, x-api-key, mcp-session-id, mcp-protocol-version, last-event-id",
  "Access-Control-Expose-Headers": "mcp-session-id, www-authenticate",
  "Access-Control-Max-Age": "86400"
};

const withCors = (response: Response): Response => {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    if (!headers.has(key)) headers.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
};

/** Internal worker→DO route that reports whether a request's key matches the session's bound key. */
const VERIFY_SESSION_KEY_PATH = "/__verify-session-key";

export class WzrdmailMcp extends McpAgent<Env, unknown, Props> {
  server = new McpServer({ name: "wzrdmail", version: "0.0.1" });

  async init(): Promise<void> {
    const apiKey = this.props?.apiKey;
    // Unbound sessions register nothing; sessionKeyGuard rejects all their traffic.
    if (apiKey === undefined) return;
    const api = new ApiClient({ apiKey, baseUrl: this.env.API_BASE_URL });
    registerTools(this.server, api);
    registerResources(this.server);
  }

  override async fetch(request: Request): Promise<Response> {
    // On a cold start `this.props` is empty until onStart() reloads it from
    // storage; guarding before that would 401 every evicted-then-reused session.
    await this.__unsafe_ensureInitialized();
    const url = new URL(request.url);
    if (url.pathname === VERIFY_SESSION_KEY_PATH) {
      return (
        sessionKeyGuard(request, this.props?.apiKey) ?? Response.json({ ok: true })
      );
    }
    const rejection = sessionKeyGuard(request, this.props?.apiKey);
    if (rejection !== null) return rejection;
    return super.fetch(request);
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    if (url.pathname === "/health") {
      return withCors(Response.json({ ok: true }));
    }
    // Publish the Air connector discovery documents on the same host without
    // taking over any WZRDMail routes. Its protected-resource metadata keeps
    // `muse.wzrd.tech` as the OAuth resource, so token issuance and revocation
    // remain entirely within Air.
    if (request.method === "GET" && isMuseDiscoveryPath(url.pathname)) {
      const response = await proxyMuse(request, env.MUSE_ORIGIN);
      if (url.pathname !== "/.well-known/mcp.json") return withCors(response);
      const metadata = await response.clone().json().catch(() => null);
      if (metadata === null) return withCors(response);
      return withCors(
        Response.json(sharedMcpMetadata(metadata, request), {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers
        })
      );
    }
    if (url.pathname !== "/mcp") {
      return withCors(
        Response.json(
          { name: "not_found", message: "use POST /mcp (Streamable HTTP)" },
          { status: 404 }
        )
      );
    }
    // A WZRDMail key selects the existing mail toolset. Without one, relay
    // directly to Air × Muse: its 401 resource-metadata challenge initiates
    // OAuth 2.1 + PKCE for connector clients, and opaque OAuth tokens never
    // reach this Worker's Durable Object or api.wzrd.tech.
    if (!isWzrdmailRequest(request)) {
      return withCors(await proxyMuse(request, env.MUSE_ORIGIN));
    }
    const apiKey = extractApiKey(request);
    if (apiKey === null) {
      return withCors(
        Response.json(
          { name: "unauthorized", message: "provide x-api-key or Authorization: Bearer wm_…" },
          { status: 401 }
        )
      );
    }
    // The streamable-HTTP bridge turns any non-WebSocket DO response into a
    // generic 500, so session-key mismatches must be rejected here, before the
    // bridge opens — by asking the named session's DO to compare keys directly.
    const sessionId = request.headers.get("mcp-session-id");
    if (sessionId !== null) {
      const stub = env.MCP_OBJECT.get(
        env.MCP_OBJECT.idFromName(`streamable-http:${sessionId}`)
      );
      const verification = await stub.fetch(
        new Request(`https://mcp.internal${VERIFY_SESSION_KEY_PATH}`, {
          headers: request.headers
        })
      );
      if (verification.status !== 200) return withCors(verification);
    }
    (ctx as { props?: Props }).props = { apiKey };
    const response = await WzrdmailMcp.serve("/mcp").fetch(request, env, ctx);
    return withCors(response);
  }
};
