import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { ApiClient } from "./api.js";
import { registerResources } from "./resources.js";
import { registerTools, type RegisterToolsOptions } from "./tools.js";

/**
 * Builds one MCP server. A fresh instance is required per request on the
 * stateless JSON lane: the SDK refuses to connect a server that is already
 * bound to a transport (agents createLegacyMcpHandler).
 */
export function buildServer(api: ApiClient, options: RegisterToolsOptions = {}): McpServer {
  const server = new McpServer(
    { name: "wzrdmail", version: "0.0.1" },
    {
      instructions:
        "wzrdmail gives an agent its own email inbox. Call whoami first to learn which address you own and what you may do. An inbox_id IS an email address. There is no push notification for new mail: poll check_new_mail with the next_since value it returns. Prefer extracted_text over text or html when reading a reply."
    }
  );
  registerTools(server, api, options);
  registerResources(server);
  return server;
}
