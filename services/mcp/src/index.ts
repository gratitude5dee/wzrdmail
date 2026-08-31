import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";

import { ApiClient } from "./api.js";
import { registerResources } from "./resources.js";
import { registerTools } from "./tools.js";

interface Env {
  API_BASE_URL: string;
  MCP_OBJECT: DurableObjectNamespace;
}

interface Props extends Record<string, unknown> {
  apiKey: string;
}

export class WzrdmailMcp extends McpAgent<Env, unknown, Props> {
  server = new McpServer({ name: "wzrdmail", version: "0.0.1" });

  async init(): Promise<void> {
    const props = this.props;
    if (props === undefined) throw new Error("missing auth props");
    const api = new ApiClient({
      apiKey: props.apiKey,
      baseUrl: this.env.API_BASE_URL
    });
    registerTools(this.server, api);
    registerResources(this.server);
  }
}

const extractApiKey = (request: Request): string | null => {
  const headerKey = request.headers.get("x-api-key");
  if (headerKey !== null && headerKey !== "") return headerKey;
  const authorization = request.headers.get("authorization");
  if (authorization !== null && authorization.toLowerCase().startsWith("bearer ")) {
    return authorization.slice("bearer ".length).trim();
  }
  return null;
};

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return Response.json({ ok: true });
    }
    if (url.pathname !== "/mcp") {
      return Response.json(
        { name: "not_found", message: "use POST /mcp (Streamable HTTP)" },
        { status: 404 }
      );
    }
    // OAuth 2.1 mode (workers-oauth-provider) lands with the console; until
    // then only x-api-key / Bearer clients are accepted.
    const apiKey = extractApiKey(request);
    if (apiKey === null) {
      return Response.json(
        { name: "unauthorized", message: "provide x-api-key or Authorization: Bearer wm_…" },
        { status: 401 }
      );
    }
    (ctx as { props?: Props }).props = { apiKey };
    return WzrdmailMcp.serve("/mcp").fetch(request, env, ctx);
  }
};
