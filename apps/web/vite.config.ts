import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": {
        target: process.env.QUOTEOPS_API_DEV_TARGET ?? "http://127.0.0.1:8080",
        changeOrigin: true
      }
    }
  }
});
