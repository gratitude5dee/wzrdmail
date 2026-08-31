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
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;

  constructor(options: { apiKey: string; baseUrl: string; fetchImpl?: FetchLike }) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  async request(req: ApiRequest): Promise<unknown> {
    const url = new URL(this.baseUrl + req.path);
    for (const [key, value] of Object.entries(req.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`
    };
    let body: string | undefined;
    if (req.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(req.body);
    }
    const response = await this.fetchImpl(url.toString(), {
      method: req.method,
      headers,
      body
    });
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
