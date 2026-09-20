import { SELF, fetchMock } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

/**
 * End-to-end OAuth (muse.md §5, §7.4): registration, the consent pages, the
 * token exchange, and an authenticated tool call — with the wzrdmail API
 * mocked, because the consent page's only side effects are the four
 * server-to-server /v0/connect/* calls.
 */

const ORIGIN = "http://localhost:8788";
const API = "http://localhost:8787";
const REDIRECT = "https://client.example/callback";

const MINTED_KEY = "wm_live_aabbccddeeff00112233445566778899aabbccddeeff0011";

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});

afterEach(() => {
  fetchMock.assertNoPendingInterceptors();
});

const b64url = (bytes: ArrayBuffer): string =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

const pkce = async (): Promise<{ verifier: string; challenge: string }> => {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)).buffer);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: b64url(digest) };
};

/** The consent forms carry a nonce that every POST has to echo back. */
const csrfFrom = (html: string): string => {
  const match = /name="csrf" value="([^"]+)"/.exec(html);
  const token = match?.[1];
  if (token === undefined) throw new Error("no csrf token in consent page");
  return token;
};

const cookieFrom = (response: Response): string => {
  const header = response.headers.get("set-cookie") ?? "";
  return header.split(";")[0] ?? "";
};

const registerClient = async (): Promise<string> => {
  const res = await SELF.fetch(`${ORIGIN}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Test Agent",
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: "none"
    })
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { client_id: string };
  return body.client_id;
};

describe("dynamic client registration", () => {
  it("registers a public client without credentials", async () => {
    const clientId = await registerClient();
    expect(clientId).toBeTruthy();
  });
});

describe("authorization code flow", () => {
  it("signs an existing user in, mints a scoped key and authorizes a tool call", async () => {
    const clientId = await registerClient();
    const { verifier, challenge } = await pkce();

    // 1. The client sends the user to /authorize; we get the email form.
    const authorizeUrl =
      `${ORIGIN}/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}` +
      `&redirect_uri=${encodeURIComponent(REDIRECT)}&state=xyz` +
      `&scope=${encodeURIComponent("mail:read mail:send")}` +
      `&code_challenge=${challenge}&code_challenge_method=S256`;
    const page = await SELF.fetch(authorizeUrl);
    expect(page.status).toBe(200);
    const cookie = cookieFrom(page);
    expect(cookie).toContain("wm_consent=");
    const emailHtml = await page.text();
    expect(emailHtml).toContain("Test Agent");
    const csrf = csrfFrom(emailHtml);

    // 2. Email step: the API says this address already has an account.
    fetchMock
      .get(API)
      .intercept({ path: "/v0/connect/start", method: "POST" })
      .reply(200, { registered: true });
    const step2 = await SELF.fetch(`${ORIGIN}/authorize/email`, {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf, email: "owner@example.com" })
    });
    expect(step2.status).toBe(200);
    expect(await step2.text()).toContain("Check your email");

    // 3. Code step: the one-time code checks out and we learn the inboxes.
    fetchMock
      .get(API)
      .intercept({ path: "/v0/connect/verify", method: "POST" })
      .reply(200, {
        connect_token: "ct_test",
        organization_id: "org_test",
        new_user: false,
        inboxes: [{ inbox_id: "scout@wzrd.tech" }]
      });
    const step3 = await SELF.fetch(`${ORIGIN}/authorize/verify`, {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf, otp_code: "123456" })
    });
    expect(step3.status).toBe(200);
    const consentHtml = await step3.text();
    expect(consentHtml).toContain("Allow Test Agent?");
    expect(consentHtml).toContain("scout@wzrd.tech");

    // 4. Approve: the API mints one inbox-scoped key for this grant.
    let mintedWith: Record<string, unknown> = {};
    fetchMock
      .get(API)
      .intercept({ path: "/v0/connect/complete", method: "POST" })
      .reply((options) => {
        mintedWith = JSON.parse(String(options.body)) as Record<string, unknown>;
        return {
          statusCode: 201,
          data: {
            api_key: MINTED_KEY,
            key_id: "key_test",
            inbox_id: "scout@wzrd.tech",
            organization_id: "org_test",
            permissions: ["read", "send"]
          },
          responseOptions: { headers: { "content-type": "application/json" } }
        };
      });
    const approve = await SELF.fetch(`${ORIGIN}/authorize/approve`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams([
        ["csrf", csrf],
        ["decision", "allow"],
        ["inbox_id", "scout@wzrd.tech"],
        ["scopes", "mail:read"],
        ["scopes", "mail:send"]
      ])
    });
    expect(approve.status).toBe(302);

    // The grant is pinned to one inbox and never carries admin.
    expect(mintedWith.inbox_id).toBe("scout@wzrd.tech");
    expect(mintedWith.permissions).toEqual(["read", "send"]);
    expect(mintedWith.connect_token).toBe("ct_test");

    const location = new URL(approve.headers.get("location") ?? "");
    expect(`${location.origin}${location.pathname}`).toBe(REDIRECT);
    expect(location.searchParams.get("state")).toBe("xyz");
    const code = location.searchParams.get("code");
    expect(code).toBeTruthy();

    // 5. Token exchange with the PKCE verifier.
    const token = await SELF.fetch(`${ORIGIN}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: code ?? "",
        redirect_uri: REDIRECT,
        client_id: clientId,
        code_verifier: verifier
      })
    });
    expect(token.status).toBe(200);
    const grant = (await token.json()) as { access_token: string; scope: string };
    expect(grant.access_token).toBeTruthy();
    expect(grant.scope).toContain("mail:read");

    // 6. The access token reaches the MCP server, on the JSON lane, with the
    //    catalogue narrowed to what was actually granted.
    const tools = await SELF.fetch(`${ORIGIN}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${grant.access_token}`,
        "content-type": "application/json",
        accept: "application/json"
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })
    });
    expect(tools.status).toBe(200);
    expect(tools.headers.get("content-type")).toContain("application/json");
    const listed = (await tools.json()) as { result: { tools: { name: string }[] } };
    const names = listed.result.tools.map((tool) => tool.name);

    expect(names).toContain("send_message");
    expect(names).toContain("check_new_mail");
    // send implies drafts, exactly as the API's own permission check does.
    expect(names).toContain("create_draft");
    // admin is never granted over OAuth.
    expect(names).not.toContain("create_inbox");
    expect(names).not.toContain("create_webhook");
  });

  it("rejects a token exchange that presents the wrong PKCE verifier", async () => {
    const clientId = await registerClient();
    const { challenge } = await pkce();
    const wrong = await pkce();

    const page = await SELF.fetch(
      `${ORIGIN}/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}` +
        `&redirect_uri=${encodeURIComponent(REDIRECT)}&state=s` +
        `&scope=${encodeURIComponent("mail:read")}` +
        `&code_challenge=${challenge}&code_challenge_method=S256`
    );
    const cookie = cookieFrom(page);
    const csrf = csrfFrom(await page.text());

    fetchMock
      .get(API)
      .intercept({ path: "/v0/connect/start", method: "POST" })
      .reply(200, { registered: true });
    await SELF.fetch(`${ORIGIN}/authorize/email`, {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf, email: "owner@example.com" })
    });

    fetchMock
      .get(API)
      .intercept({ path: "/v0/connect/verify", method: "POST" })
      .reply(200, {
        connect_token: "ct_test",
        organization_id: "org_test",
        new_user: false,
        inboxes: [{ inbox_id: "scout@wzrd.tech" }]
      });
    await SELF.fetch(`${ORIGIN}/authorize/verify`, {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf, otp_code: "123456" })
    });

    fetchMock
      .get(API)
      .intercept({ path: "/v0/connect/complete", method: "POST" })
      .reply(201, {
        api_key: MINTED_KEY,
        key_id: "key_test",
        inbox_id: "scout@wzrd.tech",
        organization_id: "org_test",
        permissions: ["read"]
      });
    const approve = await SELF.fetch(`${ORIGIN}/authorize/approve`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams([
        ["csrf", csrf],
        ["decision", "allow"],
        ["inbox_id", "scout@wzrd.tech"],
        ["scopes", "mail:read"]
      ])
    });
    const code = new URL(approve.headers.get("location") ?? "").searchParams.get("code");

    const token = await SELF.fetch(`${ORIGIN}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: code ?? "",
        redirect_uri: REDIRECT,
        client_id: clientId,
        code_verifier: wrong.verifier
      })
    });
    expect(token.status).toBeGreaterThanOrEqual(400);
  });

  it("redirects with access_denied when the user cancels", async () => {
    const clientId = await registerClient();
    const { challenge } = await pkce();
    const page = await SELF.fetch(
      `${ORIGIN}/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}` +
        `&redirect_uri=${encodeURIComponent(REDIRECT)}&state=cancel-me` +
        `&scope=${encodeURIComponent("mail:read")}` +
        `&code_challenge=${challenge}&code_challenge_method=S256`
    );
    const cookie = cookieFrom(page);
    const csrf = csrfFrom(await page.text());

    const denied = await SELF.fetch(`${ORIGIN}/authorize/approve`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf, decision: "deny" })
    });
    expect(denied.status).toBe(302);
    const location = new URL(denied.headers.get("location") ?? "");
    expect(location.searchParams.get("error")).toBe("access_denied");
    expect(location.searchParams.get("state")).toBe("cancel-me");
  });

  it("refuses a consent step whose CSRF nonce does not match", async () => {
    const clientId = await registerClient();
    const { challenge } = await pkce();
    const page = await SELF.fetch(
      `${ORIGIN}/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}` +
        `&redirect_uri=${encodeURIComponent(REDIRECT)}&state=s` +
        `&scope=${encodeURIComponent("mail:read")}` +
        `&code_challenge=${challenge}&code_challenge_method=S256`
    );
    const cookie = cookieFrom(page);
    await page.text();

    const forged = await SELF.fetch(`${ORIGIN}/authorize/email`, {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf: "not-the-nonce", email: "owner@example.com" })
    });
    expect(await forged.text()).toContain("could not be verified");
  });
});

describe("new user sign-up inside the flow", () => {
  it("asks for a username when the email has no account yet", async () => {
    const clientId = await registerClient();
    const { challenge } = await pkce();
    const page = await SELF.fetch(
      `${ORIGIN}/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}` +
        `&redirect_uri=${encodeURIComponent(REDIRECT)}&state=s` +
        `&scope=${encodeURIComponent("mail:read mail:send")}` +
        `&code_challenge=${challenge}&code_challenge_method=S256`
    );
    const cookie = cookieFrom(page);
    const csrf = csrfFrom(await page.text());

    fetchMock
      .get(API)
      .intercept({ path: "/v0/connect/start", method: "POST" })
      .reply(200, { registered: false });
    const username = await SELF.fetch(`${ORIGIN}/authorize/email`, {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf, email: "newcomer@example.com" })
    });
    const html = await username.text();
    expect(html).toContain("its own address");
    expect(html).toContain("@wzrd.tech");

    fetchMock
      .get(API)
      .intercept({ path: "/v0/connect/signup", method: "POST" })
      .reply(200, { message: "code sent" });
    const code = await SELF.fetch(`${ORIGIN}/authorize/signup`, {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf, username: "newcomer" })
    });
    expect(await code.text()).toContain("Check your email");
  });
});

describe("grant boundaries", () => {
  it("cannot be widened past what the client asked for", async () => {
    const clientId = await registerClient();
    const { challenge } = await pkce();

    // The client asks only to read.
    const page = await SELF.fetch(
      `${ORIGIN}/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}` +
        `&redirect_uri=${encodeURIComponent(REDIRECT)}&state=s` +
        `&scope=${encodeURIComponent("mail:read")}` +
        `&code_challenge=${challenge}&code_challenge_method=S256`
    );
    const cookie = cookieFrom(page);
    const csrf = csrfFrom(await page.text());

    fetchMock
      .get(API)
      .intercept({ path: "/v0/connect/start", method: "POST" })
      .reply(200, { registered: true });
    await SELF.fetch(`${ORIGIN}/authorize/email`, {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf, email: "owner@example.com" })
    });

    fetchMock
      .get(API)
      .intercept({ path: "/v0/connect/verify", method: "POST" })
      .reply(200, {
        connect_token: "ct_test",
        organization_id: "org_test",
        new_user: false,
        inboxes: [{ inbox_id: "scout@wzrd.tech" }]
      });
    await SELF.fetch(`${ORIGIN}/authorize/verify`, {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf, otp_code: "123456" })
    });

    // A forged form tries to grant sending as well.
    let mintedWith: Record<string, unknown> = {};
    fetchMock
      .get(API)
      .intercept({ path: "/v0/connect/complete", method: "POST" })
      .reply((options) => {
        mintedWith = JSON.parse(String(options.body)) as Record<string, unknown>;
        return {
          statusCode: 201,
          data: {
            api_key: MINTED_KEY,
            key_id: "key_test",
            inbox_id: "scout@wzrd.tech",
            organization_id: "org_test",
            permissions: ["read"]
          },
          responseOptions: { headers: { "content-type": "application/json" } }
        };
      });
    await SELF.fetch(`${ORIGIN}/authorize/approve`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams([
        ["csrf", csrf],
        ["decision", "allow"],
        ["inbox_id", "scout@wzrd.tech"],
        ["scopes", "mail:read"],
        ["scopes", "mail:send"]
      ])
    });

    expect(mintedWith.permissions).toEqual(["read"]);
  });

  it("refuses to approve before the one-time code is verified", async () => {
    const clientId = await registerClient();
    const { challenge } = await pkce();
    const page = await SELF.fetch(
      `${ORIGIN}/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}` +
        `&redirect_uri=${encodeURIComponent(REDIRECT)}&state=s` +
        `&scope=${encodeURIComponent("mail:read")}` +
        `&code_challenge=${challenge}&code_challenge_method=S256`
    );
    const cookie = cookieFrom(page);
    const csrf = csrfFrom(await page.text());

    const early = await SELF.fetch(`${ORIGIN}/authorize/approve`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams([
        ["csrf", csrf],
        ["decision", "allow"],
        ["inbox_id", "scout@wzrd.tech"],
        ["scopes", "mail:read"]
      ])
    });
    expect(early.status).toBe(200);
    expect(await early.text()).toContain("Finish signing in");
  });
});
