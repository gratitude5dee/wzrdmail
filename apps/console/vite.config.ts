import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  define: {
    __API_BASE__: JSON.stringify(
      mode === "staging"
        ? "https://staging.api.wzrd.tech/v0"
        : mode === "development"
          ? "http://localhost:8787/v0"
          : "https://api.wzrd.tech/v0"
    )
  }
}));
