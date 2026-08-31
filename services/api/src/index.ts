import { createApp } from "./app.js";
import { CloudflareEmailProvider } from "./egress/provider.js";
import { deliverDueScheduled, purgeExpiredTrash } from "./egress/scheduled.js";
import type { Env } from "./env.js";
import { handleEmail } from "./ingress/email.js";

const app = createApp();

export default {
  fetch: app.fetch,
  email: handleEmail,
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(
      (async () => {
        await deliverDueScheduled(env, new CloudflareEmailProvider(env));
        await purgeExpiredTrash(env);
      })()
    );
  }
} satisfies ExportedHandler<Env>;
