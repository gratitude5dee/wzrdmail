# WZRDMail MCP plugin

OpenAI MCP plugin packaging for the WZRDMail MCP server
(`services/mcp`, deployed at `https://mcp.mail.wzrd.tech/mcp`).

## Contents

- `.codex-plugin/plugin.json` — plugin manifest (identity, interface, onboarding skill).
- `.mcp.json` — remote MCP server entry; requires `WZRDMAIL_API_KEY` (sent as `x-api-key`).
- `skills/onboarding/SKILL.md` — onboarding instructions for connecting users.
- `assets/` — plugin icons.

## Extension surfaces implemented by the server

- **Entrypoints** (`_meta["openai/ui"].entrypoints`):
  - `open_mailbox` — `{ "type": "global" }` sidebar app (fullscreen mailbox).
  - `open_message` — `{ "type": "thread" }` per-thread message/compose surface.
- **MCP App resources**: `ui://wzrdmail/mailbox` and `ui://wzrdmail/message`,
  served as `text/html;profile=mcp-app` (fully self-contained HTML).
- **App tools**: `list_inboxes`, `list_messages`, `list_drafts`,
  `get_message`, `send_message`, `reply_to_message`, `create_draft`,
  `send_draft` carry `_meta.ui.resourceUri`.
- **Structured settings**: `capabilities.extensions["openai/settings"]` →
  `settings.read` / `settings.update` (`default_inbox`, `messages_per_page`,
  `confirm_send`), persisted in the session Durable Object.

All extension data is `_meta`-only — clients that do not speak the OpenAI
extensions or MCP Apps see the unchanged mail toolset.
