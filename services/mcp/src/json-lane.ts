import { createLegacyMcpHandler } from "agents/mcp";

import { ApiClient } from "./api.js";
import type { Env } from "./env.js";
import { buildServer } from "./server.js";
import type { Principal } from "./principal.js";

/**
 * The stateless JSON lane (muse.md §4.2).
 *
 * Consumer agents that connect from a hosted runtime — Meta Muse among them —
 * speak Streamable HTTP but will not hold a Server-Sent Events stream and work
 * to a per-request ceiling of roughly twenty seconds. The Durable Object lane
 * cannot serve them: `McpAgent.serve()` takes no response-format option and
 * answers every request POST with `text/event-stream` over a WebSocket bridge.
 *
 * This lane runs entirely in the Worker. `createLegacyMcpHandler` builds one
 * `WorkerTransport` per request and forwards SDK options to it, so
 * `enableJsonResponse` makes the POST result a plain JSON body and
 * `sessionIdGenerator: undefined` means no session id is minted, nothing is
 * stored between requests, and non-initialize calls need no `mcp-session-id`.
 */

/** How long an upstream api.wzrd.tech call may take before it becomes a tool error. */
const UPSTREAM_TIMEOUT_MS = 15_000;

/**
 * The SDK transport rejects a POST whose `Accept` omits either
 * `application/json` or `text/event-stream` with a 406, and it does so before
 * the JSON branch is reached — so a JSON-only client would never get past the
 * door. Rewriting the header is safe: the response format is decided by
 * `enableJsonResponse`, not by what the client asked for.
 */
export const normalizeAccept = (request: Request): Request => {
  const accept = request.headers.get("accept") ?? "";
  if (accept.includes("application/json") && accept.includes("text/event-stream")) {
    return request;
  }
  const headers = new Headers(request.headers);
  headers.set("accept", "application/json, text/event-stream");
  return new Request(request, { headers });
};

export async function handleJsonLane(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  principal: Principal
): Promise<Response> {
  const api = new ApiClient({
    apiKey: principal.apiKey,
    baseUrl: env.API_BASE_URL,
    timeoutMs: UPSTREAM_TIMEOUT_MS
  });
  const server = buildServer(api, {
    permissions: principal.permissions,
    inboxId: principal.inboxId
  });
  const handler = createLegacyMcpHandler(server, {
    route: "/mcp",
    enableJsonResponse: true,
    sessionIdGenerator: undefined,
    corsOptions: { origin: "*" }
  });
  return handler(normalizeAccept(request), env, ctx);
}
