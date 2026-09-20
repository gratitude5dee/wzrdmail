/**
 * Connector smoke test (muse.md §9 MU6).
 *
 * Checks a *deployed* MCP server the way a hosted consumer agent will actually
 * meet it: JSON-only Accept, no session id, and the OAuth discovery documents
 * a connector directory's reviewer will fetch. Run it against staging before
 * production, and against production before submitting the listing.
 *
 *   npx tsx scripts/muse-smoke.ts https://staging.mcp.mail.wzrd.tech [wm_live_…]
 *
 * The API key is optional: without one the credential checks still run, and
 * the tool checks are skipped rather than reported as passing.
 *
 * The tool checks call through to the wzrdmail API, so against a local
 * `wrangler dev` they fail unless services/api is running too. Against staging
 * or production that failure is real and blocks the listing.
 */

interface Check {
  name: string;
  ok: boolean;
  detail: string;
  fatal: boolean;
}

const checks: Check[] = [];

const record = (name: string, ok: boolean, detail: string, fatal = true): void => {
  checks.push({ name, ok, detail, fatal });
  const mark = ok ? "ok  " : fatal ? "FAIL" : "warn";
  console.log(`${mark}  ${name}${detail === "" ? "" : `  — ${detail}`}`);
};

const rpc = (id: number, method: string, params: unknown = {}): string =>
  JSON.stringify({ jsonrpc: "2.0", id, method, params });

const INITIALIZE = {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "muse-smoke", version: "1" }
};

async function main(): Promise<void> {
  const base = process.argv[2]?.replace(/\/+$/, "");
  const apiKey = process.argv[3];
  if (base === undefined || !base.startsWith("http")) {
    console.error("usage: npx tsx scripts/muse-smoke.ts <origin> [wm_live_key]");
    process.exit(2);
  }
  const mcp = `${base}/mcp`;
  console.log(`\nProbing ${mcp}\n`);

  // 1. Health, so a total outage is not reported as a protocol failure.
  try {
    const res = await fetch(`${base}/health`);
    record("health", res.ok, `HTTP ${String(res.status)}`);
  } catch (error) {
    record("health", false, String(error));
  }

  // 2. The 401 a client uses to discover where to authorize. The challenge
  //    carries the scope list, because a client that registers without one
  //    reads it back from here.
  let resourceMetadataUrl = `${base}/.well-known/oauth-protected-resource/mcp`;
  try {
    const res = await fetch(mcp, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: rpc(1, "initialize", INITIALIZE)
    });
    const challenge = res.headers.get("www-authenticate") ?? "";
    record("401 on a credential-less call", res.status === 401, `HTTP ${String(res.status)}`);
    record(
      "challenge names the resource metadata",
      challenge.includes("resource_metadata="),
      challenge === "" ? "no WWW-Authenticate header" : challenge
    );
    record("challenge advertises scopes", challenge.includes("scope="), "", false);
    const found = /resource_metadata="([^"]+)"/.exec(challenge);
    if (found?.[1] !== undefined) resourceMetadataUrl = found[1];
  } catch (error) {
    record("401 on a credential-less call", false, String(error));
  }

  // 3. RFC 9728 protected-resource metadata.
  try {
    const res = await fetch(resourceMetadataUrl);
    const body = (await res.json()) as {
      resource?: string;
      authorization_servers?: string[];
      scopes_supported?: string[];
    };
    record("protected-resource metadata", res.ok, `HTTP ${String(res.status)}`);
    record(
      "metadata resource matches this server",
      body.resource === mcp,
      `resource=${String(body.resource)}`
    );
    record(
      "metadata names an authorization server",
      (body.authorization_servers ?? []).length > 0,
      (body.authorization_servers ?? []).join(", ")
    );
    record("metadata lists scopes", (body.scopes_supported ?? []).length > 0, (body.scopes_supported ?? []).join(" "), false);
  } catch (error) {
    record("protected-resource metadata", false, String(error));
  }

  // 4. Authorization-server metadata: PKCE and registration are what a
  //    directory's client needs to connect without a pre-shared client id.
  try {
    const res = await fetch(`${base}/.well-known/oauth-authorization-server`);
    const body = (await res.json()) as {
      code_challenge_methods_supported?: string[];
      registration_endpoint?: string;
      authorization_endpoint?: string;
      token_endpoint?: string;
    };
    record("authorization-server metadata", res.ok, `HTTP ${String(res.status)}`);
    record(
      "advertises PKCE S256",
      (body.code_challenge_methods_supported ?? []).includes("S256"),
      (body.code_challenge_methods_supported ?? []).join(" ")
    );
    record(
      "advertises dynamic registration",
      typeof body.registration_endpoint === "string",
      String(body.registration_endpoint)
    );
    record(
      "advertises authorize and token endpoints",
      typeof body.authorization_endpoint === "string" && typeof body.token_endpoint === "string",
      `${String(body.authorization_endpoint)} · ${String(body.token_endpoint)}`
    );
  } catch (error) {
    record("authorization-server metadata", false, String(error));
  }

  // 5. The sign-in page has to render for a human, or nobody can connect.
  try {
    const res = await fetch(`${base}/authorize`, { redirect: "manual" });
    // Without client_id the provider rejects the request; either a rendered
    // page or a clean 4xx proves the route is wired and not a 404.
    record(
      "authorize route is wired",
      res.status !== 404,
      `HTTP ${String(res.status)}`
    );
  } catch (error) {
    record("authorize route is wired", false, String(error));
  }

  if (apiKey === undefined) {
    console.log("\n(no API key given — skipping the tool checks)");
    return summarize();
  }

  // 6. The transport shape that matters: JSON in, JSON out, no session id.
  //    This is the exact request a hosted agent makes, and the one the old
  //    Durable Object lane answered with a 406.
  let sessionless = false;
  try {
    const res = await fetch(mcp, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "x-api-key": apiKey,
        "mcp-protocol-version": "2025-06-18"
      },
      body: rpc(2, "initialize", INITIALIZE)
    });
    const type = res.headers.get("content-type") ?? "";
    record("JSON-only initialize", res.ok && type.includes("application/json"), `HTTP ${String(res.status)} ${type}`);
    record(
      "no session id is issued",
      res.headers.get("mcp-session-id") === null,
      res.headers.get("mcp-session-id") ?? "none"
    );
    sessionless = res.ok;
    const body = (await res.json()) as { result?: { protocolVersion?: string } };
    record(
      "protocol version is echoed",
      body.result?.protocolVersion === "2025-06-18",
      String(body.result?.protocolVersion)
    );
  } catch (error) {
    record("JSON-only initialize", false, String(error));
  }

  // 7. Tools, with no prior handshake and no session — a stateless client
  //    must be able to start here.
  if (sessionless) {
    try {
      const started = Date.now();
      const res = await fetch(mcp, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          "x-api-key": apiKey
        },
        body: rpc(3, "tools/list")
      });
      const elapsed = Date.now() - started;
      const body = (await res.json()) as {
        result?: { tools?: { name: string; annotations?: Record<string, unknown> }[] };
      };
      const tools = body.result?.tools ?? [];
      const names = tools.map((tool) => tool.name);
      record("tools/list without a session", res.ok && tools.length > 0, `${String(tools.length)} tools in ${String(elapsed)}ms`);
      record("whoami is present", names.includes("whoami"), "");
      record("check_new_mail is present", names.includes("check_new_mail"), "");
      const send = tools.find((tool) => tool.name === "send_message");
      record(
        "send_message is marked destructive",
        send?.annotations?.destructiveHint === true,
        JSON.stringify(send?.annotations ?? {}),
        false
      );
      // A hosted agent's per-request budget is around twenty seconds.
      record("answers well inside a 20s ceiling", elapsed < 10_000, `${String(elapsed)}ms`, false);
    } catch (error) {
      record("tools/list without a session", false, String(error));
    }

    // 8. whoami is the first call a connected agent makes.
    try {
      const res = await fetch(mcp, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          "x-api-key": apiKey
        },
        body: rpc(4, "tools/call", { name: "whoami", arguments: {} })
      });
      const body = (await res.json()) as {
        result?: { isError?: boolean; content?: { text?: string }[] };
      };
      const text = body.result?.content?.[0]?.text ?? "";
      record(
        "whoami answers",
        res.ok && body.result?.isError !== true,
        text.slice(0, 160).replace(/\s+/g, " ")
      );
    } catch (error) {
      record("whoami answers", false, String(error));
    }
  }

  summarize();
}

function summarize(): void {
  const failed = checks.filter((check) => !check.ok && check.fatal);
  const warned = checks.filter((check) => !check.ok && !check.fatal);
  console.log(
    `\n${String(checks.length - failed.length - warned.length)} passed, ` +
      `${String(warned.length)} warned, ${String(failed.length)} failed`
  );
  if (failed.length > 0) {
    console.log("\nNot ready to submit:");
    for (const check of failed) console.log(`  - ${check.name}: ${check.detail}`);
    process.exit(1);
  }
  console.log("\nTransport and discovery look right. The browser sign-in still");
  console.log("needs a human: open /authorize from a real client and connect.");
}

void main();
