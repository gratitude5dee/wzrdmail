import { OAuthProvider } from "@cloudflare/workers-oauth-provider";

import { consentHandler } from "./consent.js";
import type { Env } from "./env.js";
import type { Principal } from "./principal.js";
import { SCOPES } from "./scopes.js";
import { serveMcp } from "./serve.js";

/**
 * The OAuth 2.1 authorization server (muse.md §5).
 *
 * It runs on this Worker rather than beside the database, because RFC 9728
 * puts protected-resource metadata on the resource itself and this is the only
 * Worker routed to the MCP hostname. The provider owns discovery, dynamic
 * client registration, PKCE, tokens and revocation; the consent page owns
 * sign-in; and the grant it stores carries the API key every tool call is made
 * with, encrypted so only the presented bearer token can unwrap it.
 */

/** Grant props, as written by the consent page's completeAuthorization call. */
interface GrantProps extends Record<string, unknown> {
  apiKey: string;
  keyId: string;
  orgId: string;
  inboxId: string | null;
  permissions: string[];
}

const asPrincipal = (props: unknown): Principal | null => {
  if (typeof props !== "object" || props === null) return null;
  const record = props as Partial<GrantProps>;
  if (typeof record.apiKey !== "string" || record.apiKey === "") return null;
  return {
    kind: "oauth",
    apiKey: record.apiKey,
    permissions: Array.isArray(record.permissions) ? record.permissions.map(String) : undefined,
    inboxId: typeof record.inboxId === "string" ? record.inboxId : undefined
  };
};

/**
 * What the provider hands an authenticated request. `ctx.props` holds the
 * decrypted grant, so an OAuth caller reaches exactly the same MCP server as a
 * key caller — just with its permissions and inbox already known.
 */
const mcpApiHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const principal = asPrincipal((ctx as { props?: unknown }).props);
    if (principal === null) {
      return Response.json(
        { name: "unauthorized", message: "this grant carries no usable credential" },
        { status: 401 }
      );
    }
    return serveMcp(request, env, ctx, principal);
  }
};

/** True when this deployment has been provisioned for OAuth. */
export const oauthConfigured = (env: Env): boolean =>
  env.OAUTH_KV !== undefined &&
  env.CONNECT_SECRET !== undefined &&
  env.CONNECT_SECRET !== "" &&
  env.MCP_PUBLIC_ORIGIN !== undefined &&
  env.MCP_PUBLIC_ORIGIN !== "";

export const buildOAuthProvider = (env: Env): OAuthProvider => {
  const origin = env.MCP_PUBLIC_ORIGIN ?? "";
  return new OAuthProvider({
    apiRoute: "/mcp",
    apiHandler: mcpApiHandler,
    defaultHandler: consentHandler,
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/token",
    clientRegistrationEndpoint: "/register",
    scopesSupported: [...SCOPES],
    // One hour: long enough for a scheduled agent run, short enough that a
    // leaked token is not a standing grant.
    accessTokenTTL: 3600,
    resourceMetadata: {
      resource: `${origin}/mcp`,
      scopes_supported: [...SCOPES],
      resource_name: "WZRD Mail",
      bearer_methods_supported: ["header"]
    }
  });
};
