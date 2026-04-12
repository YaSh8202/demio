# AGENTS.md

## Quick Reference

```bash
bun start          # Electron dev (Forge + Vite HMR)
bun run typecheck  # tsc --noEmit (both tsconfig.app + tsconfig.node)
bun run lint       # eslint
bun run format     # prettier --write
```

`bun run dev` runs Vite renderer only — no Electron shell. Always use `bun start` when testing IPC or main-process code.

## Style

- No semicolons, double quotes, 2-space indent (Prettier enforced)
- `prettier-plugin-tailwindcss` active — never hand-sort Tailwind classes
- Strict TS: `noUnusedLocals`, `noUnusedParameters`, `verbatimModuleSyntax`
- Use `import type` for type-only imports (required by `verbatimModuleSyntax`)
- Path alias `@/*` → `./src/*` (renderer only)
- Add shadcn components: `npx shadcn@latest add <component>`

## Architecture

Electron Forge + Vite with 3 separate build targets sharing one repo:

| Target   | Entry                 | TSConfig             | Vite Config               |
| -------- | --------------------- | -------------------- | ------------------------- |
| Main     | `electron/main.ts`    | `tsconfig.node.json` | `vite.main.config.ts`     |
| Preload  | `electron/preload.ts` | `tsconfig.node.json` | `vite.preload.config.ts`  |
| Renderer | `src/main.tsx`        | `tsconfig.app.json`  | `vite.renderer.config.ts` |

`tsconfig.app.json` includes `electron/` type sources so the renderer can `import type` from handler/event definitions. No runtime imports across the boundary.

## IPC Architecture (critical)

Single-channel RPC pattern. All handler calls route through one `ipcMain.handle("demio-ipc-api", ...)` with `namespace:method` string routing. Events broadcast on `"demio-ipc-event"`.

Preload reads handler/event metadata from `additionalArguments` and auto-generates typed wrappers — no hardcoded channel names in preload or renderer.

Renderer accesses:

```ts
import { apis, events, sharedStorage, appInfo } from "@/types/electron-api"
await apis.ui.openExternal(url)
const unsub = events.ui.onMaximized((val) => { ... })
```

### Adding a new IPC handler namespace

1. Create `electron/handlers/my-thing.ts`:
   ```ts
   import type { NamespaceHandlers } from "../constants"
   export const myThingHandlers = {
     doSomething: async (_event: Electron.IpcMainInvokeEvent, arg: string) => {
       return `result: ${arg}`
     },
   } satisfies NamespaceHandlers
   ```
2. Register in `electron/handlers/index.ts`:
   ```ts
   import { myThingHandlers } from "./my-thing"
   export const allHandlers = {
     // ...existing
     myThing: myThingHandlers,
   }
   ```
3. Done. Preload wrappers + renderer types update automatically.
   Renderer can immediately call `apis.myThing.doSomething("hello")`.

### Adding a new IPC event namespace

1. Create `electron/events/my-thing.ts`:
   ```ts
   import type { NamespaceEvents } from "../constants"
   export const myThingEvents = {
     onSomethingHappened: (callback: (...args: any[]) => void) => {
       // subscribe to native events, call callback(...)
       // return cleanup function
       return () => {
         /* unsubscribe */
       }
     },
   } satisfies NamespaceEvents
   ```
2. Register in `electron/events/index.ts`:
   ```ts
   import { myThingEvents } from "./my-thing"
   export const allEvents = {
     // ...existing
     myThing: myThingEvents,
   }
   ```
3. Done. Renderer can subscribe: `events.myThing.onSomethingHappened((val) => { ... })`.

### Shared Storage

Cross-window reactive KV store. Main-process backed (`electron/shared-storage.ts`), preload-synced via `sendSync` on init, broadcasts tagged with clientId to avoid echo.

```ts
sharedStorage.set("key", value)
const unsub = sharedStorage.watch("key", (val) => { ... })
```

## Renderer Routing & Folder Structure

`src/main.tsx` is purely bootstrap — it renders `<RouterProvider>` and nothing else.
All route definitions live in `src/router.tsx` using `createHashRouter` (required for Electron `file://`).
Shared providers (theme, tooltip) are in `src/layouts/root-layout.tsx` which wraps all routes via `<Outlet />`.

### Folder conventions

```
src/
├── main.tsx                    # Bootstrap only — createRoot + RouterProvider
├── router.tsx                  # All route definitions (createHashRouter)
├── index.css
├── layouts/                    # Layout shells that wrap routes via <Outlet />
│   └── root-layout.tsx
├── pages/                      # One folder per route, mirrors URL tree
│   ├── index.tsx               # "/"      — DashboardPage
│   └── stream/
│       └── index.tsx           # "/stream" — StreamPage
├── components/
│   ├── dashboard/              # Feature-scoped components (used by pages/index.tsx)
│   ├── ai-elements/            # AI/chat compound components
│   ├── preview/                # Browser preview components
│   ├── onboarding/             # First-launch wizards
│   └── ui/                     # shadcn/ui primitives
├── lib/
│   ├── utils.ts                # cn() helper
│   ├── constants/              # App-wide constants (models, suggestions, etc.)
│   ├── mock-data/              # Temporary mock data (replace with real data later)
│   └── agent-browser/          # Browser streaming utilities
├── types/
│   └── electron-api.ts         # Typed Electron IPC bridge
└── assets/
```

### Adding a new route / page

1. Create a page component at `src/pages/<path>/index.tsx` (e.g. `src/pages/settings/index.tsx`)
2. Add a route entry in `src/router.tsx`:
   ```ts
   import { SettingsPage } from "@/pages/settings"
   // inside children array:
   { path: "settings", Component: SettingsPage },
   ```
3. Done. Feature-specific sub-components go in `src/components/<feature>/`.

### Component placement rules

- **`components/ui/`** — shadcn primitives only. Add via `npx shadcn@latest add <name>`.
- **`components/<feature>/`** — feature-scoped components (e.g. `components/dashboard/project-sidebar.tsx`). Co-locate with the page that uses them.
- **`components/ai-elements/`** — shared AI/chat components used across multiple pages.
- **`lib/constants/`** — app-wide constants. One file per domain (models, suggestions, etc.).
- **`lib/mock-data/`** — temporary mock data with types. Replace with real APIs later.

## Key Files

- `electron/constants.ts` — channel names, `ExposedMeta`, `NamespaceHandlers`, `NamespaceEvents` types
- `electron/exposed.ts` — `getExposedMeta()` generates metadata passed to preload
- `electron/handlers/index.ts` — `allHandlers` aggregate + `registerHandlers()` (single ipcMain.handle)
- `electron/events/index.ts` — `allEvents` aggregate + `registerEvents()` (broadcast to all windows)
- `electron/preload.ts` — parses metadata from `process.argv`, auto-generates wrappers, exposes via `contextBridge`
- `src/types/electron-api.ts` — typed exports (`apis`, `events`, `sharedStorage`, `appInfo`) + `Window` augmentation
- `src/router.tsx` — all client-side route definitions
- `src/layouts/root-layout.tsx` — root layout with shared providers

## Gotchas

- `sandbox: false` in webPreferences is required — preload reads `process.argv` for metadata injection
- The preload duplicates channel name strings and `ExposedMeta` interface (intentionally avoids importing from main process code)
- `registerEvents()` must be called AFTER window creation (attaches to existing `BrowserWindow` instances)
- `registerHandlers()` must be called BEFORE window creation (handler must exist when preload runs)
- `tsconfig.app.json` includes electron source files for type imports only — never import runtime code from `electron/` into `src/`
- LSP may show JSON parse errors in tsconfig files — these are JSONC comments, harmless
