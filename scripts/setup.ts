/**
 * Idempotent provisioning script (§17), EmailFlare's worker-setup pattern:
 *  1. verify wrangler auth
 *  2. create D1 database, KV namespace, R2 bucket per env (skip if they exist)
 *  3. patch wrangler.jsonc with the real resource ids
 *  4. apply D1 migrations (forward-only)
 *  5. set Worker secrets from scripts/config.toml
 *  6. print Email Routing / Email Service / DNS state for the zone
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
const WRANGLER_CONFIG = resolve(API_DIR, "wrangler.jsonc");
const CONFIG_PATH = resolve(import.meta.dirname, "config.toml");

const WRANGLER_ENV_FLAG: Record<EnvName, string[]> = {
  dev: [],
  staging: ["--env", "staging"],
  prod: ["--env", "production"]
};

function wrangler(args: string[], opts: { json?: boolean } = {}): string {
  const finalArgs = ["wrangler", ...args];
  console.log(`$ npx ${finalArgs.join(" ")}`);
  return execFileSync("npx", finalArgs, {
    cwd: API_DIR,
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
  const bucketList = wrangler(["r2", "bucket", "list"]);
  if (bucketList.includes(bucketName)) {
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

  console.log(
    `\nDone. Next (manual, dashboard/API): enable Email Routing + Email Service on the zone, install catch-all → wzrdmail-api, verify SPF/DKIM/DMARC. See docs/runbooks/.`
  );
}

function patchWranglerConfig(envName: EnvName, dbId: string, kvId: string): void {
  const raw = readFileSync(WRANGLER_CONFIG, "utf8");
  // Scope replacement to the env block by database_name / bucket naming convention.
  const dbNeedle = new RegExp(
    `("database_name":\\s*"wzrdmail-${envName}",\\s*"database_id":\\s*")[^"]*(")`
  );
  let next = raw.replace(dbNeedle, `$1${dbId}$2`);
  // KV: replace the placeholder nearest this env's block; envs share the
  // "placeholder-set-by-setup-script" sentinel until first setup.
  const envAnchor =
    envName === "dev"
      ? next.indexOf('"WZRDMAIL_ENV": "dev"')
      : next.indexOf(`"WZRDMAIL_ENV": "${envName === "prod" ? "prod" : "staging"}"`);
  const kvIdx = next.indexOf('"id": "placeholder-set-by-setup-script"', envAnchor);
  if (kvIdx !== -1) {
    next =
      next.slice(0, kvIdx) +
      `"id": "${kvId}"` +
      next.slice(kvIdx + '"id": "placeholder-set-by-setup-script"'.length);
  }
  if (next !== raw) {
    writeFileSync(WRANGLER_CONFIG, next);
    console.log(`patched ${WRANGLER_CONFIG} for ${envName}`);
  }
}

interface SetupConfig {
  secrets?: Record<string, string>;
  stripe?: Record<string, string>;
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
