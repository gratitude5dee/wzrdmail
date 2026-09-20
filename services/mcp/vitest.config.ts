import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  css: { postcss: { plugins: [] } },
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
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
