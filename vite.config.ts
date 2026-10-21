import { defineConfig } from "vite";

/**
 * Dev-mode Service Worker scope fix.
 *
 * A SW's default max scope is its own directory, so registering /src/sw.ts
 * would cap the scope at /src/ and fail for scope "/". The standard remedy is
 * the Service-Worker-Allowed response header; Vite does not send it, so we add
 * it here for the dev/serve path. Production serves /sw.js from the root, which
 * already allows scope "/".
 */
export default defineConfig({
  // Relative asset URLs so the bundle works under any mount point
  // (the page may be served at /__lan/ while the real site owns /).
  base: "./",
  // Dev-only: lets a host-mapped domain (e.g. sense.jshuaxin.net -> 127.0.0.1
  // via --host-resolver-rules) reach the dev server, so host-rule routing can
  // be exercised locally.
  server: { allowedHosts: ["sense.jshuaxin.net"] },
  plugins: [
    {
      name: "sw-scope-allowed",
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url && req.url.split("?")[0] === "/src/sw.ts") {
            res.setHeader("Service-Worker-Allowed", "/");
          }
          next();
        });
      },
      configurePreviewServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url && req.url.startsWith("/sw.js")) {
            res.setHeader("Service-Worker-Allowed", "/");
          }
          next();
        });
      },
    },
  ],
  build: {
    rollupOptions: {
      input: {
        main: "index.html",
        connect: "connect.html",
        holder: "holder.html",
        sw: "src/sw.ts",
      },
      output: {
        entryFileNames: (chunk) =>
          chunk.name === "sw" ? "sw.js" : "assets/[name]-[hash].js",
      },
    },
  },
});