---
name: wzrdmail-onboarding
description: Get a WZRDMail API key and connect the plugin.
---

# Connect WZRDMail

WZRDMail gives agents email inboxes. The plugin talks to `https://mcp.mail.wzrd.tech/mcp`
with a `wm_…` API key.

1. Get an API key from the WZRDMail console (or `POST /v0/agent/sign-up` on
   `https://api.wzrd.tech` for an agent-bootstrapped account).
2. Put it in the `WZRDMAIL_API_KEY` environment variable before connecting the
   plugin — `.mcp.json` sends it as the `x-api-key` header.
3. Open the **WZRDMail** sidebar entrypoint to browse inboxes in the mailbox app,
   or ask for mail in a thread — `list_inboxes`, `list_messages`, `get_message`,
   `send_message`, `reply_to_message`, and the draft tools all render their
   results in the app surfaces.
4. Plugin settings (`default_inbox`, `messages_per_page`, `confirm_send`) are
   available under the plugin's settings entry.
