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

export default {
  fetch: (request, env, ctx) =>
    app.fetch(unmount(request, basePath(env)), env, ctx)
} satisfies ExportedHandler<Env>;
