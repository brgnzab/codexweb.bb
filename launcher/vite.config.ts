import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { rendererCsp } from "./electron/renderer-security.cjs";

export default defineConfig({
  plugins: [react(), {
    name: "cwc-renderer-response-policy",
    configureServer(server) {
      const policy = rendererCsp(`http://127.0.0.1:${server.config.server.port}`);
      server.middlewares.use((_request, response, next) => {
        response.setHeader("Content-Security-Policy", policy);
        response.setHeader("X-Frame-Options", "DENY");
        next();
      });
    },
  }],
  root: ".",
  base: "./",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "chrome138",
    sourcemap: false,
  },
  server: {
    host: "127.0.0.1",
    port: 4178,
    strictPort: true,
    watch: {
      ignored: ["**/build/**", "**/release/**"],
    },
  },
});
