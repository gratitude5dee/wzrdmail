import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { ApiClient } from "./api.js";
import { registerResources } from "./resources.js";
import { registerTools } from "./tools.js";

export function buildServer(api: ApiClient): McpServer {
  const server = new McpServer({ name: "wzrdmail", version: "0.0.1" });
  registerTools(server, api);
  registerResources(server);
  return server;
}
