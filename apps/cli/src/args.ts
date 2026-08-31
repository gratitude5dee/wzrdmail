/** Minimal `--flag value` / `--flag=value` argv parser (no dependency). */
export interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | boolean>;
}

export class UsageError extends Error {}

export function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    if (eq !== -1) {
      flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    const name = arg.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[name] = next;
      i++;
    } else {
      flags[name] = true;
    }
  }
  return { positionals, flags };
}

export function stringFlag(
  flags: Record<string, string | boolean>,
  name: string
): string | undefined {
  const value = flags[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw new UsageError(`--${name} requires a value`);
  }
  return value;
}

export function requireStringFlag(
  flags: Record<string, string | boolean>,
  name: string
): string {
  const value = stringFlag(flags, name);
  if (value === undefined) throw new UsageError(`--${name} is required`);
  return value;
}

export function listFlag(
  flags: Record<string, string | boolean>,
  name: string
): string[] | undefined {
  const value = stringFlag(flags, name);
  if (value === undefined) return undefined;
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function numberFlag(
  flags: Record<string, string | boolean>,
  name: string
): number | undefined {
  const value = stringFlag(flags, name);
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new UsageError(`--${name} must be a number`);
  return n;
}
