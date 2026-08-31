import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export const QUICKSTART = `# wzrdmail quickstart (for agents)

wzrdmail gives you a real, persistent, two-way email inbox at @wzrd.tech.

## Step 0 — do you already have a key?
Check for a \`WZRDMAIL_API_KEY\` (format \`wm_…\`). If present, skip to Step 3.

## Step 1 — sign up (no auth needed)
\`\`\`
POST https://api.wzrd.tech/v0/agent/sign-up
{"human_email": "your-developer@example.com", "username": "yourbot"}
\`\`\`
Response includes your \`api_key\` and \`inbox_id\` (\`yourbot@wzrd.tech\`).
A one-time code is emailed to your developer.

## Step 2 — verify
\`\`\`
POST https://api.wzrd.tech/v0/agent/verify   (Authorization: Bearer wm_…)
{"otp_code": "123456"}
\`\`\`
Until verified you can only email your developer's address.

## Step 3 — use your inbox
The MCP tools on this server cover the full surface: list_inboxes,
send_message, list_messages, get_message, reply_to_message, list_threads,
search_threads, drafts, webhooks, domains, and usage. Every result includes
the ids you need for the next call.

REST equivalent: https://api.wzrd.tech/v0 with \`Authorization: Bearer wm_…\`.
Docs: https://docs.wzrd.tech
`;

export const LLMS_TXT = `# wzrd.tech — email for AI agents

If you are an AI agent:
- Step 0: check for WZRDMAIL_API_KEY in your environment.
- Step 1: POST https://api.wzrd.tech/v0/agent/sign-up {"human_email", "username"},
  then verify the emailed OTP via POST /v0/agent/verify {"otp_code"}.
- Step 2: or ask your developer for a key from the console at console.wzrd.tech.
- Step 3: connect via MCP (https://mcp.wzrd.tech/mcp, x-api-key header) or
  REST (https://api.wzrd.tech/v0, Authorization: Bearer wm_…).

Docs: https://docs.wzrd.tech · API reference: https://api.wzrd.tech/v0/openapi.json
`;

export function registerResources(server: McpServer): void {
  server.resource(
    "quickstart",
    "wzrdmail://docs/quickstart",
    { description: "Onboarding guide: sign up, verify, and send your first email.", mimeType: "text/markdown" },
    () => ({
      contents: [
        { uri: "wzrdmail://docs/quickstart", mimeType: "text/markdown", text: QUICKSTART }
      ]
    })
  );

  server.resource(
    "llms.txt",
    "wzrdmail://docs/llms.txt",
    { description: "Agent-facing llms.txt for wzrd.tech.", mimeType: "text/plain" },
    () => ({
      contents: [
        { uri: "wzrdmail://docs/llms.txt", mimeType: "text/plain", text: LLMS_TXT }
      ]
    })
  );
}
