# Changelog

## 0.2.0 (2026-09-20)

- The hosted MCP server now accepts OAuth 2.1 with PKCE at the bare URL `https://mcp.mail.wzrd.tech/mcp`, alongside the existing `x-api-key` and `Authorization: Bearer` headers. A credential-less request answers `401` with a `WWW-Authenticate` challenge advertising the scopes `mail:read`, `mail:drafts` and `mail:send`; browser sign-in and a consent screen mint an inbox-scoped grant, creating a `<username>@wzrd.tech` address for a user who has none.
- `admin` is never issued over OAuth: `create_inbox` and `create_webhook` still require a header key.
- Two new tools, 22 to 24: `whoami` (which address this connection owns and what it may do) and `check_new_mail` (poll for mail that arrived since the previous `next_since`).
- `update_message` now needs only `read` for read-state and label changes, so a read-only connection can mark its own mail read.
- `.mcp.json` is unchanged; every existing client keeps working byte-for-byte.

## 0.1.0 (2026-09-02)

- Initial wzrdmail agent plugin, ported from the AgentMail plugin layout.
- Skills: `send-email`, `check-email`, `manage-inboxes`, `wzrdmail` (SDK), `wzrdmail-cli`, `wzrdmail-mcp`, `wzrdmail-toolkit`, `agent-email-patterns`.
- Hosted MCP server at `https://mcp.mail.wzrd.tech/mcp`; Claude Code, Cursor, Codex, and Open Plugins manifests.
