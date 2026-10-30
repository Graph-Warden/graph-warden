import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// In development, the app runs on Vite and the API on :8080; both answer on one origin through the
// proxy, as in production, where the API serves the built app (proposal 0012).
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/v1": "http://localhost:8080",
      "/auth": "http://localhost:8080",
    },
  },
});
