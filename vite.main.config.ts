import { defineConfig } from "vite"

// https://www.electronforge.io/config/plugins/vite#native-node-modules
export default defineConfig({
  build: {
    rollupOptions: {
      // `ws` (transitive via @mastra/core) declares these as optional native
      // deps for performance; it falls back to a pure-JS path when they are
      // missing. Externalize so vite doesn't try to resolve them at build time.
      external: ["electron", "bufferutil", "utf-8-validate"],
    },
  },
})
