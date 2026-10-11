import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { ApiClient } from "./api.js";
import { registerExtensions, WZRDMAIL_SERVER_INFO } from "./extensions.js";
import { registerResources } from "./resources.js";
import { registerTools } from "./tools.js";

export function buildServer(api: ApiClient): McpServer {
  const server = new McpServer(WZRDMAIL_SERVER_INFO);
  registerTools(server, api);
  registerResources(server);
  registerExtensions(server, api);
  return server;
}
