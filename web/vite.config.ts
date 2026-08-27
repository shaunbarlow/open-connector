import tailwindcss from "@tailwindcss/vite";
import { presetIcons } from "@unocss/preset-icons";
import UnoCSS from "@unocss/vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import { providerIconsPlugin } from "./provider-icons-plugin";

export default defineConfig({
  // Relative base so the built index.html references assets as
  // "./assets/..." instead of "/assets/...". This lets the exact same
  // build work both standalone at the origin root AND reverse-proxied
  // under an arbitrary subpath (e.g. Claworc mounts it at "/connector/*"
  // and injects a matching <base href="/connector/"> tag into the HTML).
  // Absolute "/assets/..." paths would resolve against the *proxy host's*
  // root regardless of any <base> tag, which is exactly the bug this fixes.
  base: "./",
  plugins: [
    react(),
    tailwindcss(),
    UnoCSS({
      presets: [presetIcons()],
    }),
    providerIconsPlugin(),
  ],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:3000",
      "/docs": "http://localhost:3000",
      "/mcp": "http://localhost:3000",
      "/openapi.json": "http://localhost:3000",
      "/v1": "http://localhost:3000",
    },
  },
  build: {
    outDir: "../dist/web",
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("/node_modules/recharts/")) {
            return "charts";
          }
        },
      },
    },
  },
});
