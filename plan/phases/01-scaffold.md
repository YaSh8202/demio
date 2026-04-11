# Phase 01 — Project Scaffold

## Prerequisites
None — this is the starting point.

## Goals
Set up the Electron + React + Vite + Tailwind project with all dependencies, build config, and directory structure. By the end, `npm run dev` opens an Electron window with a blank React app and hot-reload working.

## Tasks

### 1.1 Initialize project
- Create `demio-electron-app/` directory (the actual app, separate from this plan)
- `npm init` with project metadata
- Set `"type": "module"` in package.json

### 1.2 Install core dependencies

**Runtime:**
```
electron
react react-dom
@radix-ui/react-dialog @radix-ui/react-dropdown-menu @radix-ui/react-scroll-area @radix-ui/react-separator @radix-ui/react-slot @radix-ui/react-tooltip
lucide-react
tailwindcss @tailwindcss/vite
ai @ai-sdk/anthropic zod
agent-browser
elevenlabs
fix-webm-duration
pixi.js @pixi/filter-blur gsap
mediabunny web-demuxer
```

**Dev:**
```
vite vite-plugin-electron vite-plugin-electron-renderer
typescript @types/react @types/react-dom @types/node
electron-builder
```

### 1.3 Configure Vite + Electron
- `vite.config.ts` — React plugin, TailwindCSS plugin, electron plugin (main + preload entries)
- `tsconfig.json` — strict mode, paths, JSX
- `tsconfig.node.json` — for electron main process
- `tailwind.config.ts` — content paths, theme tokens (dark mode default)

### 1.4 Create Electron shell
- `electron/main.ts` — app lifecycle, create main window, dev-mode Vite URL loading
- `electron/preload.ts` — context bridge with typed API surface
- `electron/windows.ts` — window config (size, webPreferences)

### 1.5 Create React shell
- `src/main.tsx` — React root mount
- `src/App.tsx` — basic layout shell (sidebar placeholder, main area placeholder)
- `src/index.css` — Tailwind imports, base styles, dark theme defaults
- `src/components/ui/` — create a few base Radix wrappers (Button, ScrollArea) matching openscreen patterns

### 1.6 Create directory skeleton
```
src/
├── agent/
│   ├── tools/
│   ├── prompts/
│   └── types.ts
├── components/
│   ├── chat/
│   ├── preview/
│   ├── project/
│   └── ui/
├── lib/
│   ├── agentBrowser/
│   └── video/
├── hooks/
└── types/
    └── index.ts
```

### 1.7 Add npm scripts
```json
{
  "dev": "vite",
  "build": "vite build",
  "preview": "vite preview",
  "postinstall": "agent-browser install",
  "electron:dev": "vite -- --mode electron"
}
```

### 1.8 Create IPC type contract
- `src/types/ipc.ts` — define the IPC channel names and payload types shared between main and renderer
- `electron/ipc/handlers.ts` — empty handler registration scaffold

## Files to Create

```
demio-electron-app/
├── package.json
├── tsconfig.json
├── tsconfig.node.json
├── vite.config.ts
├── tailwind.config.ts
├── index.html
├── electron/
│   ├── main.ts
│   ├── preload.ts
│   ├── windows.ts
│   └── ipc/
│       └── handlers.ts
├── src/
│   ├── main.tsx
│   ├── App.tsx
│   ├── index.css
│   ├── components/ui/ (Button.tsx, ScrollArea.tsx)
│   ├── agent/ (empty skeleton)
│   ├── lib/ (empty skeleton)
│   ├── hooks/ (empty)
│   └── types/
│       ├── index.ts
│       └── ipc.ts
```

## Verification
- `npm run dev` → Electron window opens showing a React page with "Demio" title
- Hot-reload: edit App.tsx → changes appear without restart
- TailwindCSS classes work (dark background, rounded buttons)
- No TypeScript errors: `npx tsc --noEmit`
- `agent-browser --version` works (installed via postinstall)

---

## AI Coding Assistant Prompt

```
You are building "Demio", an Electron desktop app that generates demo videos using AI. This is Phase 1: scaffolding.

Create a new Electron + React + Vite + TailwindCSS project at `demio-electron-app/` with the following requirements:

**Tech stack:**
- Electron (latest) as the desktop shell
- React 19 + TypeScript for the renderer
- Vite + vite-plugin-electron for build
- TailwindCSS v4 with @tailwindcss/vite plugin
- Radix UI primitives (@radix-ui/react-dialog, dropdown-menu, scroll-area, separator, slot, tooltip)
- lucide-react for icons

**Package.json dependencies to include (even if not used yet):**
Runtime: electron, react, react-dom, ai, @ai-sdk/anthropic, zod, agent-browser, elevenlabs, fix-webm-duration, pixi.js, gsap, mediabunny, web-demuxer, @radix-ui/* (dialog, dropdown-menu, scroll-area, separator, slot, tooltip), lucide-react
Dev: vite, vite-plugin-electron, vite-plugin-electron-renderer, typescript, @types/react, @types/react-dom, @types/node, electron-builder

**Electron setup:**
- `electron/main.ts`: app lifecycle, single BrowserWindow, loads Vite dev server URL in dev mode or built index.html in prod. Window size 1400x900, dark background.
- `electron/preload.ts`: context bridge with a typed `window.api` object (empty for now, will add IPC methods later).
- `electron/windows.ts`: window config factory.
- `electron/ipc/handlers.ts`: scaffold for IPC handler registration (empty, just the setup function).

**React setup:**
- `src/main.tsx`: mount React root
- `src/App.tsx`: basic two-column layout — left sidebar (280px, will become chat panel) and main area (will become preview). Use Tailwind dark theme. Show "Demio" as the app title.
- `src/index.css`: Tailwind v4 imports, dark theme base styles (dark bg, light text)
- `src/components/ui/Button.tsx`: basic styled button using Radix Slot pattern
- `src/components/ui/ScrollArea.tsx`: Radix ScrollArea wrapper

**Directory skeleton (create empty index.ts files as needed):**
- `src/agent/tools/`, `src/agent/prompts/`, `src/agent/types.ts`
- `src/components/chat/`, `src/components/preview/`, `src/components/project/`
- `src/lib/agentBrowser/`, `src/lib/video/`
- `src/hooks/`
- `src/types/index.ts`, `src/types/ipc.ts`

**Build config:**
- `vite.config.ts` with React, TailwindCSS, and Electron plugins
- `tsconfig.json` with strict mode, path aliases (`@/` → `src/`)
- Add postinstall script: `agent-browser install`

**Important patterns to follow:**
- Reference `~/code/github/openscreen/` for Electron + Vite + React patterns (it's a similar Electron app). Match its vite.config.ts and electron setup structure.
- Use ES modules throughout (`"type": "module"`)
- Dark mode as default (not togglable)
- Preload script uses contextBridge.exposeInMainWorld

After setup, verify: `npm install && npm run dev` opens an Electron window with the two-column layout, Tailwind styles working, no TS errors.
```
