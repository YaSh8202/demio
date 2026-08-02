import fs from "node:fs"
import path from "node:path"
import { defineConfig, type Plugin } from "vite"

// `electron/agent/workflows/verify.ts` loads its pure predicates from
// `verify-pure.cjs` at runtime via `createRequire(import.meta.url)` — kept as
// plain CommonJS so `node --test` can run it with zero build step. That
// `require("./verify-pure.cjs")` call is a runtime string, invisible to
// Rollup's static analysis, so it never gets inlined into the bundle; it
// resolves relative to the *bundled* `__filename` (`.vite/build/main.js`) at
// runtime instead of the source file's directory. Without this copy step the
// sibling `.cjs` is simply absent from `.vite/build/`, and the require throws
// MODULE_NOT_FOUND the moment anything imports verify.ts into the main
// bundle. Confirmed via a standalone vite-build probe against this same
// rollup config (see task-9-report.md).
function copyVerifyPureCjs(): Plugin {
  const filename = "verify-pure.cjs"
  return {
    name: "copy-verify-pure-cjs",
    closeBundle() {
      const src = path.resolve(
        __dirname,
        "electron/agent/workflows",
        filename
      )
      if (!fs.existsSync(src)) return
      const outDir = path.resolve(__dirname, ".vite/build")
      fs.mkdirSync(outDir, { recursive: true })
      fs.copyFileSync(src, path.join(outDir, filename))
    },
  }
}

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
  plugins: [copyVerifyPureCjs()],
})
