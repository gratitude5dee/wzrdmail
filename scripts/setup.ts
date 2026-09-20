/**
 * Idempotent provisioning script (§17), EmailFlare's worker-setup pattern:
 *  1. verify wrangler auth
 *  2. create D1 database, KV namespace, R2 bucket per env (skip if they exist)
 *  3. patch wrangler.jsonc with the real resource ids
 *  4. apply D1 migrations (forward-only)
 *  5. set Worker secrets from scripts/config.toml
 *  6. provision the MCP Worker's OAuth storage and shared secret (muse.md §9.2)
 *  7. print Email Routing / Email Service / DNS state for the zone
 *
 * Safe to re-run; this is also the disaster-recovery script.
 *
 * Usage: npx tsx scripts/setup.ts <dev|staging|prod>
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const ENVS = ["dev", "staging", "prod"] as const;
type EnvName = (typeof ENVS)[number];

const API_DIR = resolve(import.meta.dirname, "../services/api");
const MCP_DIR = resolve(import.meta.dirname, "../services/mcp");
const WRANGLER_CONFIG = resolve(API_DIR, "wrangler.jsonc");
const MCP_WRANGLER_CONFIG = resolve(MCP_DIR, "wrangler.jsonc");
const CONFIG_PATH = resolve(import.meta.dirname, "config.toml");

const WRANGLER_ENV_FLAG: Record<EnvName, string[]> = {
  dev: [],
  staging: ["--env", "staging"],
  prod: ["--env", "production"]
};

function wrangler(args: string[], opts: { json?: boolean; cwd?: string } = {}): string {
  const finalArgs = ["wrangler", ...args];
  console.log(`$ npx ${finalArgs.join(" ")}`);
  return execFileSync("npx", finalArgs, {
    cwd: opts.cwd ?? API_DIR,
    encoding: "utf8",
    stdio: opts.json ? ["ignore", "pipe", "inherit"] : ["ignore", "pipe", "inherit"]
  });
}

function main(): void {
  const envName = process.argv[2] as EnvName | undefined;
  if (!envName || !ENVS.includes(envName)) {
    console.error(`usage: npx tsx scripts/setup.ts <${ENVS.join("|")}>`);
    process.exit(2);
  }

  // 1. auth check
  wrangler(["whoami"]);

  // 2a. D1
  const dbName = `wzrdmail-${envName}`;
  const dbs = JSON.parse(wrangler(["d1", "list", "--json"], { json: true })) as {
    name: string;
    uuid: string;
  }[];
  let db = dbs.find((d) => d.name === dbName);
  if (!db) {
    wrangler(["d1", "create", dbName]);
    const after = JSON.parse(
      wrangler(["d1", "list", "--json"], { json: true })
    ) as { name: string; uuid: string }[];
    db = after.find((d) => d.name === dbName);
  }
  if (!db) throw new Error(`failed to create D1 database ${dbName}`);
  console.log(`D1 ${dbName}: ${db.uuid}`);

  // 2b. KV
  const kvTitle = `wzrdmail-cache-${envName}`;
  const kvs = JSON.parse(
    wrangler(["kv", "namespace", "list"], { json: true })
  ) as { id: string; title: string }[];
  let kv = kvs.find((n) => n.title.endsWith(kvTitle));
  if (!kv) {
    wrangler(["kv", "namespace", "create", kvTitle]);
    const after = JSON.parse(
      wrangler(["kv", "namespace", "list"], { json: true })
    ) as { id: string; title: string }[];
    kv = after.find((n) => n.title.endsWith(kvTitle));
  }
  if (!kv) throw new Error(`failed to create KV namespace ${kvTitle}`);
  console.log(`KV ${kvTitle}: ${kv.id}`);

  // 2c. R2
  const bucketName = `wzrdmail-mail-${envName}`;
  const bucketNames = [...wrangler(["r2", "bucket", "list"]).matchAll(/^name:\s+(\S+)\s*$/gm)].map(
    (m) => m[1]
  );
  if (bucketNames.includes(bucketName)) {
    console.log(`R2 bucket ${bucketName} already exists — ok`);
  } else {
    wrangler(["r2", "bucket", "create", bucketName]);
  }

  // 3. patch wrangler.jsonc ids for this env
  patchWranglerConfig(envName, db.uuid, kv.id);

  // 4. migrations
  wrangler([
    "d1",
    "migrations",
    "apply",
    dbName,
    envName === "dev" ? "--local" : "--remote",
    ...WRANGLER_ENV_FLAG[envName]
  ]);

  // 5. secrets
  if (envName !== "dev") setSecrets(envName);
  else console.log("dev env: put secrets in services/api/.dev.vars");

  // 6. the MCP Worker: OAuth storage plus the secret it shares with the API
  setupMcp(envName);

  console.log(
    `\nDone. Next (manual, dashboard/API): enable Email Routing + Email Service on the zone, install catch-all → wzrdmail-api, verify SPF/DKIM/DMARC. See docs/runbooks/.`
  );
}


/**
 * Provisions the MCP Worker (muse.md §9.2).
 *
 * It needs two things the API does not: a KV namespace for the OAuth
 * authorization server's state, and `CONNECT_SECRET` — the same value on both
 * Workers, because it is what the consent page presents to the API's
 * /v0/connect/* routes. Until all of it exists the OAuth lane stays dark and
 * the Worker serves API-key clients exactly as before, so running this after
 * a deploy is safe.
 */
function setupMcp(envName: EnvName): void {
  console.log("\n--- MCP Worker (OAuth) ---");

  const kvTitle = `wzrdmail-oauth-${envName}`;
  const kvs = JSON.parse(
    wrangler(["kv", "namespace", "list"], { json: true, cwd: MCP_DIR })
  ) as { id: string; title: string }[];
  let kv = kvs.find((n) => n.title.endsWith(kvTitle));
  if (!kv) {
    wrangler(["kv", "namespace", "create", kvTitle], { cwd: MCP_DIR });
    const after = JSON.parse(
      wrangler(["kv", "namespace", "list"], { json: true, cwd: MCP_DIR })
    ) as { id: string; title: string }[];
    kv = after.find((n) => n.title.endsWith(kvTitle));
  }
  if (!kv) throw new Error(`failed to create KV namespace ${kvTitle}`);
  console.log(`KV ${kvTitle}: ${kv.id}`);

  patchKvPlaceholder(MCP_WRANGLER_CONFIG, envName, kv.id);

  if (envName === "dev") {
    console.log("dev env: put CONNECT_SECRET in services/api/.dev.vars and services/mcp/.dev.vars");
    return;
  }

  const secret = readConfig()?.connect?.secret;
  if (!secret) {
    console.warn(
      "no [connect] secret in scripts/config.toml — OAuth stays dark until it is set.\n" +
        "  Generate one with: openssl rand -hex 32"
    );
    return;
  }
  // The same value on both Workers, or the consent page cannot reach the API.
  for (const [label, cwd] of [
    ["api", API_DIR],
    ["mcp", MCP_DIR]
  ] as const) {
    console.log(`setting secret CONNECT_SECRET on ${label}`);
    execFileSync(
      "npx",
      ["wrangler", "secret", "put", "CONNECT_SECRET", ...WRANGLER_ENV_FLAG[envName]],
      { cwd, input: secret, stdio: ["pipe", "inherit", "inherit"] }
    );
  }
}

/**
 * Replaces the KV id placeholder inside one env block. Both configs carry a
 * `WZRDMAIL_ENV` var per block, which is what makes the block findable.
 *
 * The search stops at the next block's `WZRDMAIL_ENV`. Without that bound a
 * second run — and this script is advertised as idempotent and as the
 * disaster-recovery path — would step over the env it already filled in and
 * write this env's namespace id into the *following* block, quietly pointing
 * production's OAuth store at staging.
 */
function patchKvPlaceholder(configPath: string, envName: EnvName, kvId: string): void {
  const raw = readFileSync(configPath, "utf8");
  const anchor = raw.indexOf(`"WZRDMAIL_ENV": "${envName}"`);
  if (anchor === -1) {
    console.warn(`no WZRDMAIL_ENV anchor for ${envName} in ${configPath}; set the KV id by hand`);
    return;
  }
  const blockEnd = raw.indexOf('"WZRDMAIL_ENV":', anchor + 1);
  const placeholder = '"id": "placeholder-set-by-setup-script"';
  const idx = raw.indexOf(placeholder, anchor);
  if (idx === -1 || (blockEnd !== -1 && idx > blockEnd)) {
    console.log(`${configPath} already has a KV id for ${envName} — ok`);
    return;
  }
  writeFileSync(
    configPath,
    raw.slice(0, idx) + `"id": "${kvId}"` + raw.slice(idx + placeholder.length)
  );
  console.log(`patched ${configPath} for ${envName}`);
}

function readConfig(): SetupConfig | null {
  if (!existsSync(CONFIG_PATH)) return null;
  return parseToml(readFileSync(CONFIG_PATH, "utf8"));
}

function patchWranglerConfig(envName: EnvName, dbId: string, kvId: string): void {
  const raw = readFileSync(WRANGLER_CONFIG, "utf8");
  // Scope replacement to the env block by database_name / bucket naming convention.
  const dbNeedle = new RegExp(
    `("database_name":\\s*"wzrdmail-${envName}",\\s*"database_id":\\s*")[^"]*(")`
  );
  const next = raw.replace(dbNeedle, `$1${dbId}$2`);
  if (next !== raw) {
    writeFileSync(WRANGLER_CONFIG, next);
    console.log(`patched ${WRANGLER_CONFIG} for ${envName}`);
  }
  // The KV id goes in through the same block-bounded helper the MCP config
  // uses, so neither config can have one env's namespace leak into another.
  patchKvPlaceholder(WRANGLER_CONFIG, envName, kvId);
}

interface SetupConfig {
  secrets?: Record<string, string>;
  stripe?: Record<string, string>;
  connect?: Record<string, string>;
}

function setSecrets(envName: EnvName): void {
  if (!existsSync(CONFIG_PATH)) {
    console.warn(`no ${CONFIG_PATH}; skipping secret upload`);
    return;
  }
  const config = parseToml(readFileSync(CONFIG_PATH, "utf8"));
  const pairs: Record<string, string | undefined> = {
    SESSION_SECRET: config.secrets?.session_secret,
    OTP_PEPPER: config.secrets?.otp_pepper,
    API_KEY_PEPPER: config.secrets?.api_key_pepper,
    STRIPE_SECRET_KEY: config.stripe?.secret_key,
    STRIPE_WEBHOOK_SECRET: config.stripe?.webhook_secret
  };
  for (const [name, value] of Object.entries(pairs)) {
    if (!value) continue;
    console.log(`setting secret ${name}`);
    execFileSync(
      "npx",
      ["wrangler", "secret", "put", name, ...WRANGLER_ENV_FLAG[envName]],
      { cwd: API_DIR, input: value, stdio: ["pipe", "inherit", "inherit"] }
    );
  }
}

/** Minimal TOML subset parser: [section] + key = "value" lines. */
function parseToml(raw: string): SetupConfig {
  const result: Record<string, Record<string, string>> = {};
  let section = "";
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const sectionMatch = trimmed.match(/^\[(.+)\]$/);
    if (sectionMatch) {
      section = sectionMatch[1]!;
      result[section] ??= {};
      continue;
    }
    const kv = trimmed.match(/^([A-Za-z0-9_]+)\s*=\s*"(.*)"\s*$/);
    if (kv && section) result[section]![kv[1]!] = kv[2]!;
  }
  return result as SetupConfig;
}

main();
