import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  base: "/relay/",
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      "/v1": "http://127.0.0.1:8090",
      "/api": "http://127.0.0.1:8090",
      "/mcp": "http://127.0.0.1:8090",
    },
  },
});
