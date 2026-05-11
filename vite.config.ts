import { defineConfig } from "vite";
import packageJson from "./package.json" with { type: "json" };

export default defineConfig({
  build: {
    sourcemap: true,
    // Same chunk-naming pattern Baserate uses; helps the orphan chunk show up
    // with a name that's easy to grep.
    rolldownOptions: {
      output: {
        entryFileNames: () => "[name].zzz[hash].js",
        chunkFileNames: () => "[name].zzz[hash].js",
      },
    },
  },
  resolve: {
    dedupe: Object.keys(packageJson.dependencies ?? {}),
  },
});
