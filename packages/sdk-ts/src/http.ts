import { parseErrorBody } from "./error.js";

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface HttpClientOptions {
  apiKey?: string;
  baseUrl?: string;
  fetch?: FetchLike;
  /** Max retries on 429 (expo backoff honoring Retry-After). Default 3. */
  maxRetries?: number;
}

export const DEFAULT_BASE_URL = "https://api.wzrd.tech";

export interface RequestOptions {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  query?: Record<string, string | number | string[] | undefined>;
  body?: unknown;
  auth?: boolean;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Parse Retry-After as delay-seconds or HTTP-date; undefined when absent/malformed. */
const parseRetryAfterMs = (header: string | null): number | undefined => {
  if (header === null || header.trim() === "") return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return undefined;
};

export class HttpClient {
  private readonly apiKey?: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly maxRetries: number;

  constructor(options: HttpClientOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.fetchImpl =
      options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.maxRetries = options.maxRetries ?? 3;
  }

  async request<T>(options: RequestOptions): Promise<T> {
    const url = this.buildUrl(options.path, options.query);
    const headers: Record<string, string> = {};
    if (options.auth !== false) {
      if (!this.apiKey) {
        throw new Error(
          "wzrdmail: apiKey is required for this call (set WZRDMAIL_API_KEY or pass { apiKey })"
        );
      }
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }
    const init: RequestInit = { method: options.method, headers };
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(options.body);
    }

    let attempt = 0;
    for (;;) {
      const response = await this.fetchImpl(url, init);
      if (response.status === 429 && attempt < this.maxRetries) {
        const retryAfterMs = parseRetryAfterMs(response.headers.get("Retry-After"));
        await sleep(retryAfterMs ?? 2 ** attempt * 500);
        attempt += 1;
        continue;
      }
      if (!response.ok) {
        let raw: unknown;
        try {
          raw = await response.json();
        } catch {
          raw = undefined;
        }
        throw parseErrorBody(response.status, raw);
      }
      if (response.status === 204) return undefined as T;
      return (await response.json()) as T;
    }
  }

  private buildUrl(
    path: string,
    query?: Record<string, string | number | string[] | undefined>
  ): string {
    const url = new URL(`${this.baseUrl}${path}`);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined) continue;
        url.searchParams.set(
          key,
          Array.isArray(value) ? value.join(",") : String(value)
        );
      }
    }
    return url.toString();
  }
}

export const encodePath = (segment: string): string =>
  encodeURIComponent(segment);
