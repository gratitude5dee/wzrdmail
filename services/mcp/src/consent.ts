import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";

import { ConnectError, connectClient } from "./connect.js";
import {
  codePage,
  consentPage,
  emailPage,
  noticePage,
  usernamePage
} from "./consent-html.js";
import type { Env } from "./env.js";
import { REQUIRED_SCOPE, SCOPES, isScope, permissionsForScopes, type Scope } from "./scopes.js";

/**
 * The consent flow (muse.md §7.4).
 *
 * Four POST steps behind one GET. State lives in OAUTH_KV under a random id
 * carried by an HttpOnly cookie, and every step re-checks that the nonce in the
 * form matches the one in that record, so a cross-site form post cannot drive
 * somebody else's authorization. Nothing here ever sees the API's session
 * cookie: the wzrdmail side of each step is a server-to-server call.
 */

const COOKIE = "wm_consent";
const TTL_SECONDS = 600;
const IP_LIMIT = 30;
const IP_WINDOW_SECONDS = 3600;

interface ConsentState {
  authRequest: AuthRequest;
  clientName: string;
  nonce: string;
  step: "email" | "username" | "code" | "consent";
  email?: string;
  connectToken?: string;
  organizationId?: string;
  newUser?: boolean;
  inboxes?: { inbox_id: string }[];
}

const randomId = (): string =>
  [...crypto.getRandomValues(new Uint8Array(24))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

const readCookie = (request: Request, name: string): string | null => {
  const header = request.headers.get("cookie");
  if (header === null) return null;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
};

const setCookie = (response: Response, sid: string | null): Response => {
  const headers = new Headers(response.headers);
  headers.append(
    "Set-Cookie",
    sid === null
      ? `${COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/authorize; Max-Age=0`
      : `${COOKIE}=${sid}; HttpOnly; Secure; SameSite=Lax; Path=/authorize; Max-Age=${String(TTL_SECONDS)}`
  );
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
};

const stateKey = (sid: string): string => `consent:${sid}`;

const loadState = async (env: Env, sid: string | null): Promise<ConsentState | null> => {
  if (sid === null || env.OAUTH_KV === undefined) return null;
  const raw = await env.OAUTH_KV.get(stateKey(sid));
  if (raw === null) return null;
  return JSON.parse(raw) as ConsentState;
};

const saveState = async (env: Env, sid: string, state: ConsentState): Promise<void> => {
  await env.OAUTH_KV?.put(stateKey(sid), JSON.stringify(state), {
    expirationTtl: TTL_SECONDS
  });
};

/** Best-effort per-IP throttle; KV is eventually consistent, which is fine here. */
const throttled = async (env: Env, request: Request): Promise<boolean> => {
  const ip = request.headers.get("cf-connecting-ip");
  if (ip === null || env.OAUTH_KV === undefined) return false;
  const key = `authz_rate:${ip}`;
  const current = Number((await env.OAUTH_KV.get(key)) ?? "0");
  if (current >= IP_LIMIT) return true;
  await env.OAUTH_KV.put(key, String(current + 1), { expirationTtl: IP_WINDOW_SECONDS });
  return false;
};

const redirect = (location: string): Response =>
  new Response(null, { status: 302, headers: { Location: location } });

const denyRedirect = (authRequest: AuthRequest, error: string): Response => {
  const url = new URL(authRequest.redirectUri);
  url.searchParams.set("error", error);
  if (authRequest.state !== "") url.searchParams.set("state", authRequest.state);
  if (authRequest.issuer !== undefined) url.searchParams.set("iss", authRequest.issuer);
  return redirect(url.toString());
};

/** Scopes the client asked for, narrowed to the ones this server issues. */
const requestedScopes = (authRequest: AuthRequest): Scope[] => {
  const asked = authRequest.scope.filter(isScope);
  const scopes = asked.length === 0 ? [...SCOPES] : asked;
  return scopes.includes(REQUIRED_SCOPE) ? scopes : [REQUIRED_SCOPE, ...scopes];
};

const messageFor = (error: unknown): string => {
  if (error instanceof ConnectError) {
    if (error.status === 429) {
      return error.retryAfter === undefined
        ? "Too many attempts. Wait a minute and try again."
        : `Too many attempts. Try again in ${error.retryAfter} seconds.`;
    }
    return error.envelope.message;
  }
  return "Something went wrong. Try again.";
};

/**
 * Handles every `/authorize*` request. Registered as the provider's
 * `defaultHandler`, so anything the provider does not own lands here.
 */
export const consentHandler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const helpers = (env as Env & { OAUTH_PROVIDER?: OAuthHelpers }).OAUTH_PROVIDER;

    if (url.pathname === "/authorize" && request.method === "GET") {
      if (helpers === undefined || env.OAUTH_KV === undefined) {
        return noticePage("Not available", "This server is not configured for OAuth sign-in.");
      }
      if (await throttled(env, request)) {
        return noticePage("Slow down", "Too many sign-in attempts from this network.");
      }
      let authRequest: AuthRequest;
      try {
        authRequest = await helpers.parseAuthRequest(request);
      } catch {
        return noticePage("Invalid request", "That authorization link is not valid.");
      }
      const client = await helpers.lookupClient(authRequest.clientId);
      const sid = randomId();
      const state: ConsentState = {
        authRequest,
        clientName: client?.clientName ?? "an application",
        nonce: randomId(),
        step: "email"
      };
      await saveState(env, sid, state);
      return setCookie(emailPage(state.clientName, state.nonce, null), sid);
    }

    if (url.pathname.startsWith("/authorize/") && request.method === "POST") {
      const sid = readCookie(request, COOKIE);
      const state = await loadState(env, sid);
      if (sid === null || state === null) {
        return noticePage("Session expired", "Start the connection again from the app.");
      }
      const form = await request.formData();
      if (form.get("csrf") !== state.nonce) {
        return noticePage("Invalid request", "That form could not be verified. Start again.");
      }
      const connect = connectClient(env, request);
      if (connect === null) {
        return noticePage("Not available", "This server is not configured for OAuth sign-in.");
      }

      if (url.pathname === "/authorize/email") {
        const email = String(form.get("email") ?? "").trim().toLowerCase();
        if (email === "" || !email.includes("@")) {
          return setCookie(emailPage(state.clientName, state.nonce, "Enter a valid email address."), sid);
        }
        try {
          const { registered } = await connect.start(email);
          state.email = email;
          if (registered) {
            state.step = "code";
            await saveState(env, sid, state);
            return setCookie(codePage(email, state.nonce, null), sid);
          }
          state.step = "username";
          await saveState(env, sid, state);
          return setCookie(usernamePage(state.clientName, email, state.nonce, null), sid);
        } catch (error) {
          return setCookie(emailPage(state.clientName, state.nonce, messageFor(error)), sid);
        }
      }

      if (url.pathname === "/authorize/signup") {
        const username = String(form.get("username") ?? "").trim().toLowerCase();
        const email = state.email ?? "";
        try {
          await connect.signup(email, username);
          state.step = "code";
          await saveState(env, sid, state);
          return setCookie(codePage(email, state.nonce, null), sid);
        } catch (error) {
          return setCookie(
            usernamePage(state.clientName, email, state.nonce, messageFor(error)),
            sid
          );
        }
      }

      if (url.pathname === "/authorize/verify") {
        const code = String(form.get("otp_code") ?? "").trim();
        const email = state.email ?? "";
        try {
          const result = await connect.verify(email, code);
          state.connectToken = result.connect_token;
          state.organizationId = result.organization_id;
          state.newUser = result.new_user;
          state.inboxes = result.inboxes.map((inbox) => ({ inbox_id: inbox.inbox_id }));
          if (state.inboxes.length === 0) {
            // Every grant is pinned to an inbox, so there is nothing to grant.
            return setCookie(
              noticePage(
                "No inbox to connect",
                "This account has no inbox. Create one in the wzrdmail console, then connect again."
              ),
              sid
            );
          }
          state.step = "consent";
          await saveState(env, sid, state);
          return setCookie(
            consentPage({
              clientName: state.clientName,
              requestedScopes: requestedScopes(state.authRequest),
              inboxes: state.inboxes,
              newUser: result.new_user,
              nonce: state.nonce,
              error: null
            }),
            sid
          );
        } catch (error) {
          return setCookie(codePage(email, state.nonce, messageFor(error)), sid);
        }
      }

      if (url.pathname === "/authorize/approve") {
        if (helpers === undefined) {
          return noticePage("Not available", "This server is not configured for OAuth sign-in.");
        }
        if (form.get("decision") !== "allow") {
          await env.OAUTH_KV?.delete(stateKey(sid));
          return setCookie(denyRedirect(state.authRequest, "access_denied"), null);
        }
        // Nothing can be granted before the one-time code proved who is asking.
        if (state.step !== "consent" || state.connectToken === undefined) {
          return noticePage("Not so fast", "Finish signing in before approving access.");
        }
        // A grant can narrow what the client asked for but never widen it, so
        // intersect the form's answer with the request rather than trusting it.
        const asked = new Set<string>(requestedScopes(state.authRequest));
        const granted = form
          .getAll("scopes")
          .map(String)
          .filter(isScope)
          .filter((scope) => asked.has(scope));
        const scopes = granted.includes(REQUIRED_SCOPE) ? [...new Set(granted)] : [];
        if (scopes.length === 0) {
          return setCookie(denyRedirect(state.authRequest, "access_denied"), null);
        }
        const inboxId = String(form.get("inbox_id") ?? "").trim();
        try {
          const key = await connect.complete({
            connectToken: state.connectToken,
            inboxId: inboxId === "" ? null : inboxId,
            permissions: permissionsForScopes(scopes),
            name: `${state.clientName} (connector)`,
            clientId: state.authRequest.clientId
          });
          const { redirectTo } = await helpers.completeAuthorization({
            request: state.authRequest,
            userId: key.organization_id,
            scope: scopes,
            metadata: {
              key_id: key.key_id,
              inbox_id: key.inbox_id,
              client_name: state.clientName
            },
            props: {
              apiKey: key.api_key,
              keyId: key.key_id,
              orgId: key.organization_id,
              inboxId: key.inbox_id,
              permissions: key.permissions
            }
          });
          await env.OAUTH_KV?.delete(stateKey(sid));
          return setCookie(redirect(redirectTo), null);
        } catch (error) {
          return setCookie(
            consentPage({
              clientName: state.clientName,
              requestedScopes: requestedScopes(state.authRequest),
              inboxes: state.inboxes ?? [],
              newUser: state.newUser ?? false,
              nonce: state.nonce,
              error: messageFor(error)
            }),
            sid
          );
        }
      }
    }

    return Response.json(
      { name: "not_found", message: "use POST /mcp (Streamable HTTP)" },
      { status: 404 }
    );
  }
};
