import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** `~/.config/wzrdmail/config.json` (goal.md §10), overridable for tests/CI. */
export function configPath(env: Record<string, string | undefined>): string {
  return (
    env["WZRDMAIL_CONFIG_PATH"] ??
    join(homedir(), ".config", "wzrdmail", "config.json")
  );
}

export function readStoredApiKey(path: string): string | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as { api_key?: unknown };
    return typeof parsed.api_key === "string" && parsed.api_key !== ""
      ? parsed.api_key
      : undefined;
  } catch {
    return undefined;
  }
}

export function storeApiKey(path: string, apiKey: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify({ api_key: apiKey }, null, 2)}\n`, {
    mode: 0o600
  });
  chmodSync(path, 0o600);
}

export function clearApiKey(path: string): boolean {
  try {
    rmSync(path);
    return true;
  } catch {
    return false;
  }
}
