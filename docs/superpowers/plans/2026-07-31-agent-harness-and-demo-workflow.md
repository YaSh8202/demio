# Demio Agent Harness (Mastra AgentController) + Demo-Video Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace demio's hand-rolled agent harness (prompt-enforced phases, custom sessions/replay/ask_user) with Mastra's AgentController, and move demo-video generation into a code-enforced Mastra Workflow with per-scene record→verify→retry.

**Architecture:** AgentController owns the conversation layer (sessions, reattach, plan/execute modes, built-in `ask_user` + `submit_plan`, event stream to renderer). A registered `demo-video` Workflow owns generation: `foreach` scene → harness-owned recording around a recorder agent → mechanical verification → bounded retry → suspend to user on exhaustion → narration → TTS → ffmpeg compose. Renderer switches from SSE-chunk reassembly to controller events over the existing IPC broadcast channel.

**Tech Stack:** Electron Forge + Vite, bun, `@mastra/core@^1.55.0` (AgentController, Workflows, Workspace primitive), `@mastra/libsql`, `ai@^7`, `@ai-sdk/*` v4/v5, agent-browser native binary, ffmpeg-static, ElevenLabs TTS, zod.

**Reference implementation:** MastraCode at `~/code/github/mastra/mastracode` — the codebase AgentController was extracted from. Cited throughout as `mastracode:<path>:<line>`. When this plan and MastraCode disagree with the installed `.d.ts`, the `.d.ts` wins; when this plan and MastraCode disagree with each other, prefer MastraCode's pattern and flag the deviation.

## Global Constraints

- Package manager is **bun**, never npm/npx (`bun add`, `bun run`, `bunx`).
- Style: no semicolons, double quotes, 2-space indent (Prettier enforced); `import type` for type-only imports (`verbatimModuleSyntax`); strict TS (`noUnusedLocals`, `noUnusedParameters`).
- `bun run typecheck` (tsc -b --noEmit across app+node tsconfigs) must pass at the end of every task.
- No test runner is configured for Electron/renderer code; pure Node modules get `node --test` tests (existing pattern: `"test:scripts": "node --test scripts/*.test.js"`). Electron integration is verified via `bun run typecheck` + `bun start` smoke steps.
- Never import runtime code from `electron/` into `src/` (type-only imports allowed).
- Target versions (exact floors): `@mastra/core@^1.55.0`, `@mastra/ai-sdk@^1.7.0`, `@mastra/libsql@^1.18.0`, `@mastra/memory@^1.24.0`, `mastra@^1.21.0` (dev), `ai@^7.0.44`, `@ai-sdk/anthropic@^4.0.25`, `@ai-sdk/openai@^4.0.25`, `@ai-sdk/google@^4.0.29`, `@ai-sdk/amazon-bedrock@^5.0.38`, `@ai-sdk/react@^4.0.47`.
- Model policy: the thread's selected model everywhere (`DEFAULT_MODEL_ID` fallback). No per-role model config in this plan (future "auto mode" is out of scope).
- Milestone 2 items explicitly OUT of scope: typed browser tools, vision-judge verification, per-role model auto-selection, brand kits/intros/outros.

## Decision Record (from grilling session)

| ADR | Decision |
|---|---|
| ADR-001 | Pipeline is code-enforced via Mastra Workflow with agent steps, not prompt-enforced phases |
| ADR-002 | Conversation layer = Mastra AgentController; generation workflow invoked from execute mode |
| ADR-003 | Per-scene record→verify→retry (max 3 attempts), then suspend to user |
| ADR-004 | Verification = mechanical checks now (Layer 1); vision judge deferred to Milestone 2 |
| ADR-005 | Recording lifecycle owned by harness code, not agent scripts; bash driving stays inside record step for now |
| ADR-006 | Plan approval via built-in `submit_plan` suspension in plan mode; skippable later, default ON |
| ADR-007 (amended) | `~/.demio/mastra.db` (LibSQL) stores controller threads/sessions + workflow snapshots. Project/meta JSON store stays. Legacy thread JSON remains readable but new conversations live in controller storage |
| ADR-008 (amended) | Progress reaches renderer as AgentController events over existing IPC broadcast (replaces SSE-byte pump); workflow progress arrives as `tool_update` events of the `generate_demo` tool |
| ADR-009 | One model everywhere (thread model); "auto mode" per-provider role mapping is future work |
| ADR-010 | Milestone 1 = vertical slice: upgrade → controller migration → workflow with mechanical verify |
| ADR-011 | Core tools (execute_command/view/edit/grep/find) come from the Mastra Workspace primitive, not custom code; demio keeps custom tools only for `present_files` + `synthesize_voiceover`; agent-browser runs through `execute_command` with a PATH-shim env |
| ADR-012 | MastraCode patterns adopted: `availableTools` mode allowlists, `submit_plan({path})` plan-file contract, stable session/owner ids, promise-chain event listener, `display_state_changed` as the single re-render trigger |

## Glossary

- **AgentController** — Mastra's harness primitive (`@mastra/core/agent-controller`, renamed from `Harness`): sessions, modes, built-in tools (`ask_user`, `submit_plan`, task tools), tool suspension/approval, event subscription, display state.
- **Mode** — bundled instructions+tools state inside a controller session (`plan` → `execute` via `transitionsTo` on plan approval).
- **Tool suspension** — a built-in tool pausing the run until `respondToToolSuspension({toolCallId, resumeData})`.
- **Scene** — one contiguous recorded segment of the demo with its own goal, start/end URL, actions, and expected outcome.
- **Mechanical verify** — code-only checks on a recorded scene: file exists, ffprobe duration in range, all `actions.jsonl` entries `ok:true`, end-URL matches contract.
- **Recorder agent** — short-lived Mastra `Agent` run inside the record step; drives the browser via the existing `terminal` tool + agent-browser CLI; does NOT start/stop recording itself.
- **Workflow suspension** — `demo-video` workflow pausing on scene failure after retries; resumed with `{action: "retry" | "skip" | "abort", guidance?}`.
- **Workspace primitive** — Mastra's sandboxed filesystem+shell environment providing the core tools (`execute_command`, read, edit, grep, glob) with allowed-paths enforcement, output truncation, streamed `shell_output`, and background processes (impl: `packages/core/src/workspace/` in the mastra repo).
- **availableTools** — per-mode tool *visibility* allowlist enforced at LLM-call time (`activeTools`); distinct from `tools`/`additionalTools` which compose the toolset.

## File Structure (end state)

```
electron/agent/
  controller.ts          NEW  AgentController singleton + session management
  workspace-factory.ts   NEW  Mastra Workspace factory: thread cwd, PATH shim (agent-browser+ffmpeg), allowed paths
  mastra.ts              MOD  registers demo-video workflow + LibSQL storage; keeps createDemioAgent for recorder/narrator
  orchestrator.ts        DEL  (replaced by controller sendMessage path)
  sessions.ts            DEL  (controller sessions)
  runs.ts                DEL  (controller reattach)
  questions.ts           DEL  (built-in ask_user suspension)
  prompts.ts             MOD  split: chat/plan instructions vs recorder instructions
  types.ts               KEEP
  providers.ts           KEEP (getModel used by resolveModel)
  usage.ts               KEEP (fed from usage_update events)
  workspace.ts           KEEP (dir layout helper; Workspace primitive wraps it)
  lib/voiceover.ts       NEW  pure TTS+mix functions extracted from tools/voiceover.ts
  tools/ask-user.ts      DEL  (built-in ask_user)
  tools/terminal.ts      DEL  (Workspace execute_command — ADR-011)
  tools/read.ts          DEL  (Workspace read tool; image-downscale niceness deferred)
  tools/edit.ts          DEL  (Workspace edit tool)
  tools/present-files.ts KEEP
  tools/voiceover.ts     KEEP (thin wrapper over lib/voiceover.ts)
  workflows/
    schemas.ts           NEW  zod: ScenePlan, SceneResult, VerifyReport
    verify.ts            NEW  mechanical checks (pure, node --test tested)
    verify.test.js       NEW  tests for verify logic
    record-scene.ts      NEW  harness-owned record lifecycle + recorder agent step
    demo-video.ts        NEW  workflow assembly (foreach/dowhile/suspend)
electron/handlers/agent.ts  MOD  controller-backed IPC surface
src/hooks/use-agent-events.ts  NEW  renderer event consumer (replaces ipc-chat-transport for thread view)
src/lib/ipc-chat-transport.ts  DEL  (after thread-shell migrates)
src/components/thread/thread-shell.tsx  MOD  consume controller events
src/components/thread/workflow-progress.tsx  NEW  stage tracker card
docs/adr/ADR-001..010.md  NEW  decision records
```

---

## Phase 0 — Dependency upgrade (ships: app identical on new deps)

### Task 1: Upgrade Mastra + AI SDK to latest

**Files:**
- Modify: `package.json`
- Modify: any file `bun run typecheck` flags (expected: `electron/agent/orchestrator.ts`, `electron/agent/mastra.ts`, `electron/agent/usage.ts`, `electron/agent/title-generator.ts`, `electron/agent/providers.ts`, `src/lib/ipc-chat-transport.ts`, `src/hooks/use-active-thread.tsx`)

**Interfaces:**
- Produces: repo compiling and running against `ai@^7` + `@mastra/core@^1.55.0`. Later tasks import `AgentController` from `@mastra/core/agent-controller` and `LibSQLStore` from `@mastra/libsql`.

- [ ] **Step 1: Bump versions**

```bash
bun add ai@^7.0.44 @ai-sdk/anthropic@^4.0.25 @ai-sdk/openai@^4.0.25 @ai-sdk/google@^4.0.29 @ai-sdk/amazon-bedrock@^5.0.38 @ai-sdk/react@^4.0.47 @mastra/core@^1.55.0 @mastra/ai-sdk@^1.7.0 @mastra/libsql@^1.18.0 @mastra/memory@^1.24.0
bun add -d mastra@^1.21.0
```

- [ ] **Step 2: Typecheck and fix breaks**

Run: `bun run typecheck`

Fix every error. Known break surface for `ai` v6→v7 and `@ai-sdk/*` majors (consult https://ai-sdk.dev/docs/migration-guides — fetch the v7 guide before editing):
- `createUIMessageStream` / `createUIMessageStreamResponse` / `InferUIMessageChunk` import paths or renames in `electron/agent/orchestrator.ts:11-22`
- `LanguageModelUsage` shape used by `electron/agent/usage.ts`
- `DefaultChatTransport` / `useChat` option changes in `src/hooks/use-active-thread.tsx`
- Provider factory option changes in `electron/agent/providers.ts` (`createAnthropic` etc.)
- `toAISdkStream` version flag in `electron/agent/orchestrator.ts:221-224` (`version: "v6"` → whatever `@mastra/ai-sdk@1.7` names the v7 target; check `node_modules/@mastra/ai-sdk/dist/index.d.ts`)

Do NOT redesign anything in this task — mechanical API-compat fixes only. Orchestrator dies in Phase 1 anyway; keep changes minimal.

- [ ] **Step 3: Inspect installed AgentController types**

Run: `sed -n '1,120p' node_modules/@mastra/core/dist/agent-controller/index.d.ts` (adjust path via `ls node_modules/@mastra/core/dist | grep -i controller`)

Record in a scratch note the exact exported names for: `AgentController`, constructor options type, `createSession` options, event union type name, `respondToToolSuspension` signature. Later tasks reference the documented API; reconcile any drift NOW and carry corrections forward.

- [ ] **Step 4: Smoke test**

Run: `bun start`
Expected: app boots, existing chat thread streams a reply end-to-end (send "hello" in a test thread), voiceover tool still registers when a voice is configured.

- [ ] **Step 5: Commit**

```bash
git add package.json bun.lock electron src
git commit -m "chore: upgrade ai sdk to v7 and mastra to 1.55"
```

### Task 2: Write ADR docs

**Files:**
- Create: `docs/adr/ADR-001-code-enforced-workflow.md` … `docs/adr/ADR-012-mastracode-patterns.md`

**Interfaces:**
- Produces: decision context for reviewers; no code consumes these.

- [ ] **Step 1: Write the ten ADR files**

One file per row of the Decision Record table above (twelve files). Format each as:

```markdown
# ADR-00N: <title>

Date: 2026-07-31
Status: accepted

## Decision
<the decision column text, expanded to 2-4 sentences>

## Context
<one paragraph: what problem in the current code motivates it — cite files, e.g. prompt-enforced phases in electron/agent/prompts.ts, hand-rolled replay in electron/agent/runs.ts>

## Consequences
<2-4 bullets: what changes, what is deferred>
```

For ADR-007 and ADR-008 include the "amended" history (original decision + what the AgentController adoption changed).

- [ ] **Step 2: Commit**

```bash
git add docs/adr
git commit -m "docs: record harness architecture decisions ADR-001..012"
```

---

## Phase 1 — AgentController conversation layer (ships: chat runs on controller; sessions/replay/ask_user hand-rolls deleted)

### Task 3: Workspace factory + controller module + LibSQL storage

**Files:**
- Create: `electron/agent/workspace-factory.ts`
- Create: `electron/agent/controller.ts`
- Modify: `electron/store/paths.ts` (add `mastraDbPath()`)
- Modify: `electron/agent/prompts.ts` (export `chatInstructions()` — the conversational portion of today's `systemPrompt`, minus scene-recording phase instructions which move to the recorder agent in Task 11, and minus terminal/read/edit tool docs — Workspace tools document themselves)

**Interfaces:**
- Consumes: `getModel(modelId)` from `electron/agent/providers.ts`; `ensureWorkspace(threadId)` from `electron/agent/workspace.ts`; the PATH-shim construction currently inside `electron/agent/tools/terminal.ts` (read it — it builds a shim dir exposing bundled `agent-browser` + `ffmpeg`); Task 1's verified AgentController API.
- Reference: MastraCode instantiation `mastracode:sdk/src/index.ts:972-1024`; minimal template `mastracode:web/e2e/web/agent-controller-server.ts:172-186`; dynamic workspace `mastracode:sdk/src/agents/workspace.ts:243`; ctx shape `mastracode:sdk/src/index.ts:671-700`.
- Produces:
  - `createDemioWorkspace(threadId: string): Workspace` — Workspace with cwd = thread workspace dir, env with PATH shim, allowed paths
  - `getController(): Promise<AgentController>` — lazy singleton, `init()`ed once
  - `getOrCreateSession(projectId: string, threadId: string): Promise<Session>` — get-or-create keyed `(resourceId: projectId, scope: threadId)`
  - `type DemioControllerEvent` — the controller event union re-exported for the handler/preload typing

- [ ] **Step 1: Add DB path helper**

In `electron/store/paths.ts` add (matching the existing path-helper style in that file):

```ts
/** LibSQL database backing AgentController threads + workflow snapshots. */
export function mastraDbPath(): string {
  return path.join(demioRoot(), "mastra.db")
}
```

(Use the file's actual root-dir helper name — read `electron/store/paths.ts` first; it already builds `~/.demio` paths for projects/workspaces.)

- [ ] **Step 2: Write `electron/agent/workspace-factory.ts`**

```ts
// ── Demio Workspace factory (ADR-011) ───────────────────────────────────────
//
// Builds a Mastra Workspace per thread: local filesystem + sandbox rooted at
// the thread's ~/.demio/workspaces/<threadId> dir, with the agent-browser +
// ffmpeg PATH shim in the sandbox env (lifted from the deleted terminal tool).
// Core tools (execute_command, read, edit, grep, glob) come from this
// primitive — demio no longer implements them.

import os from "node:os"
import { ensureWorkspace } from "./workspace"

// Import names below are the documented Workspace surface — reconcile against
// the installed @mastra/core .d.ts (Task 1 Step 3). MastraCode reference:
// mastracode:sdk/src/agents/workspace.ts:243 and :24-34 (env), :158 (paths).
import { Workspace, LocalFilesystem, LocalSandbox } from "@mastra/core/workspace"

export function createDemioWorkspace(threadId: string): Workspace {
  const cwd = ensureWorkspace(threadId)
  const shimPath = buildShimPath() // extract from tools/terminal.ts before deleting it

  return new Workspace({
    // Stable id per thread — reuse preserves ProcessManager (background
    // processes) across turns; see mastracode:sdk/src/agents/workspace.ts:305-315.
    id: `demio-workspace-${threadId}`,
    filesystem: new LocalFilesystem({
      allowedPaths: [cwd, os.tmpdir()],
    }),
    sandbox: new LocalSandbox({
      cwd,
      env: {
        PATH: `${shimPath}:${process.env.PATH ?? ""}`,
        FORCE_COLOR: "1",
        CI: "true",
        NONINTERACTIVE: "1",
      },
    }),
  })
}
```

`buildShimPath()`: move the shim-directory construction out of `electron/agent/tools/terminal.ts` verbatim (the code that symlinks/exposes bundled `agent-browser` + `ffmpeg-static` binaries on PATH) into this file, exported for reuse. Constructor/class names (`Workspace`, `LocalFilesystem`, `LocalSandbox`, option keys) MUST be reconciled against the installed `.d.ts` — the invariant: thread-scoped cwd, allowed paths = cwd + tmpdir, shimmed PATH, background-process support.

- [ ] **Step 3: Write `electron/agent/controller.ts`**

```ts
// ── AgentController runtime ──────────────────────────────────────────────────
//
// Singleton Mastra AgentController owning demio's conversation layer:
// per-thread sessions, plan/execute modes, built-in ask_user + submit_plan,
// Workspace-provided core tools, and the event stream the IPC handler
// broadcasts to the renderer.
//
// Replaces the hand-rolled sessions.ts (AbortController map), runs.ts (SSE
// replay buffer) and questions.ts (deferred-promise ask_user).
// Config shape mirrors mastracode:sdk/src/index.ts:972-1024.

import { AgentController } from "@mastra/core/agent-controller"
import { LibSQLStore } from "@mastra/libsql"
import { z } from "zod"
import { getModel } from "./providers"
import { DEFAULT_MODEL_ID } from "./types"
import { chatInstructions } from "./prompts"
import { createDemioWorkspace } from "./workspace-factory"
import { createPresentFilesTool } from "./tools/present-files"
import { mastraDbPath } from "../store/paths"

// Plan mode sees read-only workspace tools plus the interaction tools.
// Visibility allowlist (activeTools), NOT toolset composition — the
// mastracode pattern (sdk/src/agents/tool-availability.ts:93-116).
// Tool names: use the names the installed Workspace primitive registers
// (execute_command / read / edit / grep / glob or their actual ids — list
// them once at runtime and pin here).
const PLAN_MODE_TOOLS = [
  "read",
  "grep",
  "glob",
  "ask_user",
  "submit_plan",
  "task_write",
  "task_update",
  "task_complete",
  "task_check",
]

let controller: AgentController | null = null
let initPromise: Promise<AgentController> | null = null

export async function getController(): Promise<AgentController> {
  if (controller) return controller
  if (initPromise) return initPromise

  initPromise = (async () => {
    const instance = new AgentController({
      id: "demio",
      storage: new LibSQLStore({
        id: "demio-storage",
        url: `file:${mastraDbPath()}`,
      }),
      stateSchema: z.object({
        currentModelId: z.string().optional(),
        activePlan: z
          .object({
            title: z.string(),
            plan: z.string(),
            approvedAt: z.string(),
          })
          .optional(),
      }),
      resolveModel: (modelId: string) => getModel(modelId || DEFAULT_MODEL_ID),
      instructions: chatInstructions(),
      // Per-session workspace: scope carries the threadId (set in
      // getOrCreateSession); dynamic factory mirrors
      // mastracode:sdk/src/index.ts:980.
      workspace: ({ requestContext }) => {
        const ctx = requestContext.get("controller") as {
          session: { id: string }
        }
        const threadId = ctx.session.id.split(":")[1]
        return createDemioWorkspace(threadId)
      },
      tools: () => ({
        present_files: createPresentFilesTool(),
      }),
      modes: [
        {
          id: "plan",
          name: "Plan",
          metadata: { default: true },
          transitionsTo: "execute",
          availableTools: PLAN_MODE_TOOLS,
          instructions: [
            "Understand the user's demo request and explore the target site read-only if needed.",
            "Write the scene-by-scene demo plan to a markdown file under plans/ in the workspace,",
            "then call submit_plan({ path }) with the path to that file — never the plan body.",
            "Do NOT output the plan as text. To revise after 'Request changes', edit the same",
            "file in place and call submit_plan again with the same path.",
            "The plan file must contain a fenced json block matching the scene plan schema",
            "(scenes with id/title/goal/startUrl/endUrl/actions/expectedOutcome/narrationHint).",
            "Do not record anything in this mode.",
          ].join(" "),
        },
        {
          id: "execute",
          name: "Execute",
          instructions:
            "The plan is approved (activePlan in state; the plan file contains a fenced " +
            "json scene plan). Call generate_demo exactly once with that json plan, " +
            "then present the resulting video with present_files.",
        },
      ],
    })

    await instance.init()
    controller = instance
    return instance
  })()

  return initPromise
}
```

Implementer notes:
- The `workspace`/`tools` callback ctx shape: MastraCode's callbacks receive `{ requestContext }` and read `requestContext.get("controller")` which exposes `{ controllerId, state, threadId, resourceId, workspace, session: { id, ownerId, modeId, modelId, state } }` (`mastracode:sdk/src/index.ts:671-700`). Recovering threadId from `session.id` assumes the `${projectId}:${threadId}` session-id convention from Step 4 — if the ctx exposes `scope` directly, prefer that.
- Plan-file hard gate (defense-in-depth like mastracode's `guardPlanModePlanFileWrites`, `sdk/src/agents/tool-availability.ts:61`): if the installed Workspace supports write-path hooks, block plan-mode writes outside `plans/`; if not, skip — the allowlist + prompt still constrain it. Do not build a custom hook system for this.
- `present_files` needs the session cwd: read it from the same requestContext in its execute, or make `createPresentFilesTool` accept a cwd-resolver callback. Keep its streamed name `present_files`.

- [ ] **Step 4: Add `getOrCreateSession`** (same file)

```ts
const sessions = new Map<string, Awaited<ReturnType<AgentController["createSession"]>>>()

export async function getOrCreateSession(projectId: string, threadId: string) {
  const key = `${projectId}:${threadId}`
  const existing = sessions.get(key)
  if (existing) return existing

  const ctrl = await getController()
  // Get-or-create is keyed (resourceId, scope) inside the controller —
  // asking twice returns the same session (in-flight promise cached).
  // scope isolates threads within a project, mirroring MastraCode's
  // worktree-path-as-scope pattern.
  const session = await ctrl.createSession({
    id: key,
    ownerId: projectId,
    resourceId: projectId,
    scope: threadId,
    tags: { projectId, threadId },
    workspace: createDemioWorkspace(threadId),
  })
  sessions.set(key, session)
  return session
}
```

(If `createSession({ workspace })` is supported — MastraCode's types say yes — the per-session workspace makes the top-level `workspace` callback in Step 3 a fallback; keep both consistent, the session-level one wins. Thread selection: do NOT eagerly create threads — defer to first message like MastraCode's `pendingNewThread` if the API surface allows, else `selectOrCreateThread()` here.)

- [ ] **Step 5: Extract `chatInstructions()` in `prompts.ts`**

Read `electron/agent/prompts.ts` fully. Split `systemPrompt(...)` into:
- `chatInstructions()` — identity, tone, present_files usage, workspace conventions, discovery guidance. NO terminal/read/edit tool docs (Workspace tools self-document), NO scene-recording phase machine, NO voiceover timing rules.
- `recorderInstructions(opts: { workspace: string; scene: ScenePlanScene })` — added in Task 11; for now just leave the recording/voiceover sections in place unexported.

Keep `systemPrompt` exported and working (orchestrator still uses it until Task 7).

- [ ] **Step 6: Typecheck**

Run: `bun run typecheck`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add electron/agent/controller.ts electron/agent/workspace-factory.ts electron/agent/prompts.ts electron/store/paths.ts
git commit -m "feat: AgentController with plan/execute modes, workspace primitive and libsql storage"
```

### Task 4: Controller-backed IPC handlers

**Files:**
- Modify: `electron/handlers/agent.ts` (full rewrite of handler bodies; keep `NamespaceHandlers` shape + `broadcast` helper)

**Interfaces:**
- Consumes: `getController`, `getOrCreateSession` from Task 3.
- Produces IPC surface (preload auto-generates wrappers from these names):
  - `agent.sendMessage(projectId, threadId, body: { message: UIMessage; modelId?: string }) → { ok: true }`
  - `agent.cancel(projectId, threadId) → { cancelled: true }`
  - `agent.respondSuspension(projectId, threadId, body: { toolCallId: string; resumeData: unknown }) → { ok: true }`
  - `agent.getDisplayState(projectId, threadId) → serialized display state or null` (reconnect path)
  - `agent.listMessages(projectId, threadId, limit?) → serialized message history` (thread mount)
  - Event: `agent:onEvent(threadKey: string, event: DemioControllerEvent)` broadcast for every controller event of that session (Maps serialized to plain objects)

- [ ] **Step 1: Rewrite `electron/handlers/agent.ts`**

```ts
// ── Agent IPC Handlers ───────────────────────────────────────────────────────
//
// Controller-backed surface. Every AgentController event for a session is
// broadcast as `agent:onEvent` keyed by `${projectId}:${threadId}`; the
// renderer rebuilds message + progress state from events and can re-hydrate
// after refresh via `getDisplayState`.

import { BrowserWindow } from "electron"
import log from "../lib/logger"
import { DEMIO_EVENT_CHANNEL } from "../constants"
import type { NamespaceHandlers } from "../constants"
import { getProject } from "../store"
import { getController, getOrCreateSession } from "../agent/controller"
import { DEFAULT_MODEL_ID } from "../agent/types"
import type { UIMessage } from "../store/types"

function broadcast(channel: string, ...args: unknown[]) {
  BrowserWindow.getAllWindows().forEach((win) => {
    if (!win.isDestroyed()) {
      win.webContents.send(DEMIO_EVENT_CHANNEL, channel, ...args)
    }
  })
}

const subscribed = new Set<string>()

// Maps inside events/displayState do not survive the preload JSON boundary —
// convert to plain objects/arrays before broadcast.
function serializeEvent(event: unknown): unknown {
  return JSON.parse(
    JSON.stringify(event, (_k, v) =>
      v instanceof Map ? Object.fromEntries(v) : v
    )
  )
}

async function ensureSubscribed(projectId: string, threadId: string) {
  const key = `${projectId}:${threadId}`
  if (subscribed.has(key)) return
  subscribed.add(key)
  const session = await getOrCreateSession(projectId, threadId)
  // Promise-chain serialization: async handlers must not interleave
  // (mastracode:tui/src/tui/setup.ts:571-590). Broadcast is sync today, but
  // keep the chain — persistence hooks land here later.
  let queue = Promise.resolve()
  session.subscribe((event: unknown) => {
    queue = queue.then(() => {
      try {
        broadcast("agent:onEvent", key, serializeEvent(event))
      } catch (error) {
        log.error("[agent] event broadcast failed:", error)
      }
    })
  })
}
```

Ordering constraint (MastraCode hit this — `mastracode:tui/src/tui/mastra-tui.ts:637-656`): subscribe BEFORE any thread selection/creation happens on the session, or the renderer misses the initial `thread_changed`. `getOrCreateSession` must therefore not eagerly select threads before `ensureSubscribed` has attached — call `ensureSubscribed` first in every handler (the code below does). If the session API only exposes controller-level `subscribe`, filter events by session/thread id in the callback.

```ts

export const agentHandlers = {
  sendMessage: async (
    _event: Electron.IpcMainInvokeEvent,
    projectId: string,
    threadId: string,
    body: { message: UIMessage; modelId?: string }
  ) => {
    await ensureSubscribed(projectId, threadId)
    const session = await getOrCreateSession(projectId, threadId)
    const modelId =
      body.modelId ||
      getProject(projectId)?.meta?.selectedModel ||
      DEFAULT_MODEL_ID
    applySessionModel(session, modelId) // session.model setter — reconcile exact API
    // Fire and forget — progress arrives via agent:onEvent. While a run is
    // active this becomes a follow-up/steer decision; MastraCode uses
    // sendSignal({ifActive, ifIdle}) for exactly this (tui/src/tui/mastra-tui.ts:454).
    // Use sendSignal if exposed; else sendMessage (it queues internally).
    void session
      .sendMessage({ content: extractText(body.message) })
      .catch((error: unknown) => {
        log.error("[agent] sendMessage failed:", error)
        broadcast("agent:onEvent", `${projectId}:${threadId}`, {
          type: "error",
          error: error instanceof Error ? error.message : String(error),
        })
      })
    return { ok: true }
  },

  respondSuspension: async (
    _event: Electron.IpcMainInvokeEvent,
    projectId: string,
    threadId: string,
    body: { toolCallId: string; resumeData: unknown }
  ) => {
    await ensureSubscribed(projectId, threadId)
    const session = await getOrCreateSession(projectId, threadId)
    await session.respondToToolSuspension({
      toolCallId: body.toolCallId,
      resumeData: body.resumeData,
    })
    return { ok: true }
  },

  cancel: async (
    _event: Electron.IpcMainInvokeEvent,
    projectId: string,
    threadId: string
  ) => {
    const session = await getOrCreateSession(projectId, threadId)
    // Abort guard must cover BOTH states: isRunning() is false while a tool
    // sits in suspend() (mastracode:tui/src/tui/setup.ts:70) — abort anyway
    // so a parked ask_user/submit_plan also cancels.
    session.abort()
    return { cancelled: true }
  },

  getDisplayState: async (
    _event: Electron.IpcMainInvokeEvent,
    projectId: string,
    threadId: string
  ) => {
    await ensureSubscribed(projectId, threadId)
    const session = await getOrCreateSession(projectId, threadId)
    const ds = session.displayState.get() ?? null
    return ds ? serializeEvent(ds) : null
  },

  // History for thread mount / refresh-reattach. Controller storage is the
  // source of truth for controller-era conversations (ADR-007 amended);
  // mirrors mastracode renderExistingMessages (tui/src/tui/render-messages.ts:843).
  listMessages: async (
    _event: Electron.IpcMainInvokeEvent,
    projectId: string,
    threadId: string,
    limit?: number
  ) => {
    await ensureSubscribed(projectId, threadId)
    const session = await getOrCreateSession(projectId, threadId)
    const messages = await session.thread.listActiveMessages({
      limit: limit ?? 200,
    })
    return serializeEvent(messages)
  },
} satisfies NamespaceHandlers

function extractText(message: UIMessage): string {
  return (message.parts ?? [])
    .map((p) => (p.type === "text" ? (p as { text: string }).text : ""))
    .filter(Boolean)
    .join("\n")
}
```

Implementer notes (reconcile with installed API from Task 1 Step 3):
- Model selection: apply `modelId` via the controller's session model API (`session.model` setter or `sendMessage` option) — whichever exists; the invariant is the thread's selected model is used for the run.
- Multi-window session routing: if `ctrl.session` is single-active-session, switching threads must call the session-selection API before `sendMessage`. If sessions are truly parallel (sessionScope), route per session object. STOP and flag if neither works.
- `files` on `sendMessage` handles attachments later — out of scope.

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck`
Expected: PASS (old orchestrator path still compiles alongside)

- [ ] **Step 3: Smoke test main-process path**

Run: `bun start`, open a thread, send a message from devtools console via `apis.agent.sendMessage(...)` if the UI still points at the old path.
Expected: `agent:onEvent` broadcasts visible in main-process log (add a temporary `log.info` on broadcast if needed, remove before commit).

- [ ] **Step 4: Commit**

```bash
git add electron/handlers/agent.ts
git commit -m "feat: controller-backed agent IPC handlers with event broadcast"
```

### Task 5: Renderer event consumer hook

**Files:**
- Create: `src/hooks/use-agent-events.ts`
- Test: none (renderer; verified via Task 6 smoke)

**Interfaces:**
- Consumes: `apis.agent.*`, `events.agent.onEvent` from `@/types/electron-api` (auto-generated from Task 4).
- Produces:

```ts
export interface AgentEventState {
  messages: ControllerMessage[]        // whatever message shape message_update carries
  status: "idle" | "running" | "error"
  error: string | null
  suspension: {
    toolCallId: string
    toolName: string
    payload: unknown
  } | null
  displayState: unknown | null
}
export function useAgentEvents(projectId: string, threadId: string | null): AgentEventState & {
  send: (text: string) => Promise<void>
  respond: (toolCallId: string, resumeData: unknown) => Promise<void>
  cancel: () => Promise<void>
}
```

- [ ] **Step 1: Write the hook**

```tsx
// ── useAgentEvents ───────────────────────────────────────────────────────────
//
// Consumes AgentController events broadcast over IPC and folds them into
// renderable state. Replaces the SSE-chunk + useChat pipeline for the thread
// view. Re-hydrates via agent.getDisplayState on mount so a refreshed window
// resumes mid-run.

import { useCallback, useEffect, useReducer } from "react"
import { apis, events } from "@/types/electron-api"

type ControllerEvent = { type: string } & Record<string, unknown>

interface State {
  messages: unknown[]
  status: "idle" | "running" | "error"
  error: string | null
  suspension: { toolCallId: string; toolName: string; payload: unknown } | null
  displayState: unknown | null
}

const initial: State = {
  messages: [],
  status: "idle",
  error: null,
  suspension: null,
  displayState: null,
}

function reducer(state: State, event: ControllerEvent): State {
  switch (event.type) {
    case "agent_start":
      return { ...state, status: "running", error: null }
    case "agent_end":
      return { ...state, status: "idle", suspension: null }
    case "message_update": {
      const message = event.message as { id: string }
      const idx = state.messages.findIndex(
        (m) => (m as { id: string }).id === message.id
      )
      const messages =
        idx === -1
          ? [...state.messages, message]
          : state.messages.map((m, i) => (i === idx ? message : m))
      return { ...state, messages }
    }
    case "tool_suspended":
      return {
        ...state,
        suspension: {
          toolCallId: event.toolCallId as string,
          toolName: event.toolName as string,
          payload: event.suspendPayload,
        },
      }
    case "display_state_changed":
      return { ...state, displayState: event.displayState ?? state.displayState }
    case "error":
      return {
        ...state,
        status: "error",
        error: String((event.error as string) ?? "Agent error"),
      }
    default:
      return state
  }
}

export function useAgentEvents(projectId: string, threadId: string | null) {
  const [state, dispatch] = useReducer(reducer, initial)

  useEffect(() => {
    if (!threadId || !apis || !events) return
    const key = `${projectId}:${threadId}`

    const unsub = events.agent.onEvent(
      (evtKey: string, event: ControllerEvent) => {
        if (evtKey !== key) return
        dispatch(event)
      }
    )

    // Re-hydrate after refresh: history first, then live display state.
    // Subscription is already attached above, so nothing lands between the
    // snapshot and live events (dedupe by message id in the reducer).
    apis.agent
      .listMessages(projectId, threadId)
      .then((messages: unknown[]) => {
        for (const message of messages) dispatch({ type: "message_update", message })
      })
      .catch(() => {})
    apis.agent
      .getDisplayState(projectId, threadId)
      .then((ds) => {
        if (ds) dispatch({ type: "display_state_changed", displayState: ds })
      })
      .catch(() => {})

    return unsub
  }, [projectId, threadId])

  const send = useCallback(
    async (text: string) => {
      if (!threadId) return
      await apis!.agent.sendMessage(projectId, threadId, {
        message: {
          id: crypto.randomUUID(),
          role: "user",
          parts: [{ type: "text", text }],
        },
      })
    },
    [projectId, threadId]
  )

  const respond = useCallback(
    async (toolCallId: string, resumeData: unknown) => {
      if (!threadId) return
      await apis!.agent.respondSuspension(projectId, threadId, {
        toolCallId,
        resumeData,
      })
    },
    [projectId, threadId]
  )

  const cancel = useCallback(async () => {
    if (!threadId) return
    await apis!.agent.cancel(projectId, threadId)
  }, [projectId, threadId])

  return { ...state, send, respond, cancel }
}
```

Type the message/event payloads properly once Task 1 Step 3's `.d.ts` inspection names them — import them as `import type` from `electron/agent/controller` (type-only imports from `electron/` are allowed).

Message rendering references (read before writing the reducer's message handling):
- `mastracode:tui/src/tui/handlers/message.ts:65-82` — `getTrailingParts` / `getPartsBeforeTool`: assistant messages carry nested `content.parts`; split around tool invocations to get text → tool → text ordering, freeze pre-tool slices, live-stream the trailing slice.
- `mastracode:factory-ui/src/ui/domains/chat/services/transcript.ts:41-49` — the React reducer analogue: overlay live tool state by `toolCallId` in a separate `runtimeTools` map instead of mutating persisted message parts. Copy this shape.
- `shell_output` events (`{toolCallId, output, stream}`) carry live execute_command output — buffer per `toolCallId` for the tool card's terminal panel.

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/hooks/use-agent-events.ts
git commit -m "feat: renderer hook folding controller events into thread state"
```

### Task 6: Thread UI on controller events

**Files:**
- Modify: `src/components/thread/thread-shell.tsx`
- Modify: `src/hooks/use-active-thread.tsx`
- Create: `src/components/thread/suspension-card.tsx`

**Interfaces:**
- Consumes: `useAgentEvents` (Task 5).
- Produces: thread view rendering controller messages; `ask_user` and `submit_plan` suspensions rendered as interactive cards calling `respond(toolCallId, resumeData)`.

- [ ] **Step 1: Read both files fully** (`thread-shell.tsx` 454 lines, `use-active-thread.tsx`) and map every `useChat`/transport touchpoint before editing.

- [ ] **Step 2: Swap data source**

In `use-active-thread.tsx`: replace the `useChat` + `createIpcChatFetch` wiring with `useAgentEvents(projectId, threadId)`. Preserve the exported hook API that `thread-shell.tsx` consumes (messages array, status, send, cancel) so the shell diff stays small; adapt message-part rendering where the controller message shape differs from ai-sdk `UIMessage` (map parts by `type` — text, reasoning, `tool-*`).

- [ ] **Step 3: Write `suspension-card.tsx`**

```tsx
// Renders an active tool suspension. ask_user → question form (free text /
// single-select / multi-select per question, mirroring the old ask-user tool
// UI). submit_plan → plan markdown + Approve / Reject-with-feedback buttons
// resolving to { action: "approved" | "rejected", feedback? }.

import { useState } from "react"
import { Button } from "@/components/ui/button"

interface SuspensionCardProps {
  toolName: string
  payload: unknown
  onRespond: (resumeData: unknown) => void
}

export function SuspensionCard({ toolName, payload, onRespond }: SuspensionCardProps) {
  const [feedback, setFeedback] = useState("")

  if (toolName === "submit_plan") {
    // suspendPayload is {path}; main process attaches planContent (file read)
    // before broadcasting — see Task 4 note below.
    const plan = (payload as { planContent?: string })?.planContent ?? ""
    return (
      <div className="rounded-lg border p-4">
        <div className="prose prose-sm whitespace-pre-wrap">{plan}</div>
        <div className="mt-3 flex gap-2">
          <Button onClick={() => onRespond({ action: "approved" })}>
            Approve plan
          </Button>
          <Button
            variant="outline"
            onClick={() => onRespond({ action: "rejected", feedback })}
          >
            Request changes
          </Button>
        </div>
        <textarea
          className="mt-2 w-full rounded border p-2 text-sm"
          placeholder="Feedback for changes (optional)"
          value={feedback}
          onChange={(e) => setFeedback(e.target.value)}
        />
      </div>
    )
  }

  // ask_user: payload carries the question(s); reuse the existing ask-user
  // rendering component from the current tool part UI if present in the
  // thread components, otherwise a minimal free-text form:
  const question = (payload as { question?: string })?.question ?? ""
  return (
    <div className="rounded-lg border p-4">
      <p className="text-sm font-medium">{question}</p>
      <textarea
        className="mt-2 w-full rounded border p-2 text-sm"
        value={feedback}
        onChange={(e) => setFeedback(e.target.value)}
      />
      <Button className="mt-2" onClick={() => onRespond(feedback)}>
        Send answer
      </Button>
    </div>
  )
}
```

Confirmed payload shapes (from MastraCode, `mastracode:tui/src/tui/event-dispatch.ts:456-478`):
- `ask_user` → `{question, options?, selectionMode?}`; `resumeData` is a string, or `string[]` for multi-select, `"(skipped)"` for cancel. Render options as buttons when present (`selectionMode` single/multi), free-text otherwise. Secret answers: render `type="password"` when the payload marks the question secret.
- `submit_plan` → `{path}`; `resumeData` `{action: "approved" | "rejected", feedback?}` (MastraCode also passes `path`/`title`/`plan` back on approval — match the installed resumeSchema).

Two main-process additions in `electron/handlers/agent.ts` (fold into Task 4's file while doing this task):
1. In the `ensureSubscribed` queue: when `event.type === "tool_suspended" && event.toolName === "submit_plan"`, read the plan file at `suspendPayload.path` (inside the thread workspace only — reject paths outside it) and attach `planContent` to the broadcast copy.
2. In `respondSuspension`: when the pending suspension is `submit_plan` and `resumeData.action === "approved"`, first `session.state.set({activePlan: {title, plan, approvedAt}})`, then respond — approval auto-switches mode to execute via `transitionsTo` (core handles it: resume happens after the mode switch). When `action === "rejected"`: respond, await it, then `session.abort()` — the MastraCode pattern (`mastracode:tui/src/tui/handlers/prompts.ts:423-434`); `respondToToolSuspension` resolves after the rejection result persists, so aborting there is deterministic and the agent stays in plan mode for the revision message.

- [ ] **Step 4: Render suspension in thread-shell**

Where the message list renders, when `suspension !== null` append `<SuspensionCard toolName={suspension.toolName} payload={suspension.payload} onRespond={(d) => respond(suspension.toolCallId, d)} />`.

- [ ] **Step 5: Full smoke test**

Run: `bun start`
Expected, in a fresh thread:
1. Send "make a demo of https://example.com" → plan-mode reply streams in
2. Agent asks a question → ask_user card appears → answering resumes the run
3. Agent submits plan → approve card → approving flips session to execute mode (visible in next reply)
4. Refresh window mid-run → thread re-hydrates, run continues (no duplicate messages)

- [ ] **Step 6: Commit**

```bash
git add src/components/thread src/hooks/use-active-thread.tsx
git commit -m "feat: thread UI consumes controller events with suspension cards"
```

### Task 7: Delete the hand-rolled harness

**Files:**
- Delete: `electron/agent/orchestrator.ts`, `electron/agent/sessions.ts`, `electron/agent/runs.ts`, `electron/agent/questions.ts`, `electron/agent/tools/ask-user.ts`, `electron/agent/tools/terminal.ts`, `electron/agent/tools/read.ts`, `electron/agent/tools/edit.ts`, `src/lib/ipc-chat-transport.ts`
- Modify: `electron/agent/mastra.ts` (`createDemioAgent` keeps only `present_files` + `synthesize_voiceover` as custom tools; recorder/narrator get Workspace tools in Phase 2 — see Task 11; drop unused imports), `electron/agent/prompts.ts` (remove ask_user + terminal/read/edit tool docs from instructions), any remaining importers `bun run typecheck` flags (expected: `electron/handlers/agent.ts` old imports already gone in Task 4; check `electron/events/` registration for removed `agent:onChunk`/`onEnd`/`onError` event declarations and replace with `onEvent`)

Precondition: Task 3 already moved `buildShimPath()` out of `tools/terminal.ts` into `workspace-factory.ts`. The agent-browser error-text sniffing in `terminal.ts` (misleading exit codes) is NOT lost: `record-scene.ts` talks to agent-browser through `execAgentBrowser` which already parses errors; chat-mode browser exploration through `execute_command` tolerates stringly errors (read-only snapshots, low stakes).

**Interfaces:**
- Consumes: Tasks 4-6 fully replacing every read path of the deleted modules.
- Produces: single conversation code path (controller). `createDemioAgent` survives lean (terminal/read/edit/present_files/voiceover) for Phase 2 recorder/narrator use.

- [ ] **Step 1: Delete files, fix imports**

Run: `git rm` the six files, then `bun run typecheck` and chase every error. The usage/cost pipeline (`usage.ts`, `src/components/thread/message-usage.tsx`) must be rewired to `usage_update` events (extend the Task 5 reducer with a `usage_update` case storing `event.usage`, surface it on the message state) — if the shapes don't line up in one sitting, keep `usage.ts` compiling and file a TODO comment referencing ADR-008, but the app must build.

- [ ] **Step 2: Grep for stragglers**

Run: `grep -rn "onChunk\|reconnect\|ipc-chat-transport\|questions:reply\|ask-user" electron src --include="*.ts" --include="*.tsx"`
Expected: no hits outside comments/CLAUDE-mem files.

- [ ] **Step 3: Smoke test** — repeat Task 6 Step 5 checklist. Expected: identical behavior.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor: delete hand-rolled sessions, replay buffer and ask_user in favor of AgentController"
```

---

## Phase 2 — demo-video workflow (ships: end-to-end generation with per-scene verify+retry)

### Task 8: Scene schemas

**Files:**
- Create: `electron/agent/workflows/schemas.ts`

**Interfaces:**
- Produces (consumed by Tasks 9-13):

```ts
export const sceneSchema, scenePlanSchema, sceneResultSchema, verifyReportSchema
export type Scene, ScenePlan, SceneResult, VerifyReport
```

- [ ] **Step 1: Write schemas**

```ts
// ── Demo workflow schemas ────────────────────────────────────────────────────

import { z } from "zod"

export const sceneSchema = z.object({
  id: z.string().describe("Stable slug, e.g. scene-01"),
  title: z.string(),
  goal: z.string().describe("What this scene demonstrates, one sentence"),
  startUrl: z.string().describe("URL the browser must be on before recording"),
  endUrl: z
    .string()
    .describe("URL prefix expected when the scene completes (continuity contract)"),
  actions: z
    .array(z.string())
    .min(1)
    .describe("Ordered human-readable browser actions for the recorder agent"),
  expectedOutcome: z
    .string()
    .describe("Verifiable end-state assertion, e.g. 'board Demio QA visible with 3 lists'"),
  narrationHint: z.string().describe("Tone/content cue for the voiceover writer"),
  minDurationSec: z.number().default(4),
  maxDurationSec: z.number().default(90),
})
export type Scene = z.infer<typeof sceneSchema>

export const scenePlanSchema = z.object({
  demoTitle: z.string(),
  targetUrl: z.string(),
  scenes: z.array(sceneSchema).min(1).max(12),
})
export type ScenePlan = z.infer<typeof scenePlanSchema>

export const verifyReportSchema = z.object({
  ok: z.boolean(),
  checks: z.array(
    z.object({
      name: z.enum(["video-exists", "duration-range", "actions-ok", "end-url"]),
      ok: z.boolean(),
      detail: z.string(),
    })
  ),
})
export type VerifyReport = z.infer<typeof verifyReportSchema>

export const sceneResultSchema = z.object({
  sceneId: z.string(),
  videoPath: z.string().describe("Absolute path to scene .webm"),
  actionsPath: z.string().describe("Absolute path to actions.jsonl"),
  durationSec: z.number(),
  endUrl: z.string(),
  attempts: z.number(),
  verify: verifyReportSchema,
})
export type SceneResult = z.infer<typeof sceneResultSchema>
```

- [ ] **Step 2: Typecheck + commit**

Run: `bun run typecheck`

```bash
git add electron/agent/workflows/schemas.ts
git commit -m "feat: zod schemas for demo scene plan and verification"
```

### Task 9: Mechanical verifier (TDD)

**Files:**
- Create: `electron/agent/workflows/verify.ts`
- Test: `electron/agent/workflows/verify.test.js`

**Interfaces:**
- Consumes: `Scene`, `VerifyReport` types (Task 8); ffprobe via the ffmpeg-static resolver `resolveFfmpeg` in `electron/lib/ffmpeg.ts` (read it — it exposes the ffmpeg binary path; ffprobe ships alongside or derive via `ffprobe-static`-style sibling; if only ffmpeg is bundled, measure duration with `ffmpeg -i` stderr parse — pick what the lib supports).
- Produces:

```ts
export interface VerifyInput {
  scene: Scene
  videoPath: string
  actionsPath: string
  finalUrl: string
}
export function parseActionsLog(jsonl: string): { total: number; failed: Array<{ line: number; action: string; error: string }> }
export function checkDurationRange(durationSec: number, scene: Scene): { ok: boolean; detail: string }
export function checkEndUrl(finalUrl: string, scene: Scene): { ok: boolean; detail: string }
export async function verifyScene(input: VerifyInput): Promise<VerifyReport>  // orchestrates + fs/ffprobe
```

- [ ] **Step 1: Write failing tests for the pure parts**

```js
// electron/agent/workflows/verify.test.js
const test = require("node:test")
const assert = require("node:assert")
const {
  parseActionsLog,
  checkDurationRange,
  checkEndUrl,
} = require("./verify-pure.cjs")

test("parseActionsLog: all ok", () => {
  const jsonl = [
    JSON.stringify({ tsMs: 0, action: "click", target: "@e1", ok: true }),
    JSON.stringify({ tsMs: 900, action: "type", target: "@e2", ok: true }),
  ].join("\n")
  const r = parseActionsLog(jsonl)
  assert.equal(r.total, 2)
  assert.equal(r.failed.length, 0)
})

test("parseActionsLog: reports failed line with action and error", () => {
  const jsonl = [
    JSON.stringify({ tsMs: 0, action: "click", target: "@e1", ok: true }),
    JSON.stringify({ tsMs: 500, action: "click", target: "@e9", ok: false, error: "not found" }),
  ].join("\n")
  const r = parseActionsLog(jsonl)
  assert.equal(r.failed.length, 1)
  assert.equal(r.failed[0].line, 2)
  assert.match(r.failed[0].error, /not found/)
})

test("parseActionsLog: tolerates blank lines and bad JSON as failures", () => {
  const r = parseActionsLog('{"ok":true,"action":"click","tsMs":0}\n\nnot-json')
  assert.equal(r.total, 2)
  assert.equal(r.failed.length, 1)
})

test("checkDurationRange: inside range passes", () => {
  const scene = { minDurationSec: 4, maxDurationSec: 90 }
  assert.equal(checkDurationRange(30, scene).ok, true)
})

test("checkDurationRange: too short fails with detail", () => {
  const scene = { minDurationSec: 4, maxDurationSec: 90 }
  const r = checkDurationRange(1.2, scene)
  assert.equal(r.ok, false)
  assert.match(r.detail, /1.2/)
})

test("checkEndUrl: prefix match ignoring trailing slash and hash", () => {
  const scene = { endUrl: "https://trello.com/b/abc" }
  assert.equal(checkEndUrl("https://trello.com/b/abc/demio-qa#card-3", scene).ok, true)
  assert.equal(checkEndUrl("https://trello.com/login", scene).ok, false)
})
```

Pure logic lives in `electron/agent/workflows/verify-pure.cjs` (CommonJS so `node --test` runs it without a TS build; `verify.ts` imports it with types via a small `.d.ts` or `createRequire`). If the repo prefers TS-only, alternatively compile-free approach: write pure logic in `verify.ts` and test the transpiled behavior indirectly — but the .cjs split is the zero-config path; take it.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test electron/agent/workflows/verify.test.js`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement `verify-pure.cjs`**

```js
// Pure verification predicates shared by verify.ts. CommonJS so node --test
// runs them directly.
"use strict"

function parseActionsLog(jsonl) {
  const lines = String(jsonl).split("\n").filter((l) => l.trim().length > 0)
  const failed = []
  lines.forEach((line, i) => {
    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      failed.push({ line: i + 1, action: "<unparseable>", error: "invalid JSON" })
      return
    }
    if (entry.ok !== true) {
      failed.push({
        line: i + 1,
        action: entry.action ?? "<unknown>",
        error: entry.error ?? "action reported ok:false",
      })
    }
  })
  return { total: lines.length, failed }
}

function checkDurationRange(durationSec, scene) {
  const min = scene.minDurationSec ?? 4
  const max = scene.maxDurationSec ?? 90
  const ok = durationSec >= min && durationSec <= max
  return {
    ok,
    detail: ok
      ? `duration ${durationSec}s within [${min}, ${max}]`
      : `duration ${durationSec}s outside [${min}, ${max}]`,
  }
}

function normalizeUrl(u) {
  try {
    const url = new URL(u)
    url.hash = ""
    return url.toString().replace(/\/+$/, "")
  } catch {
    return String(u).replace(/\/+$/, "")
  }
}

function checkEndUrl(finalUrl, scene) {
  const actual = normalizeUrl(finalUrl)
  const expected = normalizeUrl(scene.endUrl)
  const ok = actual.startsWith(expected)
  return {
    ok,
    detail: ok
      ? `final url matches ${expected}`
      : `final url ${actual} does not start with ${expected}`,
  }
}

module.exports = { parseActionsLog, checkDurationRange, checkEndUrl }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test electron/agent/workflows/verify.test.js`
Expected: all PASS

- [ ] **Step 5: Implement `verify.ts` orchestration**

```ts
// ── Scene mechanical verifier (ADR-004 Layer 1) ─────────────────────────────

import { promises as fs } from "node:fs"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { createRequire } from "node:module"
import { resolveFfmpeg } from "../../lib/ffmpeg"
import type { Scene, VerifyReport } from "./schemas"

const require = createRequire(import.meta.url)
const pure = require("./verify-pure.cjs") as {
  parseActionsLog: (jsonl: string) => {
    total: number
    failed: Array<{ line: number; action: string; error: string }>
  }
  checkDurationRange: (d: number, s: Pick<Scene, "minDurationSec" | "maxDurationSec">) => { ok: boolean; detail: string }
  checkEndUrl: (u: string, s: Pick<Scene, "endUrl">) => { ok: boolean; detail: string }
}
const execFileAsync = promisify(execFile)

export interface VerifyInput {
  scene: Scene
  videoPath: string
  actionsPath: string
  finalUrl: string
}

async function probeDurationSec(videoPath: string): Promise<number> {
  // ffmpeg -i prints "Duration: HH:MM:SS.cc" to stderr and exits non-zero
  // without an output file — capture stderr regardless of exit code.
  const ffmpeg = resolveFfmpeg()
  let stderr = ""
  try {
    const r = await execFileAsync(ffmpeg, ["-i", videoPath], { encoding: "utf8" })
    stderr = r.stderr
  } catch (err) {
    stderr = (err as { stderr?: string }).stderr ?? ""
  }
  const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/)
  if (!m) throw new Error(`could not read duration from ${videoPath}`)
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])
}

export async function verifyScene(input: VerifyInput): Promise<VerifyReport> {
  const checks: VerifyReport["checks"] = []

  let exists = false
  try {
    const stat = await fs.stat(input.videoPath)
    exists = stat.size > 0
  } catch {
    exists = false
  }
  checks.push({
    name: "video-exists",
    ok: exists,
    detail: exists ? input.videoPath : `missing or empty: ${input.videoPath}`,
  })

  if (exists) {
    const durationSec = await probeDurationSec(input.videoPath)
    const dur = pure.checkDurationRange(durationSec, input.scene)
    checks.push({ name: "duration-range", ok: dur.ok, detail: dur.detail })
  } else {
    checks.push({ name: "duration-range", ok: false, detail: "skipped: no video" })
  }

  let actionsDetail = ""
  let actionsOk = false
  try {
    const jsonl = await fs.readFile(input.actionsPath, "utf8")
    const parsed = pure.parseActionsLog(jsonl)
    actionsOk = parsed.total > 0 && parsed.failed.length === 0
    actionsDetail = actionsOk
      ? `${parsed.total} actions ok`
      : parsed.total === 0
        ? "actions log is empty"
        : parsed.failed
            .map((f) => `line ${f.line}: ${f.action} — ${f.error}`)
            .join("; ")
  } catch {
    actionsDetail = `missing actions log: ${input.actionsPath}`
  }
  checks.push({ name: "actions-ok", ok: actionsOk, detail: actionsDetail })

  const url = pure.checkEndUrl(input.finalUrl, input.scene)
  checks.push({ name: "end-url", ok: url.ok, detail: url.detail })

  return { ok: checks.every((c) => c.ok), checks }
}
```

(Confirm `resolveFfmpeg` name/signature by reading `electron/lib/ffmpeg.ts:25` first; adjust import accordingly. If `import.meta.url` clashes with the electron main bundler config, use `__dirname`-based `createRequire` — match how other electron files resolve assets.)

- [ ] **Step 6: Typecheck + tests + commit**

Run: `bun run typecheck && node --test electron/agent/workflows/verify.test.js`

```bash
git add electron/agent/workflows/verify.ts electron/agent/workflows/verify-pure.cjs electron/agent/workflows/verify.test.js
git commit -m "feat: mechanical scene verifier with node --test coverage"
```

### Task 10: Extract pure voiceover lib

**Files:**
- Create: `electron/agent/lib/voiceover.ts`
- Modify: `electron/agent/tools/voiceover.ts` (delegate to the lib; tool schema/behavior unchanged)

**Interfaces:**
- Consumes: existing ElevenLabs synthesis + ffprobe + mix-command logic currently inside `tools/voiceover.ts` (344 lines — read fully first).
- Produces:

```ts
export interface VoiceSegment { text: string; atSec: number }
export interface SynthesizedVoiceover {
  segmentPaths: string[]
  ffmpegMixArgs: string[]   // args array for the scene mix command
  outputPath: string        // scenes/<sceneId>.voiced.mp4
}
export async function synthesizeSegments(opts: {
  cwd: string
  sceneId: string
  sceneVideoPath: string
  segments: VoiceSegment[]
  voiceId: string
  apiKey: string
  signal?: AbortSignal
}): Promise<SynthesizedVoiceover>
```

- [ ] **Step 1: Move the implementation** — lift the fetch-to-ElevenLabs, per-segment MP3 write, ffprobe duration validation, non-overlap check, and mix-command construction out of the tool's `execute` into `synthesizeSegments`. The tool's `execute` becomes: validate input via its zod schema → call `synthesizeSegments` → format the tool result exactly as before (same fields the prompt documents, including the ready-to-run `ffmpegMixCommand` string built from `ffmpegMixArgs`).

- [ ] **Step 2: Typecheck + smoke** — `bun run typecheck`; if a voice-configured project exists, run one voiceover through chat to confirm identical behavior.

- [ ] **Step 3: Commit**

```bash
git add electron/agent/lib/voiceover.ts electron/agent/tools/voiceover.ts
git commit -m "refactor: extract pure voiceover synthesis lib from tool"
```

### Task 11: Record-scene step with harness-owned recording

**Files:**
- Create: `electron/agent/workflows/record-scene.ts`
- Modify: `electron/agent/prompts.ts` (add `recorderInstructions({ workspace, scene, attempt, previousFailure })` built from the existing recording-phase prompt sections, scoped to ONE scene, minus record start/stop — the harness owns those now)

**Interfaces:**
- Consumes: `execAgentBrowser` from `electron/lib/agent-browser/exec.ts`; `createDemioAgent` (Task 7 lean version); `verifyScene` (Task 9); `Scene`, `SceneResult` (Task 8).
- Produces:

```ts
export async function recordSceneWithRetry(opts: {
  scene: Scene
  workspace: string
  modelId: string
  signal: AbortSignal
  maxAttempts?: number            // default 3
  onProgress?: (update: { sceneId: string; attempt: number; phase: "recording" | "verifying" | "failed" | "done"; detail?: string }) => void
}): Promise<{ status: "done"; result: SceneResult } | { status: "failed"; lastReport: VerifyReport; attempts: number }>
```

- [ ] **Step 1: Write `recorderInstructions` in prompts.ts**

Content: the existing per-scene guidance (snapshot-first locator ladder from `prompts.ts:285-296`, wait --url continuity, anti-patterns) plus:

```
You are recording ONE scene of a product demo. Recording is ALREADY running —
do NOT run `agent-browser record start` or `record stop`, do NOT open a new
page unless an action requires navigation. Perform these actions smoothly and
deliberately in order:
<scene.actions numbered>
Scene goal: <scene.goal>
When every action is complete and the page shows: <scene.expectedOutcome>,
verify the URL starts with <scene.endUrl> using `agent-browser url`, then
reply exactly DONE. If you are irrecoverably stuck, reply exactly
STUCK: <one-line reason>.
```

On retry attempts append: `Previous attempt failed verification: <previousFailure>. Adjust your approach accordingly.`

- [ ] **Step 2: Implement `record-scene.ts`**

```ts
// ── Record-scene step (ADR-003, ADR-005) ────────────────────────────────────
//
// Harness owns the recording lifecycle: open start URL, start recording,
// run the recorder agent for ONE scene, stop recording, mechanically verify.
// Retries with the failure report fed back, max 3 attempts.

import path from "node:path"
import { execAgentBrowser } from "../../lib/agent-browser/exec"
import { createDemioAgent } from "../mastra"
import { verifyScene } from "./verify"
import type { Scene, SceneResult, VerifyReport } from "./schemas"
import { recorderInstructions } from "../prompts"
import log from "../../lib/logger"

const DEFAULT_MAX_ATTEMPTS = 3

async function currentUrl(): Promise<string> {
  const r = await execAgentBrowser(["url"], { timeout: 10_000 })
  return r.ok ? String(r.output).trim() : ""
}

export async function recordSceneWithRetry(opts: {
  scene: Scene
  workspace: string
  modelId: string
  signal: AbortSignal
  maxAttempts?: number
  onProgress?: (u: {
    sceneId: string
    attempt: number
    phase: "recording" | "verifying" | "failed" | "done"
    detail?: string
  }) => void
}): Promise<
  | { status: "done"; result: SceneResult }
  | { status: "failed"; lastReport: VerifyReport; attempts: number }
> {
  const { scene, workspace, modelId, signal } = opts
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
  let lastReport: VerifyReport = { ok: false, checks: [] }
  let previousFailure = ""

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (signal.aborted) break
    const videoPath = path.join(workspace, "scenes", `${scene.id}.webm`)
    const actionsPath = path.join(workspace, "scenes", `${scene.id}.actions.jsonl`)

    opts.onProgress?.({ sceneId: scene.id, attempt, phase: "recording" })

    // 1. Position the browser BEFORE recording so page-load isn't in the video.
    const open = await execAgentBrowser(["open", scene.startUrl], { timeout: 60_000 })
    if (!open.ok) {
      previousFailure = `could not open ${scene.startUrl}: ${open.error}`
      continue
    }

    // 2. Harness starts recording (ADR-005 — agent never touches the lifecycle).
    const rec = await execAgentBrowser(
      ["record", "start", videoPath, "--log-actions", actionsPath],
      { timeout: 30_000 }
    )
    if (!rec.ok) {
      // A stale recording session is the known failure mode — clear and retry.
      await execAgentBrowser(["record", "stop"], { timeout: 15_000 })
      previousFailure = `record start failed: ${rec.error}`
      continue
    }

    // 3. Recorder agent performs the scene's actions via the terminal tool.
    try {
      const recorder = createDemioAgent({
        workspace,
        signal,
        modelId,
        instructionsOverride: recorderInstructions({
          workspace,
          scene,
          attempt,
          previousFailure,
        }),
      })
      await recorder.generate(
        `Record scene ${scene.id}: ${scene.title}`,
        { abortSignal: signal, maxSteps: 30 }
      )
    } finally {
      // 4. Recording ALWAYS stops, agent success or not.
      await execAgentBrowser(["record", "stop"], { timeout: 30_000 })
    }

    // 5. Mechanical verify (ADR-004 Layer 1).
    opts.onProgress?.({ sceneId: scene.id, attempt, phase: "verifying" })
    const finalUrl = await currentUrl()
    lastReport = await verifyScene({ scene, videoPath, actionsPath, finalUrl })

    if (lastReport.ok) {
      const duration = lastReport.checks.find((c) => c.name === "duration-range")
      opts.onProgress?.({ sceneId: scene.id, attempt, phase: "done" })
      return {
        status: "done",
        result: {
          sceneId: scene.id,
          videoPath,
          actionsPath,
          durationSec: Number(duration?.detail.match(/duration ([\d.]+)s/)?.[1] ?? 0),
          endUrl: finalUrl,
          attempts: attempt,
          verify: lastReport,
        },
      }
    }

    previousFailure = lastReport.checks
      .filter((c) => !c.ok)
      .map((c) => `${c.name}: ${c.detail}`)
      .join("; ")
    log.warn(`[demo-workflow] scene ${scene.id} attempt ${attempt} failed: ${previousFailure}`)
    opts.onProgress?.({ sceneId: scene.id, attempt, phase: "failed", detail: previousFailure })
  }

  return { status: "failed", lastReport, attempts: maxAttempts }
}
```

Implementer notes:
- `createDemioAgent` needs an `instructionsOverride?: string` option added in `mastra.ts` (when set, use it instead of `systemPrompt(...)`).
- Recorder tools come from the Workspace primitive (ADR-011): build `createDemioWorkspace(threadId)` and attach its tools to the recorder Agent — reconcile the mechanism against the installed API (either `new Agent({ workspace })` if supported, or `workspace.getTools()` spread into `tools`). Recorder must NOT receive `present_files`/`synthesize_voiceover`; restrict to execute/read/edit tool names via the agent's tool selection (`toolFilter` option on `createDemioAgent`). The narrator agent (Task 12) uses `toolFilter: []` — its inputs are inlined.
- `agent-browser url` subcommand: confirm against `electron/agent/agent-browser-skill.md`; if the actual command differs (e.g. `agent-browser eval location.href` or reading it from `snapshot`), use that — the invariant is a final-URL string for `checkEndUrl`.
- `recorder.generate` call shape (`maxSteps` vs `stopWhen: stepCountIs(30)`) — match the Mastra 1.55 Agent API found in Task 1.
- Duration extraction from the check detail string is deliberate (avoids a second ffprobe); keep formats in sync with `verify-pure.cjs`.

- [ ] **Step 3: Typecheck + commit**

Run: `bun run typecheck`

```bash
git add electron/agent/workflows/record-scene.ts electron/agent/prompts.ts electron/agent/mastra.ts
git commit -m "feat: harness-owned scene recording with verify-retry loop"
```

### Task 12: demo-video workflow + generate_demo tool

**Files:**
- Create: `electron/agent/workflows/demo-video.ts`
- Modify: `electron/agent/mastra.ts` (register workflow + storage on the `mastra` singleton)
- Modify: `electron/agent/controller.ts` (add `generate_demo` tool to execute mode)

**Interfaces:**
- Consumes: `recordSceneWithRetry` (Task 11), `synthesizeSegments` (Task 10), `scenePlanSchema`/`sceneResultSchema` (Task 8), `createDemioAgent` (narrator), `resolveFfmpeg`.
- Produces: workflow id `"demo-video"`; input `{ plan: ScenePlan; workspace: string; modelId: string; voiceId: string | null; elevenLabsKey: string | null }`; output `{ videoPath: string; scenes: SceneResult[] }`; suspends on scene failure with `{ sceneId, failure, attempts }`, resumes with `{ action: "retry" | "skip" | "abort", guidance? }`. Execute-mode tool `generate_demo` runs it and streams progress.

- [ ] **Step 1: Write the workflow**

```ts
// ── demo-video workflow (ADR-001) ───────────────────────────────────────────
//
// plan (input) → foreach scene [record+verify+retry → suspend on exhaustion]
// → narrate (structured) → tts (skipped when no voice) → compose (ffmpeg).

import { createWorkflow, createStep } from "@mastra/core/workflows"
import { promises as fs } from "node:fs"
import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { z } from "zod"
import { scenePlanSchema, sceneResultSchema, sceneSchema } from "./schemas"
import type { Scene, SceneResult } from "./schemas"
import { recordSceneWithRetry } from "./record-scene"
import { synthesizeSegments } from "../lib/voiceover"
import { createDemioAgent } from "../mastra"
import { resolveFfmpeg } from "../../lib/ffmpeg"

const execFileAsync = promisify(execFile)

const inputSchema = z.object({
  plan: scenePlanSchema,
  workspace: z.string(),
  modelId: z.string(),
  voiceId: z.string().nullable(),
  elevenLabsKey: z.string().nullable(),
})

const recordScenesStep = createStep({
  id: "record-scenes",
  inputSchema,
  outputSchema: inputSchema.extend({ results: z.array(sceneResultSchema) }),
  execute: async ({ inputData, suspend, resumeData, writer, abortSignal }) => {
    const results: SceneResult[] = []
    const scenes: Scene[] = inputData.plan.scenes

    for (const scene of scenes) {
      let attemptExhausted = false
      // Loop supports the user-driven "retry" resume choice.
      for (;;) {
        const outcome = await recordSceneWithRetry({
          scene,
          workspace: inputData.workspace,
          modelId: inputData.modelId,
          signal: abortSignal,
          onProgress: (u) =>
            writer?.write({ type: "scene-progress", ...u, of: scenes.length }),
        })
        if (outcome.status === "done") {
          results.push(outcome.result)
          break
        }
        attemptExhausted = true
        const decision = (await suspend({
          suspendSchema: z.object({
            sceneId: z.string(),
            failure: z.string(),
            attempts: z.number(),
          }),
          resumeSchema: z.object({
            action: z.enum(["retry", "skip", "abort"]),
            guidance: z.string().optional(),
          }),
          suspendData: {
            sceneId: scene.id,
            failure: outcome.lastReport.checks
              .filter((c) => !c.ok)
              .map((c) => c.detail)
              .join("; "),
            attempts: outcome.attempts,
          },
        })) as { action: "retry" | "skip" | "abort"; guidance?: string }

        if (decision.action === "abort") throw new Error(`aborted at ${scene.id}`)
        if (decision.action === "skip") break
        // retry: guidance folds into the scene actions for the next attempt
        if (decision.guidance) scene.actions.push(`User guidance: ${decision.guidance}`)
      }
      void attemptExhausted
    }
    return { ...inputData, results }
  },
})

const narrationSegmentsSchema = z.object({
  scenes: z.array(
    z.object({
      sceneId: z.string(),
      segments: z.array(z.object({ text: z.string(), atSec: z.number() })),
    })
  ),
})

const narrateStep = createStep({
  id: "narrate",
  inputSchema: recordScenesStep.outputSchema,
  outputSchema: recordScenesStep.outputSchema.extend({
    narration: narrationSegmentsSchema.nullable(),
  }),
  execute: async ({ inputData, abortSignal }) => {
    if (!inputData.voiceId || !inputData.elevenLabsKey) {
      return { ...inputData, narration: null }
    }
    // Narrator needs no tools — action logs are inlined into the prompt.
    const narrator = createDemioAgent({
      workspace: inputData.workspace,
      signal: abortSignal,
      modelId: inputData.modelId,
      toolFilter: [],
    })
    const actionLogs = await Promise.all(
      inputData.results.map(async (r) => ({
        sceneId: r.sceneId,
        durationSec: r.durationSec,
        actions: await fs.readFile(r.actionsPath, "utf8"),
      }))
    )
    const { object } = await narrator.generate(
      `Write voiceover narration for this demo, ~150 words per minute, 2-6 timed
segments per scene starting no later than durationSec - 2. Demo: ${inputData.plan.demoTitle}.
Scene data (goals, hints, timed action logs):
${JSON.stringify(
  inputData.plan.scenes.map((s) => ({
    sceneId: s.id,
    goal: s.goal,
    narrationHint: s.narrationHint,
    log: actionLogs.find((l) => l.sceneId === s.id),
  })),
  null,
  2
)}`,
      { output: narrationSegmentsSchema, abortSignal }
    )
    return { ...inputData, narration: object }
  },
})

const ttsStep = createStep({
  id: "tts",
  inputSchema: narrateStep.outputSchema,
  outputSchema: narrateStep.outputSchema.extend({
    voicedPaths: z.record(z.string(), z.string()).nullable(),
  }),
  execute: async ({ inputData, abortSignal }) => {
    if (!inputData.narration || !inputData.voiceId || !inputData.elevenLabsKey) {
      return { ...inputData, voicedPaths: null }
    }
    const voicedPaths: Record<string, string> = {}
    for (const sceneNarration of inputData.narration.scenes) {
      const result = inputData.results.find((r) => r.sceneId === sceneNarration.sceneId)
      if (!result) continue
      const synth = await synthesizeSegments({
        cwd: inputData.workspace,
        sceneId: sceneNarration.sceneId,
        sceneVideoPath: result.videoPath,
        segments: sceneNarration.segments,
        voiceId: inputData.voiceId,
        apiKey: inputData.elevenLabsKey,
        signal: abortSignal,
      })
      await execFileAsync(resolveFfmpeg(), synth.ffmpegMixArgs)
      voicedPaths[sceneNarration.sceneId] = synth.outputPath
    }
    return { ...inputData, voicedPaths }
  },
})

const composeStep = createStep({
  id: "compose",
  inputSchema: ttsStep.outputSchema,
  outputSchema: z.object({
    videoPath: z.string(),
    scenes: z.array(sceneResultSchema),
  }),
  execute: async ({ inputData }) => {
    const outDir = path.join(inputData.workspace, "output")
    await fs.mkdir(outDir, { recursive: true })
    const outputPath = path.join(outDir, "demo.mp4")
    const parts = inputData.results.map(
      (r) => inputData.voicedPaths?.[r.sceneId] ?? r.videoPath
    )
    const listPath = path.join(outDir, "concat.txt")
    await fs.writeFile(
      listPath,
      parts.map((p) => `file '${p.replaceAll("'", "'\\''")}'`).join("\n")
    )
    const ffmpeg = resolveFfmpeg()
    const voiced = Boolean(inputData.voicedPaths)
    const args = voiced
      ? ["-y", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", outputPath]
      : ["-y", "-f", "concat", "-safe", "0", "-i", listPath,
         "-c:v", "libx264", "-pix_fmt", "yuv420p", "-r", "30",
         "-movflags", "+faststart", outputPath]
    await execFileAsync(ffmpeg, args)
    return { videoPath: outputPath, scenes: inputData.results }
  },
})

export const demoVideoWorkflow = createWorkflow({
  id: "demo-video",
  inputSchema,
  outputSchema: composeStep.outputSchema,
})
  .then(recordScenesStep)
  .then(narrateStep)
  .then(ttsStep)
  .then(composeStep)
  .commit()
```

Implementer notes (reconcile with installed 1.55 workflow types):
- `execute` context fields (`abortSignal`, `writer`, `resumeData`, `suspend` overload with `suspendData`) — verify names in `node_modules/@mastra/core/dist/workflows/*.d.ts`; the suspend-with-payload call is the load-bearing piece.
- `narrator.generate` structured-output option name (`output` vs `structuredOutput` vs `experimental_output`) — match installed API.
- `void attemptExhausted` guards `noUnusedLocals` if the variable ends up unused after reconciliation — drop it if unneeded.
- Scene-level `foreach` vs manual `for` loop: manual loop is intentional — scenes are sequential (continuity contract) and the retry/suspend interleaving stays readable.

- [ ] **Step 2: Register on mastra singleton** (`electron/agent/mastra.ts`)

```ts
import { LibSQLStore } from "@mastra/libsql"
import { mastraDbPath } from "../store/paths"
import { demoVideoWorkflow } from "./workflows/demo-video"

export const mastra = new Mastra({
  agents: {},
  workflows: { "demo-video": demoVideoWorkflow },
  storage: new LibSQLStore({ id: "demio-storage", url: `file:${mastraDbPath()}` }),
})
```

(Beware circular import: `demo-video.ts` imports `createDemioAgent` from `mastra.ts`. Break it by moving `createDemioAgent` to `electron/agent/demio-agent.ts` and re-exporting from `mastra.ts`, updating importers — controller.ts, record-scene.ts, demo-video.ts, title-generator.ts if applicable.)

- [ ] **Step 3: `generate_demo` tool on execute mode** (`electron/agent/controller.ts`)

```ts
import { createTool } from "@mastra/core/tools"
import { scenePlanSchema } from "./workflows/schemas"
import { mastra } from "./mastra"
import { getDecryptedKey } from "../store/provider-keys"

const generateDemoTool = createTool({
  id: "generate_demo",
  description:
    "Run the approved demo plan through the demo-video pipeline: record every scene, verify, narrate, compose. Call exactly once with the approved plan.",
  inputSchema: z.object({ plan: scenePlanSchema }),
  outputSchema: z.object({ videoPath: z.string() }),
  execute: async ({ context, runtimeContext }) => {
    const { workspace, modelId, projectId } = readSessionMeta(runtimeContext)
    const project = getProject(projectId)
    const voiceId = project?.meta.voiceId ?? null
    const workflow = mastra.getWorkflow("demo-video")
    const run = await workflow.createRun()
    const result = await run.start({
      inputData: {
        plan: context.plan,
        workspace,
        modelId,
        voiceId,
        elevenLabsKey: voiceId ? getDecryptedKey("elevenlabs") : null,
      },
    })
    if (result.status !== "success") {
      throw new Error(`demo-video workflow ${result.status}`)
    }
    return { videoPath: result.result.videoPath }
  },
})
```

Wire it into the execute mode via `additionalTools: { generate_demo: generateDemoTool }`. `readSessionMeta` resolves workspace/modelId/projectId from the tool's runtime context — thread them the same way Task 3 threads `cwd` (session workspace / requestContext). Workflow suspension must surface to the user: subscribe to the run's suspension (via `run.stream()` events or the result `status === "suspended"` path) and re-expose it through the controller's suspension mechanism — if the installed API lets a suspended child workflow bubble through the tool as a controller `tool_suspended` event, use that; otherwise catch `status: "suspended"`, emit a custom `workflow_suspended` event on the controller pubsub, and add `agent.resumeWorkflow(runId, resumeData)` to the handlers mirroring `respondSuspension`. Whichever path: renderer must be able to answer retry/skip/abort.

- [ ] **Step 4: Typecheck + commit**

Run: `bun run typecheck`

```bash
git add electron/agent
git commit -m "feat: demo-video workflow with generate_demo tool on execute mode"
```

### Task 13: Workflow progress card in renderer

**Files:**
- Create: `src/components/thread/workflow-progress.tsx`
- Modify: `src/hooks/use-agent-events.ts` (fold `tool_update`/`scene-progress` payloads into a `workflow` slice)
- Modify: `src/components/thread/thread-shell.tsx` (render card when the `generate_demo` tool part is active)

**Interfaces:**
- Consumes: `tool_update` events carrying the `writer.write({ type: "scene-progress", sceneId, attempt, phase, of })` payloads from Task 12.
- Produces: stage tracker card: per-scene rows (queued / recording (attempt n) / verifying / failed / done), then narrate → tts → compose rows, retry/skip/abort buttons when a workflow suspension arrives.

- [ ] **Step 1: Extend the reducer** — add case `"tool_update"`: when `event.toolName === "generate_demo"` and the payload has `type: "scene-progress"`, merge into `state.workflow: { scenes: Record<sceneId, {phase, attempt}>, of }`. Add the workflow-suspension case from Task 12 Step 3's chosen mechanism.

- [ ] **Step 2: Write the card** — plain list UI matching existing thread components (shadcn primitives): row per scene with status text and attempt badge; a footer row for narrate/tts/compose keyed off the current step id if exposed, else off scene completion. On suspension: three buttons calling `respond`/`resumeWorkflow` with `{action: "retry" | "skip" | "abort"}` plus optional guidance textarea for retry.

- [ ] **Step 3: Typecheck + commit**

```bash
git add src/components/thread src/hooks/use-agent-events.ts
git commit -m "feat: demo workflow stage tracker card"
```

### Task 14: End-to-end verification

**Files:** none (verification only)

- [ ] **Step 1: Full pipeline run**

Run: `bun start`. In a fresh thread with a voice-configured project:
1. "Create a demo of https://demo.playwright.dev/todomvc — add three todos, complete one" 
2. Plan mode explores, may ask_user, submits scene plan → approve
3. Execute mode calls `generate_demo` → progress card shows scene rows advancing with per-attempt status
4. Force a failure (e.g. edit the plan to an endUrl that can't match): verify retry x3 → suspension card → choose skip → pipeline continues
5. Final `output/demo.mp4` presented and playable, voiceover audible, scenes concatenated in order
6. Refresh the window during recording → thread re-hydrates, progress card resumes updating
7. `~/.demio/mastra.db` exists; `sqlite3 ~/.demio/mastra.db ".tables"` shows mastra tables with workflow snapshot rows

- [ ] **Step 2: Regression checklist**

- `bun run typecheck` PASS, `bun run lint` PASS, `node --test electron/agent/workflows/verify.test.js` PASS
- Plain chat (no demo request) still streams normally
- Cancel button aborts a run mid-recording and `agent-browser record stop` fired (no stuck "Recording already active" on next run)

- [ ] **Step 3: Commit any fixes, then final commit**

```bash
git add -A
git commit -m "feat: demio demo generation runs on AgentController + demo-video workflow"
```

---

## Self-Review Notes

- **Spec coverage:** upgrade (Task 1), ADRs (Task 2), controller layer ADR-002/006/007/008 (Tasks 3-7), Workspace-primitive tools ADR-011 (Tasks 3, 7, 11), MastraCode patterns ADR-012 (Tasks 3-6), workflow ADR-001/003 (Tasks 11-12), validation ADR-004 (Task 9), harness-owned recording ADR-005 (Task 11), model policy ADR-009 (constraint, Task 4), streaming ADR-008 (Tasks 4-5, 13), vertical slice ADR-010 (phase ordering). Milestone-2 exclusions stated in Global Constraints.
- **Known-risk reconciliation points** are called out inline (AgentController ctx/tool wiring, suspend payload API, structured-output option name, workflow-suspension bubbling). Each says: verify installed `.d.ts` first, STOP and flag on material drift — not improvise.
- **Type consistency:** `Scene`/`ScenePlan`/`SceneResult`/`VerifyReport` defined once (Task 8) and imported everywhere; `recordSceneWithRetry` signature identical in Tasks 11 and 12; `synthesizeSegments` identical in Tasks 10 and 12.
