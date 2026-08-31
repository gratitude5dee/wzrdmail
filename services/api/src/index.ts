import { createApp } from "./app.js";
import type { Env } from "./env.js";
import { handleEmail } from "./ingress/email.js";

const app = createApp();

export default {
  fetch: app.fetch,
  email: handleEmail
} satisfies ExportedHandler<Env>;
