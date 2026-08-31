import { defineConfig } from "tsup";

export default defineConfig({
  entry: { bin: "src/bin.ts" },
  format: ["esm"],
  target: "node22",
  platform: "node",
  clean: true,
  // Single-file build (goal.md §10): bundle workspace packages and zod.
  noExternal: ["wzrdmail", "@wzrdmail/core", "zod"],
  banner: { js: "#!/usr/bin/env node" }
});
