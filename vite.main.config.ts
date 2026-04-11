import { defineConfig } from "vite";

// https://www.electronforge.io/config/plugins/vite#native-node-modules
export default defineConfig({
  build: {
    rollupOptions: {
      external: ["electron"],
    },
  },
});
