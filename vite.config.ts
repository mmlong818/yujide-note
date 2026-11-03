import { defineConfig } from "vite";
import { fileURLToPath, URL } from "node:url";

// Tauri expects a fixed dev port; fail instead of drifting to a random one.
export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: "127.0.0.1",
  },
  envPrefix: ["VITE_", "TAURI_"],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  build: {
    outDir: "dist",
    target: "chrome105",
    minify: "esbuild",
    sourcemap: false,
  },
});
