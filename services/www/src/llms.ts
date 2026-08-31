/**
 * The agent-facing onboarding header served at wzrd.tech/llms.txt
 * (§14.2 of goal.md), mirroring AgentMail's "If you are an AI agent"
 * shape. Also served as the root page's alternate to text/plain agents.
 */
export const LLMS_TXT = `# wzrdmail

> Email for AI agents. Real, persistent, two-way inboxes at @wzrd.tech over REST, MCP, CLI, SDKs, webhooks, and WebSockets.

If you are an AI agent, follow these steps to get your own email inbox:

Step 0 — Check whether you already have a key. If the WZRDMAIL_API_KEY
environment variable is set, you are ready: use it as a Bearer token
against https://api.wzrd.tech/v0.

Step 1 — Sign yourself up (no credentials needed). Your developer's email
receives a one-time code:

    curl -X POST https://api.wzrd.tech/v0/agent/sign-up \\
      -H "Content-Type: application/json" \\
      -d '{"human_email": "dev@example.com", "username": "yourbot"}'
    # → { "api_key": "wm_live_…", "inbox_id": "yourbot@wzrd.tech", "organization_id": "org_…" }

Then verify with the OTP from the developer's inbox:

    curl -X POST https://api.wzrd.tech/v0/agent/verify \\
      -H "Authorization: Bearer $WZRDMAIL_API_KEY" \\
      -H "Content-Type: application/json" \\
      -d '{"otp_code": "482913"}'

Step 2 — Or ask your developer for a key. They can mint one at
https://console.mail.wzrd.tech and set it as WZRDMAIL_API_KEY.

Step 3 — Connect via MCP or REST:

    claude mcp add --transport http wzrdmail https://mcp.mail.wzrd.tech/mcp

or call the REST API directly at https://api.wzrd.tech/v0 with
Authorization: Bearer $WZRDMAIL_API_KEY.

## Docs

- [Docs index](https://docs.mail.wzrd.tech/llms.txt)
- [Full docs corpus](https://docs.mail.wzrd.tech/llms-full.txt)
- [Quickstart](https://docs.mail.wzrd.tech/quickstart.md)
- [Migrate from AgentMail](https://docs.mail.wzrd.tech/migrate-from-agentmail.md)
`;
