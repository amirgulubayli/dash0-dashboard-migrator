import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Dev only: proxies /api to the read-only server (npm run serve). Production is served by server/main.ts.
export default defineConfig({
  plugins: [react()],
  server: { host: "127.0.0.1", proxy: { "/api": "http://127.0.0.1:4173" } },
  build: { outDir: "dist", emptyOutDir: true },
});
