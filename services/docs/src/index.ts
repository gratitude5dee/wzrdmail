import { basePath, createApp } from "./app.js";
import type { Env } from "./env.js";

const app = createApp();

/** Strip the mount prefix (e.g. `/docs`) so routes stay written at the root. */
function unmount(request: Request, prefix: string): Request {
  if (prefix === "") return request;
  const url = new URL(request.url);
  if (url.pathname === prefix) {
    url.pathname = "/";
  } else if (url.pathname.startsWith(`${prefix}/`)) {
    url.pathname = url.pathname.slice(prefix.length);
  } else {
    return request;
  }
  return new Request(url, request);
}

/** Legacy docs hostnames 301 to the canonical docs.mail.wzrd.tech URLs. */
function legacyRedirect(request: Request): Response | null {
  const url = new URL(request.url);
  if (url.hostname !== "docs.wzrd.tech" && url.hostname !== "staging.docs.wzrd.tech") {
    return null;
  }
  const host = url.hostname.startsWith("staging.")
    ? "staging.docs.mail.wzrd.tech"
    : "docs.mail.wzrd.tech";
  return Response.redirect(`https://${host}${url.pathname}${url.search}`, 301);
}

export default {
  fetch: (request, env, ctx) =>
    legacyRedirect(request) ?? app.fetch(unmount(request, basePath(env)), env, ctx)
} satisfies ExportedHandler<Env>;
