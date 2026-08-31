import { DEFAULT_BASE_URL } from "wzrdmail";

/** Minimal WHATWG-WebSocket surface so tests can inject a fake socket. */
export interface WsLike {
  addEventListener(type: string, listener: (event: WsEvent) => void): void;
  send(data: string): void;
  close(): void;
}

export interface WsEvent {
  data?: unknown;
  code?: number;
  reason?: string;
}

export type WebSocketFactory = (url: string) => WsLike;

/** Node 22 ships a global WHATWG WebSocket. */
export const defaultWebSocketFactory: WebSocketFactory = (url) => {
  const ctor = (globalThis as { WebSocket?: new (url: string) => WsLike })
    .WebSocket;
  if (ctor === undefined) {
    throw new Error("wzrdmail: global WebSocket is unavailable (Node >= 22 required)");
  }
  return new ctor(url);
};

export interface TailOptions {
  apiKey: string;
  baseUrl?: string;
  inboxIds?: string[];
  /** Close after this many events (mainly for scripts/tests). Must be >= 1. */
  max?: number;
  onEvent: (line: string) => void;
  webSocket?: WebSocketFactory;
  /** Reconnect attempts after an unexpected close (default 5; counter resets on each event). */
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** `GET /v0/ws` — auth via `?api_key=`, subscribe message `{inbox_ids?, last_event_id?}` (§7, §8.3). */
export function tailUrl(baseUrl: string | undefined, apiKey: string): string {
  const url = new URL(`${(baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "")}/v0/ws`);
  if (url.protocol === "http:") {
    // Plaintext ws:// would expose the api_key and event contents; only allow it locally.
    if (!LOOPBACK_HOSTS.has(url.hostname)) {
      throw new Error(
        `wzrdmail: refusing plaintext ws:// to non-loopback host ${url.hostname}; use an https base URL`
      );
    }
    url.protocol = "ws:";
  } else {
    url.protocol = "wss:";
  }
  url.searchParams.set("api_key", apiKey);
  return url.toString();
}

/** Extract `event_id` from an event envelope line, if present. */
function eventId(line: string): string | undefined {
  try {
    const parsed = JSON.parse(line) as { event_id?: unknown };
    return typeof parsed.event_id === "string" ? parsed.event_id : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Follow the event stream, reconnecting after unexpected disconnects with
 * bounded backoff and backfilling via `last_event_id` (§8.3: the hub replays
 * missed events from the `events` table on reconnect).
 */
export async function tailEvents(options: TailOptions): Promise<void> {
  if (options.max !== undefined && (!Number.isInteger(options.max) || options.max < 1)) {
    throw new Error("wzrdmail: --max must be a positive integer");
  }
  const factory = options.webSocket ?? defaultWebSocketFactory;
  const sleep = options.sleep ?? defaultSleep;
  const maxRetries = options.maxRetries ?? 5;
  const url = tailUrl(options.baseUrl, options.apiKey);

  let seen = 0;
  let lastEventId: string | undefined;
  let retries = 0;

  // Resolves true when the tail is done, false when this socket should be replaced.
  const runSocket = (): Promise<boolean> =>
    new Promise((resolve, reject) => {
      const socket = factory(url);
      let doneClosing = false;
      socket.addEventListener("open", () => {
        const hasFilter = options.inboxIds !== undefined && options.inboxIds.length > 0;
        if (hasFilter || lastEventId !== undefined) {
          socket.send(
            JSON.stringify({
              ...(hasFilter ? { inbox_ids: options.inboxIds } : {}),
              ...(lastEventId !== undefined ? { last_event_id: lastEventId } : {})
            })
          );
        }
      });
      socket.addEventListener("message", (event) => {
        const line = String(event.data);
        options.onEvent(line);
        lastEventId = eventId(line) ?? lastEventId;
        retries = 0;
        seen += 1;
        if (options.max !== undefined && seen >= options.max) {
          doneClosing = true;
          socket.close();
        }
      });
      socket.addEventListener("close", () => {
        if (doneClosing) {
          resolve(true);
          return;
        }
        if (retries >= maxRetries) {
          reject(new Error("wzrdmail: WebSocket disconnected and retries exhausted"));
          return;
        }
        resolve(false);
      });
      socket.addEventListener("error", () => {
        if (doneClosing) return;
        if (retries >= maxRetries) {
          reject(new Error("wzrdmail: WebSocket connection failed"));
          return;
        }
        resolve(false);
      });
    });

  for (;;) {
    const done = await runSocket();
    if (done) return;
    retries += 1;
    await sleep(Math.min(500 * 2 ** (retries - 1), 8000));
  }
}
