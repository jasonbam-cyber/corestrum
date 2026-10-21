import { renameSync } from "node:fs";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [
    react(),
    {
      name: "corestrum-index",
      closeBundle() {
        renameSync(
          "dist-corestrum/corestrum.html",
          "dist-corestrum/index.html",
        );
      },
    },
  ],
  build: {
    outDir: "dist-corestrum",
    rollupOptions: { input: "corestrum.html" },
    sourcemap: false,
  },
});
