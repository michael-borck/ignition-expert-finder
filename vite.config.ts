import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Follows PORT so the dev proxy and the API cannot drift apart. 3000 is left
// alone deliberately - it is the default for half the Node ecosystem and
// collides with whatever else is running on a developer machine.
const API = `http://localhost:${process.env.PORT ?? 3210}`;

export default defineConfig({
  root: "web",
  plugins: [react()],
  build: { outDir: "../dist/web", emptyOutDir: true },
  server: {
    // Headshots are served by the API from data/, not bundled, so both need
    // proxying in dev.
    proxy: {
      "/api": API,
      "/headshots": API,
    },
  },
});
