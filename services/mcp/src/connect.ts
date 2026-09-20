import type { Env } from "./env.js";

/**
 * Client for the API's secret-gated `/v0/connect/*` endpoints (muse.md §7.1).
 *
 * The consent page runs on this Worker, but every wzrdmail state change it
 * makes — sending a one-time code, creating an organization, minting the key —
 * happens on api.wzrd.tech. These calls are server-to-server and carry a shared
 * secret rather than a session cookie, which is what keeps the API's console
 * CORS allowlist and CSRF guard out of the picture entirely.
 */

export class ConnectError extends Error {
  constructor(
    readonly status: number,
    readonly envelope: { name: string; message: string },
    readonly retryAfter?: string
  ) {
    super(envelope.message);
    this.name = "ConnectError";
  }
}

export interface StartResult {
  registered: boolean;
}

export interface VerifyResult {
  connect_token: string;
  organization_id: string;
  new_user: boolean;
  inboxes: { inbox_id: string; display_name?: string | null }[];
}

export interface CompleteResult {
  api_key: string;
  key_id: string;
  inbox_id: string | null;
  organization_id: string;
  permissions: string[];
}

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};

export class ConnectClient {
  constructor(
    private readonly baseUrl: string,
    private readonly secret: string,
    private readonly clientIp: string | null
  ) {}

  private async post(path: string, body: unknown): Promise<unknown> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "x-connect-secret": this.secret
    };
    // The API cannot see the browser, so the consent page forwards the address
    // it saw for the per-IP throttles on the other side.
    if (this.clientIp !== null) headers["x-wzrdmail-client-ip"] = this.clientIp;
    const response = await fetch(`${this.baseUrl.replace(/\/+$/, "")}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000)
    });
    const text = await response.text();
    let data: unknown;
    try {
      data = text === "" ? {} : JSON.parse(text);
    } catch {
      data = {};
    }
    if (!response.ok) {
      const envelope = asRecord(data);
      throw new ConnectError(
        response.status,
        {
          name: typeof envelope.name === "string" ? envelope.name : "internal_error",
          message:
            typeof envelope.message === "string"
              ? envelope.message
              : `wzrdmail API returned HTTP ${String(response.status)}`
        },
        response.headers.get("retry-after") ?? undefined
      );
    }
    return data;
  }

  async start(email: string): Promise<StartResult> {
    const data = asRecord(await this.post("/v0/connect/start", { email }));
    return { registered: data.registered === true };
  }

  async signup(email: string, username: string): Promise<void> {
    await this.post("/v0/connect/signup", { email, username });
  }

  async verify(email: string, otpCode: string): Promise<VerifyResult> {
    const data = asRecord(await this.post("/v0/connect/verify", { email, otp_code: otpCode }));
    const inboxes = Array.isArray(data.inboxes) ? data.inboxes : [];
    return {
      connect_token: String(data.connect_token ?? ""),
      organization_id: String(data.organization_id ?? ""),
      new_user: data.new_user === true,
      inboxes: inboxes.map((entry) => {
        const row = asRecord(entry);
        return {
          inbox_id: String(row.inbox_id ?? ""),
          display_name: typeof row.display_name === "string" ? row.display_name : null
        };
      })
    };
  }

  async complete(input: {
    connectToken: string;
    inboxId: string | null;
    permissions: string[];
    name: string;
    clientId: string;
  }): Promise<CompleteResult> {
    const data = asRecord(
      await this.post("/v0/connect/complete", {
        connect_token: input.connectToken,
        inbox_id: input.inboxId,
        permissions: input.permissions,
        name: input.name,
        client_id: input.clientId
      })
    );
    return {
      api_key: String(data.api_key ?? ""),
      key_id: String(data.key_id ?? ""),
      inbox_id: typeof data.inbox_id === "string" ? data.inbox_id : null,
      organization_id: String(data.organization_id ?? ""),
      permissions: Array.isArray(data.permissions) ? data.permissions.map(String) : []
    };
  }
}

/** Builds a client, or null when the OAuth lane has not been provisioned yet. */
export const connectClient = (env: Env, request: Request): ConnectClient | null => {
  if (env.CONNECT_SECRET === undefined || env.CONNECT_SECRET === "") return null;
  return new ConnectClient(
    env.API_BASE_URL,
    env.CONNECT_SECRET,
    request.headers.get("cf-connecting-ip")
  );
};
