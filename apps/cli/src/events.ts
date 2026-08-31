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
  /** Close after this many events (mainly for scripts/tests). */
  max?: number;
  onEvent: (line: string) => void;
  webSocket?: WebSocketFactory;
}

/** `GET /v0/ws` — auth via `?api_key=`, subscribe message `{inbox_ids?}` (§7, §8.3). */
export function tailUrl(baseUrl: string | undefined, apiKey: string): string {
  const url = new URL(`${(baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "")}/v0/ws`);
  url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
  url.searchParams.set("api_key", apiKey);
  return url.toString();
}

export function tailEvents(options: TailOptions): Promise<void> {
  const factory = options.webSocket ?? defaultWebSocketFactory;
  const socket = factory(tailUrl(options.baseUrl, options.apiKey));
  let seen = 0;
  return new Promise((resolve, reject) => {
    socket.addEventListener("open", () => {
      if (options.inboxIds !== undefined && options.inboxIds.length > 0) {
        socket.send(JSON.stringify({ inbox_ids: options.inboxIds }));
      }
    });
    socket.addEventListener("message", (event) => {
      options.onEvent(String(event.data));
      seen += 1;
      if (options.max !== undefined && seen >= options.max) {
        socket.close();
      }
    });
    socket.addEventListener("close", () => {
      resolve();
    });
    socket.addEventListener("error", () => {
      reject(new Error("wzrdmail: WebSocket connection failed"));
    });
  });
}
