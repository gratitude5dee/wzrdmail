import { WzrdmailError } from "wzrdmail";

export interface ApiRequest {
  method: string;
  path: string;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Thin JSON caller for api.wzrd.tech used by MCP tools. Unlike the SDK it is
 * not limited to the SDK's typed surface, so tools can cover the full §7
 * endpoint table (reply/forward/drafts/search/usage/...).
 */
export class ApiClient {
  private readonly apiKey: string | (() => string);
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number | undefined;

  constructor(options: {
    apiKey: string | (() => string);
    baseUrl: string;
    fetchImpl?: FetchLike;
    /**
     * Abort an upstream call after this many ms. The JSON lane sets it so a
     * hung API turns into a tool error well inside a consumer agent's own
     * request ceiling (muse.md §4.4) instead of stalling the whole turn.
     */
    timeoutMs?: number;
  }) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.timeoutMs = options.timeoutMs;
  }

  async request(req: ApiRequest): Promise<unknown> {
    const url = new URL(this.baseUrl + req.path);
    for (const [key, value] of Object.entries(req.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const key = typeof this.apiKey === "function" ? this.apiKey() : this.apiKey;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${key}`
    };
    let body: string | undefined;
    if (req.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(req.body);
    }
    let response: Response;
    try {
      response = await this.fetchImpl(url.toString(), {
        method: req.method,
        headers,
        body,
        signal: this.timeoutMs === undefined ? undefined : AbortSignal.timeout(this.timeoutMs)
      });
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError") {
        throw new WzrdmailError(504, {
          name: "internal_error",
          message: `wzrdmail API did not answer within ${String(this.timeoutMs)}ms`
        });
      }
      throw error;
    }
    const text = await response.text();
    let data: unknown = undefined;
    if (text !== "") {
      try {
        data = JSON.parse(text);
      } catch {
        data = undefined;
      }
    }
    if (!response.ok) {
      if (
        typeof data === "object" &&
        data !== null &&
        "name" in data &&
        "message" in data
      ) {
        const envelope = data as { name: string; message: string };
        throw new WzrdmailError(response.status, envelope);
      }
      throw new WzrdmailError(response.status, {
        name: "internal_error",
        message: `unexpected error response (HTTP ${response.status})`
      });
    }
    return data ?? {};
  }
}

export const encodePath = (segment: string): string => encodeURIComponent(segment);
