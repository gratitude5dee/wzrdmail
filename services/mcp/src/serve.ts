import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { ApiClient } from "./api.js";
import { sessionKeyGuard } from "./auth.js";
import type { Env } from "./env.js";
import { handleJsonLane } from "./json-lane.js";
import type { Principal } from "./principal.js";
import { registerResources } from "./resources.js";
import { registerTools } from "./tools.js";

interface Props extends Record<string, unknown> {
  apiKey: string;
}

export const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, x-api-key, mcp-session-id, mcp-protocol-version, last-event-id, mcp-response-mode",
  "Access-Control-Expose-Headers": "mcp-session-id, WWW-Authenticate",
  "Access-Control-Max-Age": "86400"
};

export const withCors = (response: Response): Response => {
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

/**
 * Which transport lane serves this request (muse.md §4.3).
 *
 * The streaming lane is the Durable Object one that shipped first; the JSON
 * lane is stateless and answers in a plain body. The rules are ordered so no
 * client that works today can be moved off the lane it already uses:
 *
 *  1. Anything that is not a POST keeps the streaming lane's GET/DELETE
 *     semantics unchanged.
 *  2. An OAuth connection always gets JSON. Hosted consumer agents arrive that
 *     way and will not hold a stream, whatever they put in Accept.
 *  3. A POST whose Accept omits text/event-stream gets JSON — the streaming
 *     lane answers exactly that shape with a 406 today, so nothing can be
 *     relying on it.
 *  4. An explicit opt-in header gets JSON, for key clients that can reach the
 *     server but not parse a stream.
 *  5. Everything else keeps streaming: the editors and CLIs already connected.
 */
export const selectLane = (request: Request, principal: Principal): "json" | "streaming" => {
  if (request.method !== "POST") return "streaming";
  if (principal.kind === "oauth") return "json";
  const accept = request.headers.get("accept") ?? "";
  if (!accept.includes("text/event-stream")) return "json";
  if (request.headers.get("mcp-response-mode")?.trim().toLowerCase() === "json") return "json";
  return "streaming";
};

/** Serves one MCP request on whichever lane suits the caller. */
export async function serveMcp(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  principal: Principal
): Promise<Response> {
  if (selectLane(request, principal) === "json") {
    return withCors(await handleJsonLane(request, env, ctx, principal));
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
  (ctx as { props?: Props }).props = { apiKey: principal.apiKey };
  return withCors(await WzrdmailMcp.serve("/mcp").fetch(request, env, ctx));
}
