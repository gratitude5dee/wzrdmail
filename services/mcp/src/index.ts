import { extractApiKey } from "./auth.js";
import type { Env } from "./env.js";
import { buildOAuthProvider, oauthConfigured } from "./oauth.js";
import { CORS_HEADERS, serveMcp, withCors } from "./serve.js";

export type { Env };
export { WzrdmailMcp } from "./serve.js";

/**
 * Worker entry (muse.md §5.1).
 *
 * Credential dispatch runs before the OAuth provider, because the provider
 * 401s anything without a Bearer header and reads every bearer as its own
 * three-part token. A `wm_` API key contains no colon, so the two credential
 * spaces cannot collide — but the key lane still has to be checked first, or
 * every existing editor and CLI would be turned away at the door.
 *
 * Everything the key lane does not claim goes to the provider: the two
 * well-known documents, dynamic client registration, the token endpoint, the
 * consent pages, and `/mcp` with an OAuth bearer.
 */
/**
 * The provider answers an unauthenticated `/mcp` request with the RFC 9728
 * challenge header and an empty body. The header is the part a client needs,
 * but key-only clients — and the published troubleshooting text — still expect
 * wzrdmail's `{name, message}` envelope, so fill the body back in without
 * touching the headers.
 */
const withEnvelope = async (response: Response): Promise<Response> => {
  if (response.status !== 401) return response;
  const body = await response.clone().text();
  if (body !== "") return response;
  return new Response(
    JSON.stringify({
      name: "unauthorized",
      message: "provide x-api-key, Authorization: Bearer wm_…, or an OAuth access token"
    }),
    {
      status: 401,
      headers: (() => {
        const headers = new Headers(response.headers);
        headers.set("Content-Type", "application/json");
        return headers;
      })()
    }
  );
};

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    if (url.pathname === "/health") {
      return withCors(Response.json({ ok: true }));
    }

    const apiKey = url.pathname === "/mcp" ? extractApiKey(request) : null;
    const isOAuthBearer =
      apiKey !== null && !apiKey.startsWith("wm_") && request.headers.get("x-api-key") === null;

    if (apiKey !== null && !isOAuthBearer) {
      return serveMcp(request, env, ctx, { kind: "api_key", apiKey });
    }

    if (oauthConfigured(env)) {
      const response = await buildOAuthProvider(env).fetch(request, env, ctx);
      return withCors(await withEnvelope(response));
    }

    // OAuth is not provisioned on this deployment: behave exactly as before.
    if (url.pathname !== "/mcp") {
      return withCors(
        Response.json(
          { name: "not_found", message: "use POST /mcp (Streamable HTTP)" },
          { status: 404 }
        )
      );
    }
    return withCors(
      Response.json(
        { name: "unauthorized", message: "provide x-api-key or Authorization: Bearer wm_…" },
        { status: 401 }
      )
    );
  }
};
