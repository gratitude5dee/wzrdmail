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
    ),
    // thirdweb project client id (public by design).
    __THIRDWEB_CLIENT_ID__: JSON.stringify("f3a41a11153f2f75d55056f08c1d36d4")
  }
}));
