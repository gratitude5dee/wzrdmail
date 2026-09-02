---
name: wzrdmail-mcp
description: Configure or troubleshoot the hosted wzrdmail MCP server for Codex, Claude Code, Cursor, Hermes, or another Streamable HTTP MCP client. Use for installation, x-api-key headers, OAuth, connection failures, or MCP tool discovery. Do not use when the connection already works and the user just wants to send, check, or manage mail — use the sibling action skills for that.
---

# wzrdmail MCP

Prefer the hosted Streamable HTTP server:

```text
https://mcp.mail.wzrd.tech/mcp
```

It is a Cloudflare Worker in front of the same `/v0` REST API the SDK and CLI use; there is no local Node.js process to run.

## Claude Code, Codex, and Cursor

```json
{
  "mcpServers": {
    "wzrdmail": {
      "type": "http",
      "url": "https://mcp.mail.wzrd.tech/mcp",
      "headers": {
        "x-api-key": "${env:WZRDMAIL_API_KEY}"
      }
    }
  }
}
```

Claude Code can also install it directly:

```bash
claude mcp add --transport http wzrdmail https://mcp.mail.wzrd.tech/mcp \
  --header "x-api-key: ${WZRDMAIL_API_KEY}"
```

Hermes / Air boxes:

```bash
hermes mcp add wzrdmail --url https://mcp.mail.wzrd.tech/mcp --header "x-api-key: \${WZRDMAIL_API_KEY}"
```

Do not put an empty or literal API key in the configuration; reference the environment variable.

## Per-client configuration

Add the same `type: http` server entry to the client's MCP config file:

- Cursor: `.cursor/mcp.json`
- VS Code: `.vscode/mcp.json`
- Windsurf: its MCP config file
- Claude Desktop: `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%/Claude/claude_desktop_config.json` (Windows)
- Hermes: `mcp_servers` in `~/.hermes/config.yaml`

## Auth options

- **`x-api-key: wm_…` header** — recommended. Works with every Streamable HTTP client.
- **`Authorization: Bearer wm_…` header** — equivalent alternative for clients that only support bearer auth.
- **OAuth** — browser-based sign-in through the console; use the bare URL with no credentials once your client and the server both advertise it. If the server answers `401 unauthorized` to a credential-less request, OAuth is not enabled yet for that deployment — fall back to a header.

Never pass the key as a query-string parameter; keys must not end up in logs or history.

## Key scope

An MCP session inherits the scope and permissions of the key that created it:

- **Organization key** — every inbox in the org.
- **Pod key** — inboxes in one pod.
- **Inbox key** (`inbox_id` set at creation) — exactly one inbox; `list_inboxes` returns only it and `create_inbox` is refused.
- **Permissions** `read`, `drafts`, `send`, `admin`. `send` implies `drafts`. A `read,drafts` key can `create_draft` but `send_message`, `send_draft`, replies, and forwards return `403 forbidden` — the recommended shape when a human or a separate control plane approves outbound mail.

## Tool discovery

Clients get the tool catalog and schemas live from the hosted runtime; do not rely on a copied tool count. Current tools:

`list_inboxes`, `create_inbox`, `get_inbox`, `list_messages`, `get_message`, `send_message`, `reply_to_message`, `reply_all_to_message`, `forward_message`, `update_message`, `list_threads`, `get_thread`, `search_threads`, `list_drafts`, `create_draft`, `update_draft`, `send_draft`, `get_attachment`, `list_webhooks`, `create_webhook`, `list_domains`, `get_usage`.

The source of truth is `services/mcp/src/tools.ts` in the wzrdmail repository.

## Verify

1. Restart the client or open a new session after installing the plugin.
2. Inspect MCP status in the client and confirm the server is connected.
3. Call `list_inboxes` as a read-only smoke test.
4. Call `create_draft` on the returned inbox and confirm a `draft_id`; on a `read,drafts` key confirm `send_draft` is refused with `403`.

## Troubleshoot

- A 404 usually means the URL is missing `/mcp`.
- `401 unauthorized` with the message `provide x-api-key or Authorization: Bearer wm_…` means no credential reached the server — the env var was not available to the client process or the header name is wrong.
- `401` with a valid-looking key means the key is wrong, revoked, or belongs to a different environment (`wm_live_` vs `wm_test_`).
- `api key does not match the key this MCP session was created with` means the client reused a session ID with a different key; start a new session.
- `403 forbidden` is a permission or scope refusal, not a connection problem. Read the message: it names the missing permission or the inbox the key is scoped to.
