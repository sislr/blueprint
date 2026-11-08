import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const api = `http://localhost:${process.env.PORT ?? 4317}`;

export default defineConfig({
  root: "web",
  plugins: [react()],
  // The bundle is served from localhost, so its size (mostly the ELK layout engine) doesn't matter.
  build: { outDir: "../dist", emptyOutDir: true, chunkSizeWarningLimit: 4000 },
  server: {
    port: 5317,
    proxy: {
      "/api/": api,
      "/ws": { target: api.replace("http", "ws"), ws: true },
    },
  },
});
