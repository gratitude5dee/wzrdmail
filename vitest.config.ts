import { defineConfig } from "vitest/config";

// Keep package-level Vitest runs anchored inside this monorepo. Without a
// repository config, Vite walks into the host home directory and may load an
// unrelated vite.config.ts or PostCSS setup.
export default defineConfig({
  css: { postcss: { plugins: [] } },
});
