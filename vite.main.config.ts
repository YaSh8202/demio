import fs from "node:fs"
import path from "node:path"
import { defineConfig, type Plugin } from "vite"

// Copies pure CommonJS workflow files (verify-pure.cjs, edl-pure.cjs) to the
// build directory. These modules load at runtime via `createRequire()` — kept
// as plain CommonJS so `node --test` can run them with zero build step. The
// `require()` calls are runtime strings (invisible to Rollup's static
// analysis), so they never get inlined; they resolve relative to the bundled
// `__filename` (`.vite/build/main.js`) at runtime instead of the source
// directory. Without this copy step, the siblings are simply absent from
// `.vite/build/`, and the require throws MODULE_NOT_FOUND. Confirmed via a
// standalone vite-build probe against this same rollup config.
function copyPureCjs(): Plugin {
  const files = ["verify-pure.cjs", "edl-pure.cjs"]
  return {
    name: "copy-pure-cjs",
    closeBundle() {
      const outDir = path.resolve(__dirname, ".vite/build")
      fs.mkdirSync(outDir, { recursive: true })
      for (const filename of files) {
        const src = path.resolve(
          __dirname,
          "electron/agent/workflows",
          filename
        )
        if (!fs.existsSync(src)) continue
        fs.copyFileSync(src, path.join(outDir, filename))
      }
    },
  }
}

// https://www.electronforge.io/config/plugins/vite#native-node-modules
export default defineConfig({
  build: {
    commonjsOptions: {
      // `libsql` (Mastra's LibSQLStore backend for mastra.db) resolves its
      // native binary with `require(\`@libsql/${platform}-${arch}\`)` —
      // node_modules/libsql/index.js, requireNative(). That template-literal
      // require is a genuinely dynamic call (not a static string), so
      // Rollup's commonjs plugin can't resolve it at build time and — unlike
      // a plain `external` entry, which only matches statically-known import
      // sources — replaces it with a `commonjsRequire` runtime shim that
      // throws "Could not dynamically require ..." unless told what to do.
      // Confirmed via a real `bun start` boot: the app loaded, then crashed
      // during store init with exactly that error, stack rooted at
      // requireLibsql -> requireNative -> commonjsRequire.
      // `@libsql/darwin-arm64` (etc.) ARE installed — this is purely a
      // build-time bundling gap, not a missing-dependency problem — so
      // `ignoreDynamicRequires: true` is the correct fix: unresolvable
      // dynamic requires fall through to real Node `require` at runtime
      // instead of throwing. Safe here because the main-process bundle is
      // genuine CJS running under Node/Electron, where a real `require` is
      // always available.
      ignoreDynamicRequires: true,
    },
    rollupOptions: {
      // `ws` (transitive via @mastra/core) declares these as optional native
      // deps for performance; it falls back to a pure-JS path when they are
      // missing. Externalize so vite doesn't try to resolve them at build time.
      //
      // `@ast-grep/napi` is a native module used by @mastra/core's
      // workspace AST-edit tool (electron/agent's dependency graph pulls it
      // in transitively). It is NOT installed in node_modules (confirmed:
      // it's listed only in @mastra/core's own devDependencies, not
      // dependencies/optionalDependencies/peerDependencies — end consumers
      // are never expected to install it). At runtime @mastra/core loads it
      // via `await import(/* @vite-ignore */ "@ast-grep/napi")` wrapped in
      // try/catch (see node_modules/@mastra/core/dist/workspace-*.js,
      // loadAstGrep()), falling back to `astGrepModule = null` when it's
      // absent — and isAstGrepAvailable() similarly wraps
      // `createRequire(...).resolve(...)` in try/catch. So the runtime path
      // already tolerates its absence; the only problem is build-time:
      // Rollup still tries to statically resolve the dynamic import target
      // and fails because the package isn't on disk. Since it's a native
      // module anyway (can't be bundled), mark it external so Rollup leaves
      // the `import()`/`require()` call as-is; it will throw at runtime
      // only if actually invoked, which @mastra/core already catches.
      external: ["electron", "bufferutil", "utf-8-validate", "@ast-grep/napi"],
    },
  },
  plugins: [copyPureCjs()],
})
