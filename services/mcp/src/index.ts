import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { ApiClient } from "./api.js";
import { extractApiKey, sessionKeyGuard } from "./auth.js";
import { registerResources } from "./resources.js";
import { registerTools } from "./tools.js";

interface Env {
  API_BASE_URL: string;
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
  "Access-Control-Expose-Headers": "mcp-session-id",
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

export class WzrdmailMcp extends McpAgent<Env, unknown, Props> {
  server = new McpServer({ name: "wzrdmail", version: "0.0.1" });

  async init(): Promise<void> {
    const apiKey = this.props?.apiKey;
    if (apiKey === undefined) throw new Error("missing auth props");
    const api = new ApiClient({ apiKey, baseUrl: this.env.API_BASE_URL });
    registerTools(this.server, api);
    registerResources(this.server);
  }

  override async fetch(request: Request): Promise<Response> {
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
    if (url.pathname !== "/mcp") {
      return withCors(
        Response.json(
          { name: "not_found", message: "use POST /mcp (Streamable HTTP)" },
          { status: 404 }
        )
      );
    }
    // OAuth 2.1 mode (workers-oauth-provider) lands with the console; until
    // then only x-api-key / Bearer clients are accepted.
    const apiKey = extractApiKey(request);
    if (apiKey === null) {
      return withCors(
        Response.json(
          { name: "unauthorized", message: "provide x-api-key or Authorization: Bearer wm_…" },
          { status: 401 }
        )
      );
    }
    (ctx as { props?: Props }).props = { apiKey };
    const response = await WzrdmailMcp.serve("/mcp").fetch(request, env, ctx);
    return withCors(response);
  }
};
