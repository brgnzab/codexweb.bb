import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { rendererCsp } from "./electron/renderer-security.cjs";

export default defineConfig({
  plugins: [react(), {
    name: "cwc-renderer-response-policy",
    // React Refresh normally injects inline startup code. Keep script-src 'self'
    // by serving that exact preamble as an external same-origin module instead.
    transformIndexHtml: {
      order: "post",
      handler(html, context) {
        if (!context.server) return html;
        const preamble = react.preambleCode.replace("__BASE__", context.server.config.base).trim();
        return html.replace(/<script type="module">([\s\S]*?)<\/script>/g, (script, code: string) =>
          code.trim() === preamble ? '<script type="module" src="/@cwc/react-refresh-preamble"></script>' : script);
      },
    },
    configureServer(server) {
      const policy = rendererCsp(`http://127.0.0.1:${server.config.server.port}`);
      server.middlewares.use((request, response, next) => {
        response.setHeader("Content-Security-Policy", policy);
        response.setHeader("X-Frame-Options", "DENY");
        if (request.url?.split("?")[0] === "/@cwc/react-refresh-preamble") {
          response.setHeader("Content-Type", "text/javascript");
          response.end(react.preambleCode.replace("__BASE__", server.config.base));
          return;
        }
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
