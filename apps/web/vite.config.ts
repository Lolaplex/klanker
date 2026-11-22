import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const relay = process.env.VITE_RELAY_URL || "http://localhost:8787";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 1420,
    strictPort: true,
    proxy: {
      "/v1": relay,
      "/health": relay,
    },
  },
});
