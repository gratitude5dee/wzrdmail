---
name: wzrdmail-cli
description: Operate wzrdmail from a shell with the official CLI (`wzrdmail`, alias `wm`). Use when the user wants commands for listing or creating inboxes, reading or searching mail, sending or replying, managing drafts, webhooks, domains, pods, or API keys, tailing events, or scripting JSON output; do not use for SDK code, MCP setup, or framework adapters.
---

# wzrdmail CLI

Install the CLI and provide the API key through the environment.

```bash
npm install -g @wzrdmail/cli
export WZRDMAIL_API_KEY="wm_live_..."
# or store it once:
wzrdmail auth login --api-key wm_live_...
```

`wm` is a short alias for `wzrdmail`. Every command accepts `--format json` for machine-clean output and `--api-key wm_…` to override the environment for one call. Exit codes: `0` ok, `1` error, `2` auth, `3` plan limit.

## Inboxes

```bash
wzrdmail inboxes list
wzrdmail inboxes get <inbox_id>
wzrdmail inboxes create --username support --display-name "Support Agent"
wzrdmail inboxes delete <inbox_id>
```

`inbox_id` is the address (`support@wzrd.tech`). Confirm the exact inbox before running the destructive delete command.

## Messages and threads

```bash
wzrdmail messages list <inbox_id> [--labels unread] [--after 2026-01-01T00:00:00Z]
wzrdmail messages get <inbox_id> <message_id>

wzrdmail messages send <inbox_id> --to recipient@example.com --subject "Hello" --text "Message body"
wzrdmail messages send <inbox_id> --to recipient@example.com --subject "Hello" --html "<h1>Hello</h1>"

wzrdmail messages reply <inbox_id> <message_id> --text "Reply body"
wzrdmail messages reply <inbox_id> <message_id> --text "Reply body" --all
wzrdmail messages forward <inbox_id> <message_id> --to someone@example.com

wzrdmail threads list <inbox_id>
wzrdmail threads get <inbox_id> <thread_id>
wzrdmail threads search <inbox_id> --query "invoice"
```

Use a message ID for replies. Fetch the full message before relying on body content; list output is metadata only.

## Drafts

```bash
wzrdmail drafts create <inbox_id> --to recipient@example.com --subject "Pending approval" --text "Draft body"
wzrdmail drafts list <inbox_id>
wzrdmail drafts send <inbox_id> <draft_id>
```

A draft is not authorization to send. With a `read,drafts` key `drafts send` exits `1` with `forbidden` — expected when send is held elsewhere.

## Webhooks and events

```bash
wzrdmail webhooks create --url https://example.com/webhook --event-types message.received,message.bounced
wzrdmail webhooks list
wzrdmail webhooks test <webhook_id>
wzrdmail webhooks delete <webhook_id>

wzrdmail events tail --inbox-ids a@wzrd.tech,b@wzrd.tech   # live WebSocket stream
```

The signing secret (`whsec_…`) is printed once on create — store it in `WZRDMAIL_WEBHOOK_SECRET`.

## Administration

```bash
wzrdmail domains list | add --domain example.com | verify <domain_id> | records <domain_id>
wzrdmail pods list | create [--name NAME]
wzrdmail keys list
wzrdmail keys create --name box --inbox-id agent@wzrd.tech --permissions read,drafts
wzrdmail keys revoke <key_id>
wzrdmail usage [--month YYYY-MM]
wzrdmail auth whoami
```

`keys create --inbox-id` mints an inbox-scoped key: it can only touch that inbox, inherits the inbox's pod, and with `--permissions read,drafts` it is structurally unable to send.

## Agent sign-up (no key yet)

```bash
wzrdmail agent sign-up --human-email you@example.com --username my-agent
wzrdmail agent verify --otp-code 123456
```

Sign-up with the same `human_email` rotates the existing key — never call it just to "check" a key.

## Environment

| Variable | Purpose |
| --- | --- |
| `WZRDMAIL_API_KEY` | API key (wins over the stored login) |
| `WZRDMAIL_BASE_URL` | API base URL (default `https://api.wzrd.tech`) |
| `WZRDMAIL_CONFIG_PATH` | key store path (default `~/.config/wzrdmail/config.json`) |

Run `wzrdmail --help` before using a command not covered here.
