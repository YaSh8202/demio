# Demio

Demio is an Electron desktop app that turns a product URL + description into a polished demo video. It drives a real browser via the [agent-browser](../agent-browser) CLI, scripts each scene with an LLM, and stitches the results into an MP4.

The repo ships two pieces that need to build together:

1. **`demio/`** — the Electron + Vite + React app (this directory).
2. **`agent-browser/`** — a Rust CLI / daemon that performs the actual browser automation. `demio` invokes it via a symlinked native binary in `node_modules/agent-browser/bin/`.

In production builds the agent-browser binary ships pre-compiled inside `node_modules`. For local development you typically want to build it yourself so changes to the CLI (locator logic, recording flags, prompts the agent depends on) are picked up.

---

## Prerequisites

- **bun** ≥ 1.1 (package manager + dev runner — never use `npm`/`npx`, including for shadcn).
- **Rust** stable toolchain (only required if you want to rebuild `agent-browser` from source).
- **Chrome / Chromium** — agent-browser drives a headed Chrome instance. The first run downloads one if it can't find an existing install.
- **ffmpeg** on `PATH` — used by the recording pipeline.

---

## Install dependencies

```bash
bun install
```

This pulls in the published `agent-browser` package (which provides the `node_modules/agent-browser/bin/agent-browser-<os>-<arch>` symlink target).

---

## Run the app

```bash
bun start          # Electron dev (Forge + Vite HMR) — the normal "run demio" command
bun run dev        # Vite renderer only (no Electron shell), useful for pure UI work
bun run typecheck  # tsc --noEmit across both tsconfig.app + tsconfig.node
bun run lint       # eslint
bun run format     # prettier --write
bun run build      # tsc -b && vite build
bun run package    # electron-forge package
bun run make       # electron-forge make (distributables)
```

No test runner is configured for the Electron app itself. The Rust CLI has its own test suite — see below.

---

## Building agent-browser from source

The Rust CLI lives at `../agent-browser/cli`. The native binary that demio loads is at `../agent-browser/bin/agent-browser-<os>-<arch>` (e.g. `agent-browser-darwin-arm64`). `node_modules/agent-browser/bin/<same-name>` is a symlink to that file, so anything you drop into `agent-browser/bin/` is picked up by demio on the next daemon start.

### One-time release build

From the repo root:

```bash
cd agent-browser/cli
cargo build --release
```

The resulting binary is at `agent-browser/cli/target/release/agent-browser`. Copy it over the platform-named entry that demio looks for:

```bash
# macOS arm64 (Apple silicon)
cp agent-browser/cli/target/release/agent-browser \
   agent-browser/bin/agent-browser-darwin-arm64

# macOS x64 (Intel)
cp agent-browser/cli/target/release/agent-browser \
   agent-browser/bin/agent-browser-darwin-x64

# Linux x64
cp agent-browser/cli/target/release/agent-browser \
   agent-browser/bin/agent-browser-linux-x64

# Windows x64
cp agent-browser/cli/target/release/agent-browser.exe \
   agent-browser/bin/agent-browser-win32-x64.exe
```

**macOS only — re-sign after copying.** `cp` preserves the linker's ad-hoc signature but macOS (Sequoia+) will SIGKILL the binary at exec (`[1] <pid> killed` with no other output) due to the stale signature + `com.apple.provenance` xattr. Strip xattrs and re-adhoc-sign:

```bash
xattr -cr agent-browser/bin/agent-browser-darwin-arm64
codesign --force --sign - agent-browser/bin/agent-browser-darwin-arm64
```

Verify:

```bash
agent-browser/bin/agent-browser-<os>-<arch> --version
# → agent-browser 0.26.0
```

### Iterating on agent-browser changes

agent-browser runs as a long-lived daemon. After replacing the binary you must kill the old daemon process so demio respawns it from the new bits — otherwise your changes will not take effect even after restarting the Electron app.

```bash
# 1. Kill any daemon spawned by demio
pkill -9 -f "agent-browser/bin/agent-browser-"   # production-style invocation
pkill -9 -f "target/release/agent-browser"        # if you ran the binary directly during testing

# 2. Rebuild
cd agent-browser/cli && cargo build --release && cd -

# 3. Replace the binary (use the right platform suffix)
cp agent-browser/cli/target/release/agent-browser \
   agent-browser/bin/agent-browser-darwin-arm64

# 4. macOS only — re-sign (otherwise the kernel SIGKILLs the new binary)
xattr -cr agent-browser/bin/agent-browser-darwin-arm64
codesign --force --sign - agent-browser/bin/agent-browser-darwin-arm64

# 5. Restart demio
bun start
```

A new daemon spawns the first time demio runs an `agent-browser` subcommand in the session.

### Running the agent-browser test suite

```bash
cd agent-browser/cli
cargo test --bin agent-browser
```

The suite covers the CLI parser, daemon state, action handlers, recording config, and a parity check against the documented action list. Browser-driven tests live in `e2e_tests.rs` and need a Chrome install.

### Debug builds

`cargo build` (without `--release`) is faster but produces a slower binary; recordings will encode visibly slower frames. Fine for fast iteration on parser / config code, not for testing recording quality.

---

## Where things live

| Path | Purpose |
|------|---------|
| `electron/main.ts` | Main process entrypoint |
| `electron/preload.ts` | Preload script — auto-generates typed IPC wrappers |
| `electron/handlers/` | IPC handler namespaces (renderer-callable methods) |
| `electron/events/` | Main → renderer event broadcasters |
| `electron/agent/` | LLM agent orchestrator, prompts, tools, providers |
| `electron/lib/agent-browser/` | Daemon lifecycle + subprocess wrapper for the Rust CLI |
| `electron/store/` | File-backed project / thread / message store under `~/.demio/` |
| `src/main.tsx`, `src/router.tsx` | Renderer bootstrap + hash router |
| `src/pages/`, `src/components/` | Renderer UI |

For deeper architecture notes see `AGENTS.md`, `demio.md`, and the per-folder `CLAUDE.md` files.

---

## Adding shadcn components

```bash
bunx shadcn@latest add button
```

Components land in `src/components/ui/`. Use them via:

```tsx
import { Button } from "@/components/ui/button"
```

`prettier-plugin-tailwindcss` is active — never hand-sort Tailwind classes.
