import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri expects a fixed port and does not want Vite to clear its output.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1520,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  // The Firmware tab's chunk holds the code editor (~550 KB); it's loaded from disk, not the web.
  build: { target: "es2021", sourcemap: false, chunkSizeWarningLimit: 700 },
});
