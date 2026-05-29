# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Companion docs

- `AGENTS.md` — build commands, IPC architecture, folder layout, gotchas. Read first.
- `demio.md` — product vision and user journey (what Demio actually does).
- `electron/CLAUDE.md`, `electron/handlers/CLAUDE.md`, `electron/store/CLAUDE.md`, `electron/agent/CLAUDE.md` — auto-generated activity indexes from `claude-mem` (gitignored). Useful for recent-change context.

## Commands

Package manager is **bun**, never npm/npx (including for shadcn).

```bash
bun start          # Electron dev (Forge + Vite HMR) — use for IPC/main-process testing
bun run dev        # Vite renderer only — no Electron shell
bun run typecheck  # tsc --noEmit across both tsconfig.app + tsconfig.node
bun run lint       # eslint
bun run format     # prettier --write
bun run build      # tsc -b && vite build
bun run package    # electron-forge package
bun run make       # electron-forge make (distributables)
```

No test runner is configured.

## Architecture at a glance

Electron Forge + Vite with three build targets in one repo: `electron/main.ts` (main), `electron/preload.ts` (preload), `src/main.tsx` (renderer). Each has its own `vite.*.config.ts` and tsconfig. `tsconfig.app.json` includes `electron/` for type-only imports — never import runtime code from `electron/` into `src/`.

### IPC: single-channel auto-typed RPC

All handler calls route through one `ipcMain.handle("demio-ipc-api", ...)` with `namespace:method` string routing. Events broadcast on `"demio-ipc-event"`. Preload reads handler/event metadata from `additionalArguments` (via `process.argv`) and auto-generates typed wrappers — there are no hardcoded channel names in preload or renderer.

Renderer access via `apis.<namespace>.<method>(...)` and `events.<namespace>.<onWhatever>(cb)` from `@/types/electron-api`. To add a namespace, drop a file in `electron/handlers/` or `electron/events/` and register it in the respective `index.ts` — preload wrappers and renderer types update automatically. See `AGENTS.md` for the full step-by-step.

Ordering constraints in `electron/main.ts`:
- `registerHandlers()` BEFORE window creation (handler must exist when preload runs)
- `registerEvents()` AFTER window creation (attaches to existing `BrowserWindow` instances)
- `sandbox: false` in `webPreferences` is required so preload can read `process.argv`

### Persistence layers

- **`electron/shared-storage.ts`** — main-process-backed reactive KV, synced to preload via `sendSync` on init, broadcasts tagged with clientId to avoid echo. Use `sharedStorage.set/get/watch` from the renderer.
- **`electron/store/`** — file-based project store under `~/.demio/` (projects, threads, messages). `initStore()` runs at app ready.
- **`electron/store/provider-keys.ts`** — encrypted LLM provider key storage (Anthropic, OpenAI, Google, Bedrock).

### Agent orchestration

`electron/agent/orchestrator.ts` drives the multi-agent video-generation pipeline using the Vercel AI SDK (`ai` v6, `@ai-sdk/*`). Tool implementations live in `electron/agent/tools/`. Sessions/runs/threads are persisted via the file store. `electron/observability/phoenix.ts` wires OpenTelemetry → Arize Phoenix for LLM tracing (`initPhoenix()` runs first at app ready).

### Browser automation

`agent-browser` (npm package) runs as a daemon (`electron/lib/agent-browser/daemon.ts`); `electron/lib/agent-browser/stream.ts` exposes a WebSocket stream server consumed by the renderer's `LiveBrowserView`. Daemon starts at app ready and is torn down in `before-quit`.

### Renderer routing

`src/main.tsx` is bootstrap only. All routes live in `src/router.tsx` using `createHashRouter` (required for Electron `file://`). Shared providers live in `src/layouts/root-layout.tsx`. Pages mirror URL tree under `src/pages/<route>/index.tsx`.

### Component placement

- `src/components/ui/` — shadcn primitives only, added via `bunx shadcn@latest add <name>`
- `src/components/<feature>/` — feature-scoped, co-located with the page that uses them
- `src/components/ai-elements/` — shared AI/chat components used across multiple pages

## Style

- No semicolons, double quotes, 2-space indent (Prettier enforced — `.prettierrc`)
- `prettier-plugin-tailwindcss` is active — never hand-sort Tailwind classes
- Strict TS: `noUnusedLocals`, `noUnusedParameters`, `verbatimModuleSyntax` — use `import type` for type-only imports
- Path alias `@/*` → `./src/*` (renderer only)
- `.gitignore` excludes nested `**/CLAUDE.md` but keeps root `/CLAUDE.md` — only this file is checked in
