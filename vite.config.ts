import { defineConfig } from "vitest/config";
import { svelte } from "@sveltejs/vite-plugin-svelte";

export default defineConfig({
  plugins: [svelte()],
  server: {
    proxy: { "/api": "http://127.0.0.1:8000" },
  },
  test: { include: ["src/**/*.test.ts"] },
});
