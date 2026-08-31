import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { FetchLike } from "wzrdmail";
import type { WsEvent, WsLike } from "../src/events.js";
import { tailUrl } from "../src/events.js";
import { EXIT_AUTH, EXIT_ERROR, EXIT_OK, run } from "../src/run.js";

function io(env: Record<string, string | undefined>, fetch?: FetchLike) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      env,
      stdout: (line: string) => stdout.push(line),
      stderr: (line: string) => stderr.push(line),
      fetch
    }
  };
}

const jsonFetch =
  (capture: { url?: URL; auth?: string }, body: unknown): FetchLike =>
  (input, init) => {
    capture.url = new URL(input);
    capture.auth = ((init.headers ?? {}) as Record<string, string>)["Authorization"];
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
  };

const tmpConfig = (): string =>
  join(mkdtempSync(join(tmpdir(), "wzrdmail-cli-")), "config.json");

describe("auth login/whoami/logout", () => {
  it("stores the key chmod 600, then resolves it for later calls", async () => {
    const path = tmpConfig();
    const env = { WZRDMAIL_CONFIG_PATH: path };
    const a = io(env);
    expect(await run(["auth", "login", "--api-key", "wm_stored"], a.io)).toBe(EXIT_OK);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ api_key: "wm_stored" });
    expect(statSync(path).mode & 0o777).toBe(0o600);

    const capture: { url?: URL; auth?: string } = {};
    const b = io(env, jsonFetch(capture, { organization_id: "org_1" }));
    expect(await run(["auth", "whoami"], b.io)).toBe(EXIT_OK);
    expect(capture.url?.pathname).toBe("/v0/auth/me");
    expect(capture.auth).toBe("Bearer wm_stored");
  });

  it("login without a key is a usage error", async () => {
    const a = io({ WZRDMAIL_CONFIG_PATH: tmpConfig() });
    expect(await run(["auth", "login"], a.io)).toBe(EXIT_ERROR);
    expect(a.stderr.join("\n")).toContain("--api-key");
  });

  it("logout removes the stored key so auth is required again", async () => {
    const path = tmpConfig();
    const env = { WZRDMAIL_CONFIG_PATH: path };
    await run(["auth", "login", "--api-key", "wm_stored"], io(env).io);
    const a = io(env);
    expect(await run(["auth", "logout"], a.io)).toBe(EXIT_OK);
    const b = io(env);
    expect(await run(["inboxes", "list"], b.io)).toBe(EXIT_AUTH);
  });

  it("`login` works as an alias for `auth login`", async () => {
    const path = tmpConfig();
    const a = io({ WZRDMAIL_CONFIG_PATH: path });
    expect(await run(["login", "--api-key", "wm_alias"], a.io)).toBe(EXIT_OK);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ api_key: "wm_alias" });
  });

  it("env always beats --api-key, flag beats stored config (§10)", async () => {
    const path = tmpConfig();
    const env = { WZRDMAIL_CONFIG_PATH: path, WZRDMAIL_API_KEY: "wm_env" };
    await run(["auth", "login", "--api-key", "wm_stored"], io({ WZRDMAIL_CONFIG_PATH: path }).io);

    const c1: { url?: URL; auth?: string } = {};
    await run(
      ["inboxes", "list", "--api-key", "wm_flag"],
      io(env, jsonFetch(c1, { inboxes: [] })).io
    );
    expect(c1.auth).toBe("Bearer wm_env");

    const c2: { url?: URL; auth?: string } = {};
    await run(
      ["inboxes", "list", "--api-key", "wm_flag"],
      io({ WZRDMAIL_CONFIG_PATH: path }, jsonFetch(c2, { inboxes: [] })).io
    );
    expect(c2.auth).toBe("Bearer wm_flag");

    const c3: { url?: URL; auth?: string } = {};
    await run(
      ["inboxes", "list"],
      io({ WZRDMAIL_CONFIG_PATH: path }, jsonFetch(c3, { inboxes: [] })).io
    );
    expect(c3.auth).toBe("Bearer wm_stored");
  });
});

describe("events tail", () => {
  class FakeSocket implements WsLike {
    listeners = new Map<string, ((event: WsEvent) => void)[]>();
    sent: string[] = [];
    closed = false;

    addEventListener(type: string, listener: (event: WsEvent) => void): void {
      const existing = this.listeners.get(type) ?? [];
      this.listeners.set(type, [...existing, listener]);
    }

    send(data: string): void {
      this.sent.push(data);
    }

    close(): void {
      this.closed = true;
      this.emit("close", {});
    }

    emit(type: string, event: WsEvent): void {
      for (const listener of this.listeners.get(type) ?? []) listener(event);
    }
  }

  it("builds a ws URL with the api key and honors loopback http base URLs", () => {
    expect(tailUrl(undefined, "wm_1")).toBe("wss://api.wzrd.tech/v0/ws?api_key=wm_1");
    expect(tailUrl("http://localhost:8787", "wm_1")).toBe(
      "ws://localhost:8787/v0/ws?api_key=wm_1"
    );
    expect(tailUrl("http://127.0.0.1:8787", "wm_1")).toBe(
      "ws://127.0.0.1:8787/v0/ws?api_key=wm_1"
    );
  });

  it("refuses plaintext ws:// to non-loopback hosts", () => {
    expect(() => tailUrl("http://api.example.com", "wm_1")).toThrow(/plaintext/);
  });

  it("rejects --max values below 1 as usage errors without connecting", async () => {
    for (const max of ["0", "-3", "1.5"]) {
      const a = io({ WZRDMAIL_API_KEY: "wm_live_test" });
      const code = await run(["events", "tail", "--max", max], {
        ...a.io,
        webSocket: () => {
          throw new Error("should not connect");
        }
      });
      expect(code).toBe(EXIT_ERROR);
      expect(a.stderr.join("\n")).toContain("--max");
    }
  });

  it("reconnects after an unexpected close and backfills with last_event_id", async () => {
    const sockets: FakeSocket[] = [];
    const a = io({ WZRDMAIL_API_KEY: "wm_live_test" });
    const promise = run(
      ["events", "tail", "--inbox-ids", "a@wzrd.tech", "--max", "2"],
      {
        ...a.io,
        webSocket: () => {
          const socket = new FakeSocket();
          sockets.push(socket);
          return socket;
        },
        sleep: () => Promise.resolve()
      }
    );
    await Promise.resolve();
    sockets[0]?.emit("open", {});
    sockets[0]?.emit("message", { data: '{"event_id":"evt_1","type":"message.received"}' });
    sockets[0]?.emit("close", {});
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(sockets).toHaveLength(2);
    sockets[1]?.emit("open", {});
    expect(sockets[1]?.sent).toEqual([
      JSON.stringify({ inbox_ids: ["a@wzrd.tech"], last_event_id: "evt_1" })
    ]);
    sockets[1]?.emit("message", { data: '{"event_id":"evt_2","type":"message.sent"}' });
    expect(await promise).toBe(EXIT_OK);
    expect(a.stdout).toEqual([
      '{"event_id":"evt_1","type":"message.received"}',
      '{"event_id":"evt_2","type":"message.sent"}'
    ]);
  });

  it("gives up after maxRetries consecutive failed connections", async () => {
    const sockets: FakeSocket[] = [];
    const a = io({ WZRDMAIL_API_KEY: "wm_live_test" });
    const promise = run(["events", "tail"], {
      ...a.io,
      webSocket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        queueMicrotask(() => {
          socket.emit("close", {});
        });
        return socket;
      },
      sleep: () => Promise.resolve()
    });
    expect(await promise).toBe(EXIT_ERROR);
    expect(sockets.length).toBe(6);
    expect(a.stderr.join("\n")).toContain("retries exhausted");
  });

  it("subscribes with inbox filters and prints events until --max", async () => {
    let socket: FakeSocket | undefined;
    let url = "";
    const a = io({ WZRDMAIL_API_KEY: "wm_live_test" });
    const promise = run(
      ["events", "tail", "--inbox-ids", "a@wzrd.tech,b@wzrd.tech", "--max", "2"],
      {
        ...a.io,
        webSocket: (u: string) => {
          url = u;
          socket = new FakeSocket();
          return socket;
        }
      }
    );
    await Promise.resolve();
    expect(url).toBe("wss://api.wzrd.tech/v0/ws?api_key=wm_live_test");
    socket?.emit("open", {});
    expect(socket?.sent).toEqual([
      JSON.stringify({ inbox_ids: ["a@wzrd.tech", "b@wzrd.tech"] })
    ]);
    socket?.emit("message", { data: '{"type":"message.received"}' });
    socket?.emit("message", { data: '{"type":"message.sent"}' });
    expect(await promise).toBe(EXIT_OK);
    expect(socket?.closed).toBe(true);
    expect(a.stdout).toEqual(['{"type":"message.received"}', '{"type":"message.sent"}']);
  });

  it("requires an api key", async () => {
    const a = io({});
    const code = await run(["events", "tail"], {
      ...a.io,
      webSocket: () => {
        throw new Error("should not connect");
      }
    });
    expect(code).toBe(EXIT_AUTH);
  });
});
