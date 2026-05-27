import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// In production we deploy under https://<user>.github.io/<repo>/, so the
// build must use the repo name as base. Locally (`vite dev`) we want "/".
// Override either with VITE_BASE=/something/ if needed.
const base = process.env.VITE_BASE ?? "/";

export default defineConfig({
  plugins: [react()],
  base,
  worker: { format: "es" },
  server: {
    port: 5173,
    fs: {
      // Allow serving files from the project root (forecasts.zarr lives there)
      allow: [".."],
    },
  },
});
