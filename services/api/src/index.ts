import { createApp } from "./app.js";
import { CloudflareEmailProvider } from "./egress/provider.js";
import { deliverDueScheduled, purgeExpiredTrash } from "./egress/scheduled.js";
import type { Env } from "./env.js";
import { handleEmail } from "./ingress/email.js";
import { processDueDeliveries, pruneDeliveries } from "./lib/webhook-delivery.js";

const app = createApp();

export default {
  fetch: app.fetch,
  email: handleEmail,
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(
      (async () => {
        await deliverDueScheduled(env, new CloudflareEmailProvider(env));
        await purgeExpiredTrash(env);
        await processDueDeliveries(env);
        await pruneDeliveries(env.DB);
      })()
    );
  }
} satisfies ExportedHandler<Env>;
