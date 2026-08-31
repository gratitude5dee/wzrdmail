import { createApp } from "./app.js";
import type { Env } from "./env.js";
import { handleEmail } from "./ingress/email.js";
import { processDueDeliveries, pruneDeliveries } from "./lib/webhook-delivery.js";

const app = createApp();

export default {
  fetch: app.fetch,
  email: handleEmail,
  scheduled(_controller, env, ctx) {
    ctx.waitUntil(
      processDueDeliveries(env).then(() => pruneDeliveries(env.DB))
    );
  }
} satisfies ExportedHandler<Env>;
