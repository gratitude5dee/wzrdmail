import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  defineWorkersConfig,
  readD1Migrations
} from "@cloudflare/vitest-pool-workers/config";

const FIXTURES_DIR = path.join(__dirname, "../../fixtures/emails");

export default defineWorkersConfig(async () => {
  const migrations = await readD1Migrations(path.join(__dirname, "migrations"));
  const fixtures: Record<string, string> = {};
  for (const file of await readdir(FIXTURES_DIR)) {
    if (!file.endsWith(".eml")) continue;
    fixtures[file] = await readFile(path.join(FIXTURES_DIR, file), "utf8");
  }
  return {
    test: {
      setupFiles: ["./test/apply-migrations.ts"],
      poolOptions: {
        workers: {
          wrangler: { configPath: "./wrangler.jsonc" },
          miniflare: {
            bindings: { TEST_MIGRATIONS: migrations, TEST_FIXTURES: fixtures }
          }
        }
      }
    }
  };
});
