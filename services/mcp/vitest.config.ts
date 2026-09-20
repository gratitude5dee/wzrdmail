import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  css: { postcss: { plugins: [] } },
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          // Matches the deployed environments: without it the OAuth provider
          // warns at module scope, which workerd forbids during collection.
          compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
          kvNamespaces: ["OAUTH_KV"],
          bindings: {
            CONNECT_SECRET: "test-connect-secret",
            MCP_PUBLIC_ORIGIN: "http://localhost:8788"
          }
        }
      }
    }
  }
});
