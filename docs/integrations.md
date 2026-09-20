# Integrations

## Agent plugin (Claude Code, Cursor, Codex, Open Plugins)

The native plugin lives at [`plugins/agents`](https://github.com/gratitude5dee/wzrdmail/tree/main/plugins/agents) and ships eight skills — `send-email`, `check-email`, `manage-inboxes`, `wzrdmail` (SDK), `wzrdmail-cli`, `wzrdmail-mcp`, `wzrdmail-toolkit`, `agent-email-patterns` — plus `.mcp.json` pointing at the hosted MCP server.

```bash
# Claude Code
claude plugin marketplace add gratitude5dee/wzrdmail --path plugins/agents
claude plugin install wzrdmail

# Cursor — add plugins/agents as a local plugin, or merge .mcp.json into .cursor/mcp.json
# Codex — point at plugins/agents/.agents/plugins/marketplace.json
```

Set `WZRDMAIL_API_KEY` in the client's environment; the skills never embed keys.

## MCP server

```text
https://mcp.mail.wzrd.tech/mcp        Streamable HTTP
x-api-key: wm_live_…                  or  Authorization: Bearer wm_live_…
```

```bash
claude mcp add --transport http wzrdmail https://mcp.mail.wzrd.tech/mcp --header "x-api-key: ${WZRDMAIL_API_KEY}"
```

All 24 tools: `whoami`, `check_new_mail`, `list_inboxes`, `create_inbox`, `get_inbox`, `list_messages`, `get_message`, `send_message`, `reply_to_message`, `reply_all_to_message`, `forward_message`, `update_message`, `list_threads`, `get_thread`, `search_threads`, `list_drafts`, `create_draft`, `update_draft`, `send_draft`, `get_attachment`, `list_webhooks`, `create_webhook`, `list_domains`, `get_usage`. Tools are filtered by the key's permissions: an inbox-scoped `read,drafts` key can `create_draft` but `send_message` / `send_draft` return `forbidden`.

The same URL also accepts OAuth 2.1 with PKCE: a client that connects with no credentials is sent through browser sign-in and a consent screen, and comes back with a token scoped to `mail:read`, `mail:drafts` and `mail:send` on one inbox. See the [MCP server reference](/mcp).

## Support matrix

Every row points at a real artifact, not a claim.

| Client | Mechanism | Artifact |
| --- | --- | --- |
| Claude Code / Claude Desktop | MCP with `x-api-key`, or OAuth 2.1 (PKCE) at the bare URL | `plugins/agents` plugin; `claude mcp add --transport http wzrdmail https://mcp.mail.wzrd.tech/mcp` |
| Cursor | MCP with `x-api-key` | `plugins/agents` local plugin, or `.mcp.json` merged into `.cursor/mcp.json` |
| Codex | MCP with `x-api-key` | `plugins/agents/.agents/plugins/marketplace.json` |
| Hermes | MCP with `x-api-key` | `mcp_servers` entry in `~/.hermes/config.yaml`; `wzrdmail-mcp` skill |
| Meta Muse | MCP + OAuth 2.1 (PKCE) | the connector listing on Meta's Muse Platform (submission pending); [connector page](/mcp/muse) |
| Any REST client | HTTPS + `Authorization: Bearer` | [Quickstart](/quickstart) |

## CLI

```bash
npm i -g @wzrdmail/cli          # binaries: wzrdmail, wm
export WZRDMAIL_API_KEY=wm_live_…
wzrdmail inboxes list
wzrdmail messages send <inbox_id> --to a@example.com --subject Hi --text "Hello"
wzrdmail keys create --name box --inbox-id agent@wzrd.tech --permissions read,drafts
wzrdmail events tail --inbox-ids agent@wzrd.tech
```

`WZRDMAIL_BASE_URL` overrides the API host; `WZRDMAIL_CONFIG_PATH` relocates the saved login.

## SDKs

```bash
npm install wzrdmail     # import { WzrdMailClient } from "wzrdmail"
pip install wzrdmail     # from wzrdmail import WzrdMail
```

## Webhooks

Standard Webhooks / Svix signing (`svix-id`, `svix-timestamp`, `svix-signature`, `whsec_` secret). Any Svix verifier or `verifyWebhook` from `@wzrdmail/core` works. Subscribe per inbox (`inbox_id`), per pod set (`pod_ids`), or organization-wide.
