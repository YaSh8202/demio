# Rehearsal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce the executable `script` that Phase 1's replay engine consumes — proven off camera, flow by flow, against the live product — plus the credential, checkpoint and Gate B machinery that makes an unattended record pass possible.

**Architecture:** The chat agent's first mode becomes **rehearse**. It owns the conversation, `ask_user`, and Gate B, but it does not walk the product itself: it calls a `rehearse_flow` tool once per flow, and each call runs a fresh, bounded sub-agent that drives agent-browser, proves each step, and **appends that step to `rehearsal/scripts.json` the moment it proves it**. The outer conversation therefore only ever sees compact per-flow summaries, never 70 accessibility snapshots. Durable files under `<workspace>/rehearsal/` carry precision (locators, params, end URLs); the conversation carries understanding. At Gate B the user approves; `toScenesStep` then merges `scripts.json` into the plan's scenes harness-side, and Phase 1's replay engine takes over unchanged.

**Tech Stack:** TypeScript (Electron main), Zod, Mastra `@mastra/core@1.55.0` (`AgentController`, `Agent`, workflows), agent-browser CLI (including its `auth` vault), `node --test`.

**Spec:** `docs/superpowers/plans/2026-08-23-rehearse-record-architecture.md` — read it first. This plan implements **§6–§12**. Phase 1 (`2026-08-24-replay-foundation.md`) implemented §1–5, §13, §15's deterministic half and is already merged to `main`.

## Scope Fence — do NOT do these here

Phase 3 owns narration pacing (spec §14). Nothing in this plan may:

- move `ttsStep` ahead of recording, or reorder the workflow chain in any way
- flip `voiceExpected` off `false` in `demo-video.ts` (it stays `false` — see its comment there)
- consume `narrationAnchor`
- derive a `settleMs` floor from TTS durations
- add post-compose duration/scene-count sanity checks

Each of those is listed under "Known-incomplete after this plan" in the Phase 1 plan and assigned to Phase 3. An implementer who "fixes" one here has broken the phase boundary. If a task seems to require one, stop and report it rather than doing it.

## Global Constraints

- Package manager is **bun**, never npm/npx. Tests: `bun run test:workflows`.
- Style: **no semicolons, double quotes, 2-space indent.** Prettier enforced (`.prettierrc`). Never run a repo-wide `bun run format` — format only the files your task touches.
- Strict TS: `noUnusedLocals`, `noUnusedParameters`, `verbatimModuleSyntax` — use `import type` for type-only imports.
- **Pure logic goes in `.cjs`, tested by `node --test` via `*.test.js`.** Impure orchestration goes in `.ts` and is not unit-tested. Existing pattern: `verify-pure.cjs`/`verify.ts`, `edl-pure.cjs`/`sync.ts`, `replay-pure.cjs`/`replay.ts`. Follow it.
- **Any new `.cjs` under `electron/agent/workflows/` is copied into the bundle automatically** by `copyPureCjs()` in `vite.main.config.ts`, which derives its file list from the directory. Do not add a hardcoded name anywhere. (Phase 1 shipped a boot crash from exactly that — commit `09451ab`.)
- Never import runtime code from `electron/` into `src/`.
- `execAgentBrowser(commands: string[], options?)` takes **ONE FULL COMMAND STRING per array element**. A single element is tokenized; multiple elements become `batch` mode, where `wrapBatchArgs` escapes `\` and `"` but NOT `'`. Bracket-style commands that single-quote their arguments MUST each be issued as their own single-element call.
- `ExecResult` is `{ ok, output, error?, exitCode, durationMs }` (`electron/lib/agent-browser/exec.ts:19`).
- **There is no ffprobe.** `ffmpeg-static` only.
- Typecheck with `bun run typecheck` before every commit.

---

## Decisions taken here, and where they deviate from the spec

Three places where this plan resolves something the spec left open, or deliberately departs from it. All three are recorded so a reviewer can overrule them rather than discover them.

### D1. §7/§8 — a sub-agent per flow, not a controller turn per flow

The spec says rehearsal is a mode of `AgentController` (§7) **and** that "the workflow calls it once per flow" (§8). Those do not compose as written: a controller turn is driven by `session.sendMessage(...)`, which is user-initiated (`electron/handlers/agent.ts:318-347`). There is no supported seam for the harness to inject continuation messages into a live session, and no workflow wraps rehearsal — rehearsal happens *in chat, before* `submit_plan`.

**Resolved:** the mode keeps the conversation, `ask_user` and Gate B. A `rehearse_flow` tool, called once per flow by that mode, runs a **fresh `createDemioAgent` sub-agent** with its own bounded step budget. This is the same shape `narrateStep` and `recoverFromDeviation` already use.

It satisfies §8's actual concern better than a turn boundary would: each flow's snapshots live and die inside one sub-agent's context and never enter the chat thread at all. It also makes §10's resume nearly free — "rewind to the current flow's start" *is* re-invoking `rehearse_flow` for that flow.

The sub-agent has **no `ask_user`**. If it needs something from the user it returns `BLOCKED: <reason>` and the outer mode — which does have `ask_user` — asks, then re-invokes. Credential capture happens entirely in the outer conversation (§12).

### D2. §9 — Observational Memory is deferred, not wired

The spec's §9 config block is valid against the installed version (verified: `ObservationalMemoryOptions` in `node_modules/@mastra/core/dist/memory/types.d.ts:646-770` has `model`, `scope: 'resource' | 'thread'`, `retrieval`, and `observation.instruction`). It is nonetheless **not implemented here**, for two reasons:

1. The only place to put it is `config.agent`'s `Memory` in `controller.ts:446` — which is shared by **every demio chat thread**, not just rehearsal. Enabling it turns on a background Observer/Reflector LLM pair for all conversations.
2. D1 removes the pressure it was answering. The spec's own §9 warns that OM *summarises* and would destroy exact locators; its mitigation was "write each proven step to `scripts.json` immediately", which this plan does regardless. With per-flow sub-agents the outer conversation stays small on its own.

**Trigger to revisit:** a rehearsal conversation that exceeds `lastMessages: 30` worth of useful context across flows — i.e. when the outer agent starts re-deriving things `findings.md` already records.

### D3. §7 — the mode id stays `plan`

The spec names the modes "director/rehearse". The mode's **id** stays `"plan"`; its `name` becomes `"Rehearse"` and its instructions and tools change wholesale.

*Why:* a `Session`'s current mode id is persisted in controller storage, and every session created before this change carries `"plan"`. A controller with no `"plan"` mode would reattach those sessions to a mode that no longer exists. The renderer does not hardcode either id (verified: no `"plan"` / `"rehearse"` literal anywhere under `src/`), so the visible label is free to change while the id is not.

---

## File Structure

| File | Responsibility |
|---|---|
| **Modify** `electron/lib/agent-browser/exec.ts` | Add `stdin?: string` to `ExecOptions` and write it to the child. Without it `--password-stdin` cannot work — the child is spawned with `stdio: ["ignore", ...]`. |
| **Modify** `electron/agent/workflows/script-schema.ts` | Add `params` to `sceneScriptSchema`. |
| **Modify** `electron/agent/workflows/replay-pure.cjs` | Add `resolveParams`; mirror `params` in `normalizeScript`. |
| **Modify** `electron/agent/workflows/record-scene.ts` | Resolve `{{param}}` placeholders **before** the recording bracket opens, so a bad script fails with the camera off. |
| **Create** `electron/agent/workflows/rehearsal-pure.cjs` | Pure artifact logic: merge a proven scene into `scripts.json`, advance the checkpoint, render `findings.md`. |
| **Create** `electron/agent/workflows/rehearsal-pure.test.js` | Unit tests for the above. |
| **Create** `electron/agent/workflows/rehearsal.ts` | The impure half: paths under `<workspace>/rehearsal/`, atomic read/modify/write of the three artifacts. |
| **Create** `electron/agent/workflows/credentials.ts` | Vault profile naming, `auth save --password-stdin`, `auth login`, `auth delete`. |
| **Create** `electron/agent/workflows/rehearse.ts` | `rehearseFlow()` — builds and runs one flow's sub-agent, and the two tools only it gets (`record_scene_script`, `record_finding`). |
| **Modify** `electron/agent/demio-agent.ts` | Add `extraTools` so a sub-agent can be given tools the factory does not know about. |
| **Modify** `electron/agent/prompts.ts` | Add `rehearsalInstructions()` (the sub-agent's prompt). |
| **Modify** `electron/agent/controller.ts` | Rehearse mode: tools, instructions, Gate B contract; credential-profile cleanup on abort/success; `disposeThread` cleanup. |
| **Modify** `electron/agent/workflows/demo-video.ts` | `toScenesStep` merges `rehearsal/scripts.json` into scenes; new `preflightStep` runs the camera-off `auth login`. |
| **Modify** `electron/agent/workflows/schemas.ts` | Delete the dead `minDurationSec`/`maxDurationSec`; correct the stale model-visible `.describe()` text. |
| **Modify** `docs/superpowers/plans/manual-e2e-checklist.md` | Add section F — the rehearse→Gate B→record walkthrough. |

---

### Task 1: stdin for `execAgentBrowser`

**Files:**
- Modify: `electron/lib/agent-browser/exec.ts:33-47` (`ExecOptions`), `exec.ts:170-181` (destructure + `spawn`)

**Interfaces:**
- Consumes: nothing.
- Produces: `ExecOptions.stdin?: string`. Task 6 (`credentials.ts`) is the only consumer.

**Why this is first:** spec §12 requires `auth save … --password-stdin`, which "keeps the password out of command lines, logs and action logs". The child is currently spawned with `stdio: ["ignore", "pipe", "pipe"]` — stdin is `/dev/null`, so the flag fails immediately. Verified against the installed binary:

```
$ ./node_modules/agent-browser/bin/agent-browser-darwin-arm64 auth save demio-probe-test \
    --url https://example.com/login --username probe --password-stdin < /dev/null
✗ Failed to read password from stdin
```

and with stdin actually supplied:

```
$ printf 'hunter2' | ./node_modules/agent-browser/bin/agent-browser-darwin-arm64 auth save demio-probe-test \
    --url https://example.com/login --username probe --password-stdin
✓ Done
$ ./node_modules/agent-browser/bin/agent-browser-darwin-arm64 auth show demio-probe-test
Name: demio-probe-test
URL: https://example.com/login
Username: probe
Created:
$ ./node_modules/agent-browser/bin/agent-browser-darwin-arm64 auth delete demio-probe-test
✓ Done
```

Note `auth show` prints no password — that is what makes the vault an acceptable place for it.

**Testing note (read this before looking for a test file):** `exec.ts` imports `app` from `electron`, so it cannot be loaded by `node --test` or `bun` outside the Electron main process. It is impure orchestration and follows the project's no-unit-test rule for `.ts`. Its real verification is Task 11's live probe and manual-checklist section F. Do not invent a mock-electron harness for it.

- [ ] **Step 1: Add the option**

In `electron/lib/agent-browser/exec.ts`, inside `ExecOptions`, after `onStderr`:

```ts
  /**
   * Text written to the child's stdin, which is then closed.
   *
   * The default (`undefined`) keeps stdin at `"ignore"` — i.e. /dev/null —
   * which is what every command except the auth vault wants. `auth save
   * --password-stdin` is the one caller that needs a real pipe: it is how a
   * password reaches the vault without ever appearing in argv, in a process
   * listing, in demio's logs, or in an agent-browser action log.
   *
   * An empty string is meaningful (it writes nothing and closes), so this is
   * checked with `!== undefined`, never for truthiness.
   */
  stdin?: string
```

- [ ] **Step 2: Wire it into the spawn**

Change the destructure at `exec.ts:170`:

```ts
  const { timeout = 30_000, onStdout, onStderr, stdin } = options
```

and the `spawn` call:

```ts
    const child = spawn(binPath, argv, {
      stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      // Ensure the child inherits PATH for Chrome discovery
      env: { ...process.env },
    })

    if (stdin !== undefined) {
      // A child that exits before reading (bad flags, unknown subcommand)
      // makes this write EPIPE. Unhandled, that is an uncaught error event
      // on a stream in the Electron MAIN process — it takes the whole app
      // down. Swallow it: the real failure is already on its way to us as a
      // non-zero exit code plus stderr, which is what the caller reads.
      child.stdin?.on("error", () => {})
      child.stdin?.end(stdin)
    }
```

- [ ] **Step 3: Typecheck**

Run: `bun run typecheck`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add electron/lib/agent-browser/exec.ts
git commit -m "feat: allow execAgentBrowser callers to supply stdin"
```

---

### Task 2: Script parameters

**Files:**
- Modify: `electron/agent/workflows/script-schema.ts:36-56` (`sceneScriptSchema`)
- Modify: `electron/agent/workflows/replay-pure.cjs:14-32` (`normalizeScript`), plus a new `resolveParams` and its export
- Modify: `electron/agent/workflows/record-scene.ts:185-196` (the `if (!script)` guard)
- Test: `electron/agent/workflows/replay-pure.test.js`

**Interfaces:**
- Consumes: `SceneScript` from `script-schema.ts` (unchanged apart from the new field).
- Produces:
  - `sceneScriptSchema` gains `params: Record<string, string>` (defaulted `{}`).
  - `replay-pure.cjs` exports `resolveParams(script: SceneScript): SceneScript` — returns a new script with every `{{name}}` in each action's `cmd` and `assert` replaced by `script.params[name]`. Throws `Error` naming the script, the action index and the key when a placeholder has no value. Task 5's rehearsal prompt is what teaches the model to write `params`.

**Why:** spec §11. Rehearsal must actually click Create to prove a flow works, so every write flow runs twice — once in rehearsal, once on camera. Parameterising the *data* is what stops the second run colliding with the first ("a board named Demio QA already exists"). Rehearsal proves the flow's shape with one value and writes a different value here for the record pass.

- [ ] **Step 1: Write the failing tests**

Append to `electron/agent/workflows/replay-pure.test.js`:

```js
test("resolveParams: substitutes in cmd and assert", () => {
  const out = resolveParams({
    sceneId: "scene-01",
    continuity: "independent",
    oneShot: false,
    startUrl: "https://example.com",
    endUrl: "https://example.com/b",
    params: { boardName: "Demio QA" },
    actions: [
      {
        cmd: 'find role textbox --name "Board title" fill "{{boardName}}"',
        assert: '--text "{{boardName}}"',
        settleMs: 400,
      },
    ],
  })
  assert.equal(
    out.actions[0].cmd,
    'find role textbox --name "Board title" fill "Demio QA"'
  )
  assert.equal(out.actions[0].assert, '--text "Demio QA"')
})

test("resolveParams: a script with no placeholders is returned unchanged", () => {
  const script = {
    sceneId: "scene-01",
    continuity: "independent",
    oneShot: false,
    startUrl: "https://example.com",
    endUrl: "https://example.com/b",
    params: {},
    actions: [{ cmd: "click @e1", settleMs: 600 }],
  }
  const out = resolveParams(script)
  assert.equal(out.actions[0].cmd, "click @e1")
  assert.equal(out.actions[0].assert, undefined)
})

test("resolveParams: an unresolved placeholder throws, naming scene, index and key", () => {
  assert.throws(
    () =>
      resolveParams({
        sceneId: "scene-07",
        continuity: "independent",
        oneShot: false,
        startUrl: "u",
        endUrl: "u",
        params: { other: "x" },
        actions: [{ cmd: "type {{boardName}}", settleMs: 600 }],
      }),
    /scene-07.*action 0.*boardName/
  )
})

test("resolveParams: a value containing braces is not re-expanded", () => {
  const out = resolveParams({
    sceneId: "scene-01",
    continuity: "independent",
    oneShot: false,
    startUrl: "u",
    endUrl: "u",
    params: { a: "{{b}}", b: "SHOULD NOT APPEAR" },
    actions: [{ cmd: "type {{a}}", settleMs: 600 }],
  })
  assert.equal(out.actions[0].cmd, "type {{b}}")
})

test("normalizeScript: params default to an empty object", () => {
  const s = normalizeScript({
    sceneId: "scene-01",
    startUrl: "https://example.com",
    endUrl: "https://example.com/done",
    actions: [{ cmd: "click @e1" }],
  })
  assert.deepEqual(s.params, {})
})
```

`resolveParams` must be reachable from the test file. The existing file requires the pure module at the top; add `resolveParams` to whatever binding style is already there (a destructure or a `pure.` namespace object) — do not restructure the file to suit these tests.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run test:workflows`
Expected: FAIL — `resolveParams is not a function`.

- [ ] **Step 3: Add `params` to the zod schema**

In `electron/agent/workflows/script-schema.ts`, inside `sceneScriptSchema`, between `endUrl` and `actions`:

```ts
  params: z
    .record(z.string(), z.string())
    .default({})
    .describe(
      "Values for the `{{name}}` placeholders in this script's commands. " +
        "Rehearsal proves a flow with one set of values and writes a DIFFERENT " +
        "set here for the record pass, so a write flow is never run twice with " +
        "the same data. Keys are bare identifiers: `{{boardName}}`, not " +
        "`{{ boardName }}`."
    ),
```

- [ ] **Step 4: Implement in the pure module**

In `electron/agent/workflows/replay-pure.cjs`, add `params` to `normalizeScript`'s returned object, between `endUrl` and `actions`:

```js
    params:
      raw.params && typeof raw.params === "object" ? { ...raw.params } : {},
```

Then add, after `normalizeScript`:

```js
/**
 * Placeholder syntax: `{{name}}`, bare identifier, no inner spaces. Kept
 * deliberately narrow so a literal `{{` in a command (rare, but legal in a
 * search box) cannot be mistaken for a placeholder unless it names a valid
 * identifier.
 */
const PARAM_RE = /\{\{([A-Za-z0-9_]+)\}\}/g

/**
 * Substitute `{{name}}` placeholders from `script.params` (spec §11).
 *
 * Single-pass: a param VALUE containing `{{...}}` is left alone rather than
 * re-expanded. `String.replace` with a function already gives this — the
 * property is asserted by a test so a later rewrite cannot lose it.
 *
 * Throws on an unresolved placeholder rather than leaving it in the command.
 * A literal `{{boardName}}` typed into a form field is a silent wrong take:
 * every assertion could still pass while the video shows nonsense.
 */
function resolveParams(script) {
  const params = script.params || {}
  const substitute = (value, where) =>
    value.replace(PARAM_RE, (_whole, key) => {
      if (!Object.prototype.hasOwnProperty.call(params, key)) {
        throw new Error(
          `script ${script.sceneId}: ${where} references {{${key}}}, ` +
            `but the script defines no param by that name`
        )
      }
      return params[key]
    })
  return {
    ...script,
    actions: script.actions.map((a, i) => ({
      ...a,
      cmd: substitute(a.cmd, `action ${i} cmd`),
      assert:
        a.assert === undefined
          ? undefined
          : substitute(a.assert, `action ${i} assert`),
    })),
  }
}
```

and add `resolveParams` to `module.exports`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun run test:workflows`
Expected: PASS, with every previously-passing test still green.

- [ ] **Step 6: Resolve params in the record path, camera off**

In `electron/agent/workflows/record-scene.ts`, extend the `pure` require's type at the top:

```ts
const pure = require("./replay-pure.cjs") as {
  recordingBracket: (o: {
    script: SceneScript
    videoPath: string
    actionsPath: string
    isRetry: boolean
  }) => { commands: string[]; resetsPage: boolean }
  resolveParams: (script: SceneScript) => SceneScript
}
```

Then replace the existing `const script = scene.script` / `if (!script)` block with:

```ts
    const rawScript = scene.script
    if (!rawScript) {
      // A scene without a script cannot be recorded. Rehearsal produces it;
      // `toScenesStep` merges it in. Fail loudly rather than silently
      // falling back to the deleted recorder agent.
      return {
        status: "failed",
        lastReport: infraFailureReport(
          `scene ${scene.id} has no script — the record pass requires one`
        ),
        attempts: attemptsMade,
      }
    }

    // Resolved BEFORE the recording bracket opens, so a script that names a
    // param it never defines fails with the camera off. Treated as a failed
    // take (matching the no-script case above) rather than thrown: it
    // surfaces on the suspension card where the user can read it, and the
    // wasted work is one loop iteration, not a killed run.
    let script: SceneScript
    try {
      script = pure.resolveParams(rawScript)
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      return {
        status: "failed",
        lastReport: infraFailureReport(detail),
        attempts: attemptsMade,
      }
    }
```

- [ ] **Step 7: Typecheck**

Run: `bun run typecheck`
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add electron/agent/workflows/script-schema.ts \
        electron/agent/workflows/replay-pure.cjs \
        electron/agent/workflows/replay-pure.test.js \
        electron/agent/workflows/record-scene.ts
git commit -m "feat: parameterised script data so a write flow is not run twice identically"
```

---

### Task 3: Rehearsal artifact logic (pure)

**Files:**
- Create: `electron/agent/workflows/rehearsal-pure.cjs`
- Create: `electron/agent/workflows/rehearsal-pure.test.js`

**Interfaces:**
- Consumes: nothing (no imports — `node --test` loads this file directly).
- Produces, all exported from `rehearsal-pure.cjs`:
  - `REHEARSAL_VERSION = 1`
  - `emptyScripts(): ScriptsDoc` where `ScriptsDoc = { version: number, scripts: SceneScript[] }`
  - `mergeScript(doc: ScriptsDoc, script: SceneScript): ScriptsDoc` — replace-by-`sceneId` in place, else append.
  - `dropFlowScripts(doc: ScriptsDoc, flowId: string): ScriptsDoc` — remove every script belonging to one flow, so a re-run of that flow cannot leave orphans behind.
  - `emptyCheckpoint(): CheckpointDoc` where `CheckpointDoc = { version: number, flows: FlowEntry[] }` and `FlowEntry = { id: string, label: string, startUrl: string, status: "in-progress" | "done" | "blocked", sceneIds: string[], detail: string }`
  - `beginFlow(doc, { id, label, startUrl }): CheckpointDoc`
  - `finishFlow(doc, { id, status, sceneIds, detail }): CheckpointDoc`
  - `inProgressFlow(doc): FlowEntry | null`
  - `FINDING_KINDS: string[]` and `appendFinding(markdown: string, { flowId, kind, text }): string`

Task 4 wraps every one of these in file I/O; nothing else imports this module.

**Why a checkpoint at all:** spec §10. On an app restart the browser is *guaranteed* gone (`cleanupStaleSessions()` runs `close --all` at app start — `daemon.ts:18-32`), so the in-progress flow must rewind to its own start. That requires the checkpoint to record **which flow is in progress and its start URL**, not merely which flows are done.

**Scene id convention — load-bearing, do not change it:** a flow id is a kebab-case slug matching `^[a-z0-9-]+$`, and each scene it produces is `<flowId>.NN` (`create-board.01`, `create-board.02`). The `.` is legal under `SAFE_SCENE_ID` (`demo-video.ts:86`) and cannot appear in a kebab slug, which is what makes `dropFlowScripts`'s prefix test unambiguous — a plain `-` separator would make `create-board` match `create-board-list.01` and silently delete another flow's work.

**Deviation to note in the commit message:** the spec's §10 table lists `findings.md` only. This task keeps it as the single findings artifact — appended as markdown, no JSON twin — so there is exactly one source of truth for a human-readable file. `appendFinding` is what makes that testable.

- [ ] **Step 1: Write the failing tests**

Create `electron/agent/workflows/rehearsal-pure.test.js`:

```js
const test = require("node:test")
const assert = require("node:assert")
const {
  emptyScripts,
  mergeScript,
  dropFlowScripts,
  emptyCheckpoint,
  beginFlow,
  finishFlow,
  inProgressFlow,
  appendFinding,
} = require("./rehearsal-pure.cjs")

const script = (sceneId) => ({
  sceneId,
  continuity: "independent",
  oneShot: false,
  startUrl: "https://example.com",
  endUrl: "https://example.com/done",
  params: {},
  actions: [{ cmd: "click @e1", settleMs: 600 }],
})

test("mergeScript: appends a new scene", () => {
  const doc = mergeScript(emptyScripts(), script("scene-01"))
  assert.equal(doc.version, 1)
  assert.deepEqual(
    doc.scripts.map((s) => s.sceneId),
    ["scene-01"]
  )
})

test("mergeScript: replaces an existing scene in place, preserving order", () => {
  let doc = emptyScripts()
  doc = mergeScript(doc, script("scene-01"))
  doc = mergeScript(doc, script("scene-02"))
  const revised = { ...script("scene-01"), endUrl: "https://example.com/v2" }
  doc = mergeScript(doc, revised)
  assert.deepEqual(
    doc.scripts.map((s) => s.sceneId),
    ["scene-01", "scene-02"]
  )
  assert.equal(doc.scripts[0].endUrl, "https://example.com/v2")
})

test("mergeScript: does not mutate the input document", () => {
  const before = mergeScript(emptyScripts(), script("scene-01"))
  const snapshot = JSON.stringify(before)
  mergeScript(before, script("scene-02"))
  assert.equal(JSON.stringify(before), snapshot)
})

test("dropFlowScripts: removes only that flow's scenes", () => {
  let doc = emptyScripts()
  doc = mergeScript(doc, script("create-board.01"))
  doc = mergeScript(doc, script("create-board.02"))
  doc = mergeScript(doc, script("invite-teammate.01"))
  const out = dropFlowScripts(doc, "create-board")
  assert.deepEqual(
    out.scripts.map((s) => s.sceneId),
    ["invite-teammate.01"]
  )
})

test("dropFlowScripts: a flow id that prefixes another does not delete it", () => {
  let doc = emptyScripts()
  doc = mergeScript(doc, script("create-board.01"))
  doc = mergeScript(doc, script("create-board-list.01"))
  const out = dropFlowScripts(doc, "create-board")
  assert.deepEqual(
    out.scripts.map((s) => s.sceneId),
    ["create-board-list.01"]
  )
})

test("beginFlow: records the in-progress flow and its start URL", () => {
  const doc = beginFlow(emptyCheckpoint(), {
    id: "flow-01",
    label: "Create a board",
    startUrl: "https://app.x.com/boards",
  })
  const flow = inProgressFlow(doc)
  assert.equal(flow.id, "flow-01")
  assert.equal(flow.startUrl, "https://app.x.com/boards")
  assert.equal(flow.status, "in-progress")
})

test("beginFlow: re-beginning the same flow updates it rather than duplicating", () => {
  let doc = beginFlow(emptyCheckpoint(), {
    id: "flow-01",
    label: "Create a board",
    startUrl: "https://app.x.com/boards",
  })
  doc = beginFlow(doc, {
    id: "flow-01",
    label: "Create a board",
    startUrl: "https://app.x.com/boards?v=2",
  })
  assert.equal(doc.flows.length, 1)
  assert.equal(doc.flows[0].startUrl, "https://app.x.com/boards?v=2")
})

test("finishFlow: marks done and records the scenes it produced", () => {
  let doc = beginFlow(emptyCheckpoint(), {
    id: "flow-01",
    label: "Create a board",
    startUrl: "https://app.x.com/boards",
  })
  doc = finishFlow(doc, {
    id: "flow-01",
    status: "done",
    sceneIds: ["scene-01", "scene-02"],
    detail: "",
  })
  assert.equal(doc.flows[0].status, "done")
  assert.deepEqual(doc.flows[0].sceneIds, ["scene-01", "scene-02"])
  assert.equal(inProgressFlow(doc), null)
})

test("finishFlow: a blocked flow keeps its reason and is not in progress", () => {
  let doc = beginFlow(emptyCheckpoint(), {
    id: "flow-02",
    label: "Invite a teammate",
    startUrl: "https://app.x.com/settings",
  })
  doc = finishFlow(doc, {
    id: "flow-02",
    status: "blocked",
    sceneIds: [],
    detail: "needs a second seat on the plan",
  })
  assert.equal(doc.flows[0].status, "blocked")
  assert.match(doc.flows[0].detail, /second seat/)
  assert.equal(inProgressFlow(doc), null)
})

test("finishFlow: an unknown flow id throws rather than inventing an entry", () => {
  assert.throws(
    () =>
      finishFlow(emptyCheckpoint(), {
        id: "flow-99",
        status: "done",
        sceneIds: [],
        detail: "",
      }),
    /flow-99/
  )
})

test("appendFinding: creates the file body and the flow's section", () => {
  const md = appendFinding("", {
    flowId: "flow-01",
    kind: "selector",
    text: 'two "Create" buttons; used role button --name "Create board" --exact',
  })
  assert.match(md, /^# Rehearsal findings/)
  assert.match(md, /## flow-01/)
  assert.match(md, /- \*\*selector:\*\* two "Create" buttons/)
})

test("appendFinding: a second finding for the same flow reuses the section", () => {
  let md = appendFinding("", {
    flowId: "flow-01",
    kind: "selector",
    text: "first",
  })
  md = appendFinding(md, { flowId: "flow-01", kind: "wait", text: "second" })
  assert.equal(md.match(/## flow-01/g).length, 1)
  assert.ok(md.indexOf("first") < md.indexOf("second"))
})

test("appendFinding: a new flow gets its own section at the end", () => {
  let md = appendFinding("", { flowId: "flow-01", kind: "note", text: "a" })
  md = appendFinding(md, { flowId: "flow-02", kind: "note", text: "b" })
  assert.ok(md.indexOf("## flow-01") < md.indexOf("## flow-02"))
})

test("appendFinding: an earlier flow's finding lands in its own section, not the last one", () => {
  let md = appendFinding("", { flowId: "flow-01", kind: "note", text: "a" })
  md = appendFinding(md, { flowId: "flow-02", kind: "note", text: "b" })
  md = appendFinding(md, {
    flowId: "flow-01",
    kind: "state-created",
    text: "board Demio QA",
  })
  assert.ok(md.indexOf("board Demio QA") < md.indexOf("## flow-02"))
})

test("appendFinding: an unknown kind throws", () => {
  assert.throws(
    () => appendFinding("", { flowId: "f", kind: "vibes", text: "x" }),
    /vibes/
  )
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run test:workflows`
Expected: FAIL — `Cannot find module './rehearsal-pure.cjs'`.

- [ ] **Step 3: Implement the module**

Create `electron/agent/workflows/rehearsal-pure.cjs`:

```js
// Pure rehearsal-artifact logic. CommonJS so `node --test` runs it with zero
// build step (same pattern as replay-pure.cjs / verify-pure.cjs / edl-pure.cjs).
// No I/O — rehearsal.ts owns every read and write.
//
// Every function here is non-mutating: it returns a new document. The store
// reads a file, calls one of these, and writes the result back, so an
// accidental in-place edit would silently skip the write.
"use strict"

const REHEARSAL_VERSION = 1

// ── scripts ─────────────────────────────────────────────────────────────────

function emptyScripts() {
  return { version: REHEARSAL_VERSION, scripts: [] }
}

/**
 * Add one proven scene script, replacing any earlier entry for the same
 * sceneId **in place** so scene order stays the order rehearsal proved them
 * in — that order is what `toScenesStep` and the concat rely on.
 *
 * Called once per proven scene, never batched: Observational Memory (if it is
 * ever enabled) summarises, and a summary destroys an exact locator. The
 * files hold precision; the conversation holds understanding. See spec §9.
 */
function mergeScript(doc, script) {
  const scripts = doc.scripts.slice()
  const at = scripts.findIndex((s) => s.sceneId === script.sceneId)
  if (at === -1) scripts.push(script)
  else scripts[at] = script
  return { version: REHEARSAL_VERSION, scripts }
}

/**
 * Remove every script belonging to one flow.
 *
 * Called before a flow is re-rehearsed (a resumed run, or a revision after
 * Gate B): the second attempt may produce FEWER scenes than the first, and
 * `mergeScript` alone would leave the extra ones behind as orphans that
 * `toScenesStep` would happily record.
 *
 * The `.` separator is what makes this safe: scene ids are `<flowId>.NN` and
 * a flow id is kebab-case, so `create-board.` cannot prefix-match
 * `create-board-list.01`.
 */
function dropFlowScripts(doc, flowId) {
  const prefix = `${flowId}.`
  return {
    version: REHEARSAL_VERSION,
    scripts: doc.scripts.filter((s) => !s.sceneId.startsWith(prefix)),
  }
}

// ── checkpoint ──────────────────────────────────────────────────────────────

function emptyCheckpoint() {
  return { version: REHEARSAL_VERSION, flows: [] }
}

/**
 * Mark a flow as the one currently being rehearsed.
 *
 * `startUrl` is the load-bearing field: on an app restart the browser is
 * guaranteed gone (`cleanupStaleSessions()` runs `close --all` at app start,
 * daemon.ts:18-32), so resuming means re-opening exactly this URL and
 * replaying the flow from its start. Recording only which flows are *done*
 * would leave nowhere to rewind to. See spec §10.
 */
function beginFlow(doc, { id, label, startUrl }) {
  const flows = doc.flows.slice()
  const entry = {
    id,
    label,
    startUrl,
    status: "in-progress",
    sceneIds: [],
    detail: "",
  }
  const at = flows.findIndex((f) => f.id === id)
  if (at === -1) flows.push(entry)
  else flows[at] = { ...flows[at], ...entry }
  return { version: REHEARSAL_VERSION, flows }
}

function finishFlow(doc, { id, status, sceneIds, detail }) {
  const flows = doc.flows.slice()
  const at = flows.findIndex((f) => f.id === id)
  if (at === -1) {
    // Never invent an entry: a finish with no matching begin means the caller
    // lost track of the flow, and silently appending would hide that while
    // producing a checkpoint with no startUrl to rewind to.
    throw new Error(`finishFlow: no flow "${id}" was ever begun`)
  }
  flows[at] = { ...flows[at], status, sceneIds, detail }
  return { version: REHEARSAL_VERSION, flows }
}

/** The flow to rewind to on resume, or null when rehearsal is between flows. */
function inProgressFlow(doc) {
  return doc.flows.find((f) => f.status === "in-progress") || null
}

// ── findings ────────────────────────────────────────────────────────────────

/**
 * Closed set on purpose. Gate B has to be able to find the blockers and the
 * state rehearsal left behind (spec §11.2) without reading prose, and a free
 * text kind would make that a search problem.
 */
const FINDING_KINDS = ["selector", "wait", "blocker", "state-created", "note"]

const FINDINGS_TITLE = "# Rehearsal findings"

/**
 * Append one finding under its flow's section, creating the section (and the
 * document) when needed. Returns the new markdown.
 *
 * A finding for an EARLIER flow lands in that flow's section rather than at
 * the end of the file — rehearsal often learns something about flow 1 while
 * walking flow 3 ("this is the banner that blocked us earlier").
 */
function appendFinding(markdown, { flowId, kind, text }) {
  if (!FINDING_KINDS.includes(kind)) {
    throw new Error(
      `appendFinding: unknown kind "${kind}" — expected one of ${FINDING_KINDS.join(", ")}`
    )
  }
  const bullet = `- **${kind}:** ${text}`
  const heading = `## ${flowId}`
  const base =
    markdown && markdown.trim() ? markdown.replace(/\s+$/, "") : FINDINGS_TITLE
  const lines = base.split("\n")
  const at = lines.indexOf(heading)
  if (at === -1) {
    return [...lines, "", heading, "", bullet, ""].join("\n")
  }
  // End of this section = the next `## ` heading, or end of file.
  let end = lines.length
  for (let i = at + 1; i < lines.length; i++) {
    if (lines[i].startsWith("## ")) {
      end = i
      break
    }
  }
  // Insert before the section's trailing blank lines, so the blank separating
  // this section from the next one survives.
  let insert = end
  while (insert > at + 1 && lines[insert - 1].trim() === "") insert--
  return [...lines.slice(0, insert), bullet, ...lines.slice(insert)].join("\n")
}

module.exports = {
  REHEARSAL_VERSION,
  emptyScripts,
  mergeScript,
  dropFlowScripts,
  emptyCheckpoint,
  beginFlow,
  finishFlow,
  inProgressFlow,
  FINDING_KINDS,
  appendFinding,
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run test:workflows`
Expected: PASS — every test in this file plus all pre-existing ones.

- [ ] **Step 5: Commit**

```bash
git add electron/agent/workflows/rehearsal-pure.cjs \
        electron/agent/workflows/rehearsal-pure.test.js
git commit -m "feat: pure rehearsal artifact logic — scripts, checkpoint, findings"
```

---

### Task 4: The rehearsal store

**Files:**
- Create: `electron/agent/workflows/rehearsal.ts`

**Interfaces:**
- Consumes: `rehearsal-pure.cjs` (Task 3, via `createRequire` — same pattern as `record-scene.ts:30-38`); `SceneScript` from `./script-schema`.
- Produces, all exported from `rehearsal.ts`:
  - `REHEARSAL_DIR = "rehearsal"`
  - `rehearsalPaths(workspace: string): { dir, scripts, findings, checkpoint, screenshots }` — all absolute.
  - `ensureRehearsalDirs(workspace: string): Promise<void>`
  - `readScripts(workspace): Promise<{ version: number; scripts: SceneScript[] }>`
  - `recordScript(workspace, script: SceneScript): Promise<void>`
  - `dropFlowScripts(workspace, flowId: string): Promise<void>`
  - `readCheckpoint(workspace): Promise<CheckpointDoc>` and `inProgressFlow(workspace): Promise<FlowEntry | null>`
  - `beginFlow(workspace, { id, label, startUrl }): Promise<void>`
  - `finishFlow(workspace, { id, status, sceneIds, detail }): Promise<void>`
  - `recordFinding(workspace, { flowId, kind, text }): Promise<void>`
  - `readFindings(workspace): Promise<string>`
  - `FindingKind` and `FlowStatus` type aliases.

  Task 5's sub-agent tools call `recordScript` / `recordFinding`, and its `rehearseFlow` calls `beginFlow` / `finishFlow` / `inProgressFlow` / `dropFlowScripts`; Task 8's mode instructions point the model at `checkpoint.json` and `findings.md`; Task 9's `toScenesStep` calls `readScripts`.

- [ ] **Step 1: Write the module**

Create `electron/agent/workflows/rehearsal.ts`:

```ts
// ── Rehearsal artifact store ────────────────────────────────────────────────
//
// The impure half of rehearsal's persistence: paths, reads, atomic writes.
// Every decision about document SHAPE lives in `rehearsal-pure.cjs` and is
// unit-tested there; this file only moves bytes.
//
// Four artifacts under `<workspace>/rehearsal/` (spec §10):
//   scripts.json   — executable steps, appended per scene as proven
//   findings.md    — ambiguous selectors, required waits, blockers, state created
//   checkpoint.json— which flows are done, and which one is mid-flight
//   screenshots/   — per-step, for human review and a future vision judge

import path from "node:path"
import { promises as fs } from "node:fs"
import { createRequire } from "node:module"
import type { SceneScript } from "./script-schema"

const require = createRequire(import.meta.url)

export type FlowStatus = "in-progress" | "done" | "blocked"
export type FindingKind =
  | "selector"
  | "wait"
  | "blocker"
  | "state-created"
  | "note"

export interface FlowEntry {
  id: string
  label: string
  startUrl: string
  status: FlowStatus
  sceneIds: string[]
  detail: string
}
export interface ScriptsDoc {
  version: number
  scripts: SceneScript[]
}
export interface CheckpointDoc {
  version: number
  flows: FlowEntry[]
}

const pure = require("./rehearsal-pure.cjs") as {
  emptyScripts: () => ScriptsDoc
  mergeScript: (doc: ScriptsDoc, script: SceneScript) => ScriptsDoc
  dropFlowScripts: (doc: ScriptsDoc, flowId: string) => ScriptsDoc
  emptyCheckpoint: () => CheckpointDoc
  beginFlow: (
    doc: CheckpointDoc,
    f: { id: string; label: string; startUrl: string }
  ) => CheckpointDoc
  finishFlow: (
    doc: CheckpointDoc,
    f: {
      id: string
      status: FlowStatus
      sceneIds: string[]
      detail: string
    }
  ) => CheckpointDoc
  inProgressFlow: (doc: CheckpointDoc) => FlowEntry | null
  FINDING_KINDS: string[]
  appendFinding: (
    markdown: string,
    e: { flowId: string; kind: FindingKind; text: string }
  ) => string
}

export const REHEARSAL_DIR = "rehearsal"

export function rehearsalPaths(workspace: string) {
  const dir = path.join(workspace, REHEARSAL_DIR)
  return {
    dir,
    scripts: path.join(dir, "scripts.json"),
    findings: path.join(dir, "findings.md"),
    checkpoint: path.join(dir, "checkpoint.json"),
    screenshots: path.join(dir, "screenshots"),
  }
}

export async function ensureRehearsalDirs(workspace: string): Promise<void> {
  const p = rehearsalPaths(workspace)
  await fs.mkdir(p.screenshots, { recursive: true })
}

/**
 * Serialize every read-modify-write against one workspace.
 *
 * The sub-agent's tools are awaited one at a time inside a single agent loop,
 * so interleaving is not expected — but two `rehearse_flow` calls in flight at
 * once (a model that ignores the one-flow-at-a-time instruction) would
 * otherwise race, and the loser's write silently wins. A promise chain per
 * workspace costs nothing and removes the class.
 *
 * In-process only: this is the Electron main process and there is exactly one.
 */
const writeChains = new Map<string, Promise<unknown>>()

function serialize<T>(workspace: string, fn: () => Promise<T>): Promise<T> {
  const prev = writeChains.get(workspace) ?? Promise.resolve()
  // `.catch` on the CHAIN, not the caller's promise: one failed write must not
  // poison every later write for this workspace.
  const next = prev.then(fn, fn)
  writeChains.set(
    workspace,
    next.catch(() => undefined)
  )
  return next
}

/** Write via a temp file + rename, so a crash mid-write cannot truncate an artifact. */
async function writeAtomic(filePath: string, contents: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  const tmp = `${filePath}.tmp`
  await fs.writeFile(tmp, contents, "utf8")
  await fs.rename(tmp, filePath)
}

async function readJson<T>(filePath: string, fallback: () => T): Promise<T> {
  let raw: string
  try {
    raw = await fs.readFile(filePath, "utf8")
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return fallback()
    throw err
  }
  try {
    return JSON.parse(raw) as T
  } catch (err) {
    // Name the file. A corrupt artifact is recoverable by hand; a bare
    // "Unexpected token" three layers down inside an agent tool is not.
    throw new Error(
      `rehearsal: ${filePath} is not valid JSON — ${
        err instanceof Error ? err.message : String(err)
      }`
    )
  }
}

// ── scripts ─────────────────────────────────────────────────────────────────

export async function readScripts(workspace: string): Promise<ScriptsDoc> {
  return readJson(rehearsalPaths(workspace).scripts, pure.emptyScripts)
}

/**
 * Record one proven scene script.
 *
 * Idempotent by sceneId (`mergeScript` replaces in place), so the rehearsal
 * agent is expected to call this repeatedly for the SAME scene as its action
 * list grows — after every proven step, not once at the end of the scene.
 * That is spec §9's rule: precision lives in this file, not in a summary.
 */
export async function recordScript(
  workspace: string,
  script: SceneScript
): Promise<void> {
  const file = rehearsalPaths(workspace).scripts
  return serialize(workspace, async () => {
    const doc = await readJson(file, pure.emptyScripts)
    await writeAtomic(file, JSON.stringify(pure.mergeScript(doc, script), null, 2))
  })
}

/**
 * Forget everything a flow proved, so it can be rehearsed again from scratch.
 *
 * Called by `rehearseFlow` before every attempt. A second attempt may produce
 * fewer scenes than the first (a resumed run, or a revision after Gate B), and
 * merging alone would leave the extras behind as orphans that `toScenesStep`
 * would happily hand to the recorder.
 */
export async function dropFlowScripts(
  workspace: string,
  flowId: string
): Promise<void> {
  const file = rehearsalPaths(workspace).scripts
  return serialize(workspace, async () => {
    const doc = await readJson(file, pure.emptyScripts)
    await writeAtomic(
      file,
      JSON.stringify(pure.dropFlowScripts(doc, flowId), null, 2)
    )
  })
}

// ── checkpoint ──────────────────────────────────────────────────────────────

export async function readCheckpoint(
  workspace: string
): Promise<CheckpointDoc> {
  return readJson(rehearsalPaths(workspace).checkpoint, pure.emptyCheckpoint)
}

export async function inProgressFlow(
  workspace: string
): Promise<FlowEntry | null> {
  return pure.inProgressFlow(await readCheckpoint(workspace))
}

export async function beginFlow(
  workspace: string,
  flow: { id: string; label: string; startUrl: string }
): Promise<void> {
  const file = rehearsalPaths(workspace).checkpoint
  return serialize(workspace, async () => {
    const doc = await readJson(file, pure.emptyCheckpoint)
    await writeAtomic(file, JSON.stringify(pure.beginFlow(doc, flow), null, 2))
  })
}

export async function finishFlow(
  workspace: string,
  flow: {
    id: string
    status: FlowStatus
    sceneIds: string[]
    detail: string
  }
): Promise<void> {
  const file = rehearsalPaths(workspace).checkpoint
  return serialize(workspace, async () => {
    const doc = await readJson(file, pure.emptyCheckpoint)
    await writeAtomic(file, JSON.stringify(pure.finishFlow(doc, flow), null, 2))
  })
}

// ── findings ────────────────────────────────────────────────────────────────

export async function readFindings(workspace: string): Promise<string> {
  try {
    return await fs.readFile(rehearsalPaths(workspace).findings, "utf8")
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return ""
    throw err
  }
}

export async function recordFinding(
  workspace: string,
  entry: { flowId: string; kind: FindingKind; text: string }
): Promise<void> {
  const file = rehearsalPaths(workspace).findings
  return serialize(workspace, async () => {
    let existing = ""
    try {
      existing = await fs.readFile(file, "utf8")
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err
    }
    await writeAtomic(file, pure.appendFinding(existing, entry))
  })
}
```

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck`
Expected: clean. (`noUnusedLocals` is on — if `FINDING_KINDS` on the `pure` cast is unused, it is still part of the module's shape and belongs there; keep it, since Task 5's `record_finding` schema mirrors it.)

- [ ] **Step 3: Run tests**

Run: `bun run test:workflows`
Expected: PASS — unchanged from Task 3. This file has no unit tests by design (impure `.ts`, project rule).

- [ ] **Step 4: Commit**

```bash
git add electron/agent/workflows/rehearsal.ts
git commit -m "feat: rehearsal artifact store with atomic, serialized writes"
```

---

### Task 5: The rehearsal sub-agent

**Files:**
- Modify: `electron/agent/demio-agent.ts:61-88` (`CreateDemioAgentOpts`), `demio-agent.ts:90-120` (tool assembly)
- Modify: `electron/agent/prompts.ts` (add `RehearsalInstructionsContext` + `rehearsalInstructions`, after `recoveryInstructions`)
- Create: `electron/agent/workflows/rehearse.ts`

**Interfaces:**
- Consumes: `createDemioAgent` (`../demio-agent`); `sceneScriptSchema` / `SceneScript` (`./script-schema`); `ensureRehearsalDirs`, `dropFlowScripts`, `beginFlow`, `finishFlow`, `readScripts`, `recordScript`, `recordFinding`, `readFindings`, `rehearsalPaths` (`./rehearsal`, Task 4).
- Produces:
  - `CreateDemioAgentOpts.extraTools?: Record<string, unknown>` — tools merged in *after* `toolFilter` is applied, because they are passed explicitly rather than discovered.
  - `prompts.ts`: `RehearsalInstructionsContext` and `rehearsalInstructions(ctx): string`.
  - `rehearse.ts`: `REHEARSAL_MAX_STEPS = 40`; `SAFE_FLOW_ID`; `RehearseFlowOutcome = { status: "done" | "blocked"; detail: string; sceneIds: string[] }`; `rehearseFlow(opts: { workspace, modelId, flow: { id, label, startUrl, goal }, guidance?, resumeNote?, signal? }): Promise<RehearseFlowOutcome>`. The `rehearse_flow` **tool** that wraps it is defined by Task 8 in `controller.ts` — see the note in Step 4.

**Why one sub-agent per flow:** see decision **D1** at the top of this plan. Read it before starting.

- [ ] **Step 1: Let `createDemioAgent` take extra tools**

In `electron/agent/demio-agent.ts`, add to `CreateDemioAgentOpts`, after `toolFilter`:

```ts
  /**
   * Tools registered on this agent in addition to whatever `toolFilter`
   * selects. Merged AFTER filtering on purpose: `toolFilter` is a visibility
   * allowlist over tools the factory already knows about, while these are
   * handed in explicitly by the caller — filtering them would mean naming
   * them twice, and a typo would silently drop the tool.
   */
  extraTools?: Record<string, unknown>
```

and in `createDemioAgent`, immediately before the `return new Agent({`:

```ts
  Object.assign(tools, opts.extraTools ?? {})
```

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck`
Expected: clean (nothing passes `extraTools` yet).

- [ ] **Step 3: Write the rehearsal prompt**

In `electron/agent/prompts.ts`, append after `recoveryInstructions`:

```ts
export interface RehearsalInstructionsContext {
  workspace: string
  flow: { id: string; label: string; startUrl: string; goal: string }
  screenshotDir: string
  /** `findings.md` so far — what earlier flows already learned about this product. */
  findings: string
  /** Free-text steer from the outer agent (a Gate B revision, a user answer). */
  guidance?: string
  /**
   * Set when this flow is being re-walked after the app restarted. The
   * browser is guaranteed gone (`cleanupStaleSessions()` runs `close --all`
   * at app start), so the page state is not what the transcript implies.
   */
  resumeNote?: string
}

/**
 * The per-flow rehearsal agent. Runs OFF CAMERA — nothing it does is
 * recorded. Its output is not a video, it is a proven, executable script.
 *
 * Deliberately has no `ask_user`: it is a sub-agent of the chat conversation,
 * which owns every question the user is asked. Blocked means "report and
 * stop", never "guess".
 */
export function rehearsalInstructions(
  ctx: RehearsalInstructionsContext
): string {
  const { workspace, flow, screenshotDir, findings, guidance, resumeNote } = ctx

  const findingsBlock = findings.trim()
    ? `\n# What earlier flows already learned\n\n${findings.trim()}\n`
    : ""
  const guidanceBlock = guidance
    ? `\n# Steer from the conversation\n\n${guidance}\n`
    : ""
  const resumeBlock = resumeNote
    ? `\n# This is a re-run\n\n${resumeNote}\n\nEverything you previously learned about this product is still valid. Everything you previously did *in the page* is gone — the browser was reset. Start from \`${flow.startUrl}\` and prove the flow again from the beginning.\n`
    : ""

  return `You are the Demio rehearsal agent. **Nothing you do is being recorded.** You are walking one flow of a product demo ahead of time, off camera, so that the recording pass afterwards can replay it perfectly with no thinking, no fumbling and no dead air.

# The flow

- id: \`${flow.id}\`
- name: ${flow.label}
- goal: ${flow.goal}
- start URL: ${flow.startUrl}
${resumeBlock}${guidanceBlock}${findingsBlock}
# What you produce

A **script**: an ordered list of agent-browser commands, each one proven to work, each one carrying an assertion that proves it landed.

Work one step at a time:

1. \`agent-browser snapshot -i\` and read it.
2. Decide the single next command.
3. Run it.
4. Prove it landed: run \`agent-browser wait <assertion>\` and see it succeed.
5. Call \`record_scene_script\` with the scene's actions **so far**.
6. Screenshot the result: \`agent-browser screenshot --screenshot-dir ${screenshotDir} --screenshot-format jpeg --screenshot-quality 80\`.

**Call \`record_scene_script\` after EVERY proven step — never once at the end.** Re-calling it with the same \`sceneId\` replaces the previous version, so it is safe to call repeatedly as the action list grows. If this run dies halfway, everything already proven survives on disk; anything you were saving up for the end does not.

# Scene ids and splitting

Scenes from this flow are named \`${flow.id}.01\`, \`${flow.id}.02\`, … in order. Any other name is rejected.

**When a flow runs long, split it into consecutive scenes rather than writing one long one.** Mark every scene after the first \`"continuity": "chained"\`: a chained scene continues on the live page without reloading, so the viewer sees one unbroken action while the pipeline gets a small unit it can re-record on its own. The first scene of the flow is \`"independent"\` — it opens \`${flow.startUrl}\` itself.

# Locators must survive a page load

\`@e17\` refs come from a snapshot's RefMap and are only valid until the page changes. Use them to *explore*; never put one in a script.

The durable form of a resolved element is:

\`\`\`
find role button --name "Create board" --exact click
find role textbox --name "Board title" fill "..."
\`\`\`

Never \`find text\` for a clickable control. Never \`find nth\` with a positional guess. If two elements genuinely share a role and name, record a \`selector\` finding saying so and what you used instead.

# Every step carries an assertion

\`assert\` is the arguments to \`agent-browser wait\` that prove the step landed — \`--url 'https://app.x.com/b/'\`, \`--text "Saved"\`. A step whose assertion you cannot make pass is a step you have not proven; do not record it.

The LAST action of a scene must always have an assertion. Its \`endUrl\` is whatever URL you actually observe at that point — read it off the page, never guess it.

# Data must be parameterised

You will actually click Create. That means this flow runs **twice** — once now, once on camera — and the second run must not collide with the first.

Any value you type that names something the product will create goes in as a placeholder:

\`\`\`json
{ "cmd": "find role textbox --name \\"Board title\\" fill \\"{{boardName}}\\"",
  "assert": "--text \\"{{boardName}}\\"" }
\`\`\`

and the script's \`params\` carries the value the **recording** pass will use — a different one from what you just typed:

\`\`\`json
"params": { "boardName": "Q3 Launch Plan" }
\`\`\`

Search terms, filter text and anything the product does not persist do not need this.

# Report what you leave behind

Call \`record_finding\` as you go:

- \`selector\` — an element that was ambiguous, and what worked instead.
- \`wait\` — a wait the flow genuinely needs (a slow render, an animation).
- \`blocker\` — something that stopped you.
- \`state-created\` — **anything this rehearsal created, sent or changed in the real product.** A board, an invite, an uploaded file. This is how the user finds out what a rehearsal cost them.
- \`note\` — anything else worth knowing at review time.

# One-shot flows

If this flow genuinely cannot be run a second time — it sends a real invitation, cancels a subscription, completes a first-run wizard that never appears again — set \`"oneShot": true\` on its scenes and record a \`blocker\` finding explaining why. Do not try to work around it. A human decides what happens to a one-shot flow at review time.

# When you are stuck

You have no way to ask the user anything. If the flow needs a credential you do not have, a permission you lack, or data that is not there, stop and report it. Do not invent a workaround, and do not record a step you could not prove.

# Tools

- \`mastra_workspace_execute_command\` — your shell. Every call MUST pass a \`description\`: a clear 5-10 word summary, shown as the shell card's title.
- \`record_scene_script\` — record the proven script for one scene. Call after every proven step.
- \`record_finding\` — record one finding.

Files live in \`${workspace}\`; \`$WORKSPACE\` is set in the shell environment. Pass **absolute** paths to agent-browser.

Prefer \`snapshot -i\` (a ~1-5k token accessibility tree) over \`screenshot\` (an image, 10-250k tokens). Never use \`--full\` on a long page.

# Reply

Reply exactly \`DONE: <one line on what the flow now proves>\` if you proved the whole flow, or exactly \`BLOCKED: <one line on what stopped you>\` if you did not. Your reply IS read — it decides whether the conversation moves on or asks the user for help.

# agent-browser CLI reference

${agentBrowserSkill}
`
}
```

- [ ] **Step 4: Write the runner and its tools**

Create `electron/agent/workflows/rehearse.ts`:

```ts
// ── Rehearsal: one flow, off camera ─────────────────────────────────────────
//
// One `rehearseFlow` call == one flow == one fresh sub-agent with its own
// bounded step budget. See decision D1 in the Phase 2 plan for why this is a
// sub-agent rather than a controller turn: a 12-scene demo is ~70 browser
// steps, each preceded by a 1-5k-token snapshot, and none of that belongs in
// the chat thread. What reaches the conversation is one line per flow.
//
// Everything the flow proves goes to disk as it is proven (rehearsal.ts), not
// into this function's return value — so a run that dies halfway still leaves
// a usable partial script behind.

import { createTool } from "@mastra/core/tools"
import { WORKSPACE_TOOLS } from "@mastra/core/workspace"
import { promises as fs } from "node:fs"
import { z } from "zod"
import { createDemioAgent } from "../demio-agent"
import { rehearsalInstructions } from "../prompts"
import { sceneScriptSchema } from "./script-schema"
import {
  beginFlow,
  dropFlowScripts,
  ensureRehearsalDirs,
  finishFlow,
  inProgressFlow,
  readFindings,
  readScripts,
  recordFinding,
  recordScript,
  rehearsalPaths,
} from "./rehearsal"
import type { FindingKind } from "./rehearsal"
import log from "../../lib/logger"

/** Shell only, from the factory's side — the two rehearsal tools come in via `extraTools`. */
const REHEARSAL_TOOL_FILTER = [WORKSPACE_TOOLS.SANDBOX.EXECUTE_COMMAND]

/**
 * Step ceiling for one flow. Spec §8 budgets ~30-40 steps per flow; each
 * proven step costs roughly snapshot + command + assert + record + screenshot,
 * so this is about eight proven steps' worth of room plus exploration.
 */
export const REHEARSAL_MAX_STEPS = 40

/** Flow ids are kebab-case so `<flowId>.NN` scene ids stay unambiguous. */
export const SAFE_FLOW_ID = /^[a-z0-9-]+$/

export interface RehearseFlowOutcome {
  status: "done" | "blocked"
  detail: string
  sceneIds: string[]
}

/**
 * The two tools only the rehearsal sub-agent gets. Both are bound to one
 * workspace AND one flow: without the flow binding, a sub-agent that
 * mis-numbered a scene could overwrite a different flow's proven work, and
 * nothing downstream would be able to tell.
 */
function createRehearsalTools(workspace: string, flowId: string) {
  const scenePrefix = `${flowId}.`
  return {
    record_scene_script: createTool({
      id: "record_scene_script",
      description:
        "Record the proven script for one scene. Call this after EVERY proven step, not once at the end — re-calling with the same sceneId replaces the previous version.",
      inputSchema: sceneScriptSchema,
      outputSchema: z.object({ ok: z.boolean(), actions: z.number() }),
      execute: async (input) => {
        if (!input.sceneId.startsWith(scenePrefix)) {
          throw new Error(
            `record_scene_script: sceneId "${input.sceneId}" does not belong to flow ` +
              `"${flowId}" — scenes of this flow are named ${scenePrefix}01, ${scenePrefix}02, …`
          )
        }
        await recordScript(workspace, input)
        return { ok: true, actions: input.actions.length }
      },
    }),
    record_finding: createTool({
      id: "record_finding",
      description:
        "Record one rehearsal finding: an ambiguous selector, a required wait, a blocker, or state this rehearsal created in the real product.",
      inputSchema: z.object({
        kind: z.enum([
          "selector",
          "wait",
          "blocker",
          "state-created",
          "note",
        ]),
        text: z.string().describe("One sentence. Concrete, not a summary."),
      }),
      outputSchema: z.object({ ok: z.boolean() }),
      execute: async (input) => {
        await recordFinding(workspace, {
          flowId,
          kind: input.kind as FindingKind,
          text: input.text,
        })
        return { ok: true }
      },
    }),
  }
}

/**
 * Rehearse one flow. Resolves for every outcome including a blocked flow —
 * "blocked" is information the conversation acts on, not an error.
 */
export async function rehearseFlow(opts: {
  workspace: string
  modelId: string
  flow: { id: string; label: string; startUrl: string; goal: string }
  guidance?: string
  resumeNote?: string
  signal?: AbortSignal
}): Promise<RehearseFlowOutcome> {
  const { workspace, flow } = opts
  if (!SAFE_FLOW_ID.test(flow.id)) {
    throw new Error(
      `rehearseFlow: flow id "${flow.id}" must match ${SAFE_FLOW_ID} ` +
        `(scene ids are derived from it)`
    )
  }

  await ensureRehearsalDirs(workspace)

  // §10 resume, detected here rather than in the prompt so it cannot depend on
  // the model noticing. With one sub-agent per flow (decision D1) the spec's
  // Case A and Case B collapse into a single path: a flow STILL marked
  // in-progress when this call starts was interrupted — by an app restart, a
  // cancel, or a crash — and the live page is not where its transcript
  // implies. After a restart the browser is guaranteed gone
  // (`cleanupStaleSessions()` runs `close --all` at app start,
  // daemon.ts:18-32); after a cancel it is parked mid-flow, which is just as
  // unusable a start state. Either way the answer is the same: rewind to the
  // flow's own start. Read BEFORE `beginFlow` below, which overwrites it.
  const previous = await inProgressFlow(workspace)
  const resumeNote =
    opts.resumeNote ??
    (previous?.id === flow.id
      ? "A previous attempt at this flow was interrupted before it finished."
      : undefined)

  // Forget the previous attempt's scenes BEFORE the checkpoint says
  // in-progress: a second attempt may prove fewer scenes than the first, and
  // a leftover `flow.04` would be recorded as if it had been proven.
  await dropFlowScripts(workspace, flow.id)
  await beginFlow(workspace, {
    id: flow.id,
    label: flow.label,
    startUrl: flow.startUrl,
  })

  const paths = rehearsalPaths(workspace)
  let text = ""
  let steps: unknown[] = []
  try {
    const agent = createDemioAgent({
      workspace,
      modelId: opts.modelId,
      toolFilter: REHEARSAL_TOOL_FILTER,
      extraTools: createRehearsalTools(workspace, flow.id),
      instructionsOverride: rehearsalInstructions({
        workspace,
        flow,
        screenshotDir: paths.screenshots,
        findings: await readFindings(workspace),
        guidance: opts.guidance,
        resumeNote,
      }),
    })
    const res = await agent.generate(
      `Rehearse the flow "${flow.label}" starting from ${flow.startUrl}.`,
      { abortSignal: opts.signal, maxSteps: REHEARSAL_MAX_STEPS }
    )
    text = (res.text ?? "").trim()
    steps = (res.steps ?? []) as unknown[]
  } catch (err) {
    text = `BLOCKED: rehearsal agent error: ${
      err instanceof Error ? err.message : String(err)
    }`
    log.warn(`[rehearsal] flow ${flow.id} failed: ${text}`)
  }

  // Write-only transcript, same role as `narration.agent.json` — the only
  // record of what the sub-agent actually did, since its conversation lives
  // and dies inside this call.
  try {
    await fs.writeFile(
      `${paths.dir}/${flow.id}.agent.json`,
      JSON.stringify({ flow, modelId: opts.modelId, text, steps }, null, 2),
      "utf8"
    )
  } catch {
    // debug artifact only — never fail a flow over it
  }

  const doc = await readScripts(workspace)
  const sceneIds = doc.scripts
    .map((s) => s.sceneId)
    .filter((id) => id.startsWith(`${flow.id}.`))

  // A "DONE" with nothing on disk is the failure this design is most exposed
  // to: the sub-agent narrated a successful rehearsal without ever calling
  // record_scene_script. Trust the artifacts, not the prose.
  const claimsDone = text.startsWith("DONE")
  const status: "done" | "blocked" =
    claimsDone && sceneIds.length > 0 ? "done" : "blocked"
  const detail =
    claimsDone && sceneIds.length === 0
      ? `${text} — but no scene script was recorded, so nothing was actually proven`
      : text || "rehearsal agent returned nothing"

  await finishFlow(workspace, { id: flow.id, status, sceneIds, detail })
  return { status, detail, sceneIds }
}
```

**Where the `rehearse_flow` TOOL lives — deliberately not here.** The tool wrapper needs `readControllerCtx`, `threadIdFromCtx`, `ensureWorkspace` and `DEFAULT_MODEL_ID`. The first two are module-private to `controller.ts`, and `controller.ts` must import `rehearseFlow` — so defining the tool here and importing those helpers back out would make a cycle. Task 8 defines the tool in `controller.ts` alongside `generateDemoTool`, which already uses all four. `rehearse.ts` exports only the runner.

- [ ] **Step 5: Typecheck**

Run: `bun run typecheck`
Expected: clean. `rehearse.ts` should export `rehearseFlow`, `REHEARSAL_MAX_STEPS`, `SAFE_FLOW_ID` and `RehearseFlowOutcome`, and must NOT contain `rehearseFlowTool` (see the note above).

- [ ] **Step 6: Run tests**

Run: `bun run test:workflows`
Expected: PASS, unchanged. No unit tests here — `rehearse.ts` and the prompt are impure/prose.

- [ ] **Step 7: Commit**

```bash
git add electron/agent/demio-agent.ts \
        electron/agent/prompts.ts \
        electron/agent/workflows/rehearse.ts
git commit -m "feat: per-flow rehearsal sub-agent that proves and records an executable script"
```

---

### Task 6: Run-scoped credentials in the agent-browser vault

**Files:**
- Create: `electron/agent/workflows/credentials.ts`

**Interfaces:**
- Consumes: `execAgentBrowser` and its new `stdin` option (Task 1); `shellQuote` from `electron/lib/agent-browser/quote.ts:20` (verified present).
- Produces, all exported from `credentials.ts`:
  - `vaultProfileName(workspace: string): string` — `demio-<threadId>`, derived from the workspace directory name.
  - `saveCredentials(opts): Promise<{ ok: boolean; detail: string }>`
  - `hasProfile(workspace: string): Promise<boolean>`
  - `loginProfile(workspace: string): Promise<{ ok: boolean; detail: string }>`
  - `deleteProfile(workspace: string): Promise<void>` — idempotent.

  Task 7's preflight calls `hasProfile` + `loginProfile`. Task 8 registers a `save_login` tool over `saveCredentials`, and wires `deleteProfile` into the three deletion sites.

**Probed behaviour of the installed CLI** (do not re-derive these; they are why the code below is shaped as it is):

```
$ agent-browser auth show nope-not-here      → "✗ Auth profile 'nope-not-here' not found", exit 1
$ agent-browser auth delete nope-not-here    → "✗ Auth profile 'nope-not-here' not found", exit 1
$ agent-browser auth list --json             → {"success":true,"data":{"profiles":[]},"error":null}, exit 0
```

So `deleteProfile` must treat exit 1 as success (there was nothing to delete), and `hasProfile` can use `auth show`'s exit code directly.

**Deterministic naming is the point.** The profile name is computed from the workspace path alone, so all three deletion sites — after compose, on abort, on thread deletion — can name the profile without any state having been threaded to them.

- [ ] **Step 1: Write the module**

Create `electron/agent/workflows/credentials.ts`:

```ts
// ── Run-scoped login credentials ────────────────────────────────────────────
//
// Spec §12. Credentials live in agent-browser's own vault, never in demio:
// the same reasoning that kept `elevenLabsKey` out of the demo-video workflow
// input schema (demo-video.ts:58-64) applies with more force to a user's
// password — `createRun`/`start`/`resume` snapshot `inputData` into a LibSQL
// row on every suspend.
//
// The vault profile is named deterministically from the workspace path, so
// every cleanup site can compute it without being handed anything.
//
// **Known residual risk, deliberately accepted here:** the password still
// transits the conversation, because `ask_user` is the only capture channel
// the harness has and the controller persists messages and tool arguments to
// `mastra_messages`. What this module removes is every OTHER copy — argv, the
// process listing, demio's logs, and agent-browser's action logs — which is
// what `--password-stdin` buys. Closing the last one needs a capture path
// that bypasses the model entirely (a preload-side secret field writing
// straight to the vault); that is a separate change, not this plan.

import path from "node:path"
import { execAgentBrowser } from "../../lib/agent-browser/exec"
import { shellQuote } from "../../lib/agent-browser/quote"
import log from "../../lib/logger"

/**
 * `demio-<threadId>`, from the workspace directory name.
 *
 * Sanitised rather than trusted: the name reaches the CLI as an argument, and
 * a thread id is only ever generated by the store — but "only ever" is not a
 * guarantee worth relying on at a shell boundary.
 */
export function vaultProfileName(workspace: string): string {
  const threadId = path.basename(workspace).replace(/[^A-Za-z0-9_-]/g, "")
  if (!threadId) {
    throw new Error(
      `credentials: cannot derive a vault profile name from workspace "${workspace}"`
    )
  }
  return `demio-${threadId}`
}

export async function saveCredentials(opts: {
  workspace: string
  loginUrl: string
  username: string
  password: string
  usernameSelector?: string
  passwordSelector?: string
  submitSelector?: string
}): Promise<{ ok: boolean; detail: string }> {
  const profile = vaultProfileName(opts.workspace)
  const parts = [
    `auth save ${shellQuote(profile)}`,
    `--url ${shellQuote(opts.loginUrl)}`,
    `--username ${shellQuote(opts.username)}`,
    // NEVER --password: it would land in argv, and therefore in any process
    // listing and in demio's own command logging.
    "--password-stdin",
  ]
  if (opts.usernameSelector)
    parts.push(`--username-selector ${shellQuote(opts.usernameSelector)}`)
  if (opts.passwordSelector)
    parts.push(`--password-selector ${shellQuote(opts.passwordSelector)}`)
  if (opts.submitSelector)
    parts.push(`--submit-selector ${shellQuote(opts.submitSelector)}`)

  const res = await execAgentBrowser([parts.join(" ")], {
    timeout: 20_000,
    stdin: opts.password,
  })
  // `res.error`/`res.output` are safe to surface: `auth save` echoes "✓ Done"
  // and never the password. Verified against the installed binary.
  return {
    ok: res.ok,
    detail: res.ok ? `saved vault profile ${profile}` : res.error || "auth save failed",
  }
}

export async function hasProfile(workspace: string): Promise<boolean> {
  const profile = vaultProfileName(workspace)
  const res = await execAgentBrowser([`auth show ${shellQuote(profile)}`], {
    timeout: 10_000,
  })
  return res.ok
}

/**
 * Log in using the saved profile. Camera-off only — never call this with a
 * recording running.
 *
 * `auth login` "waits for form fields to appear before filling/clicking"
 * (its own `--help`), so on a session that is ALREADY logged in there is no
 * form to wait for and it is expected to time out rather than succeed. That
 * is why callers treat a failure here as advisory: see the preflight step.
 */
export async function loginProfile(
  workspace: string
): Promise<{ ok: boolean; detail: string }> {
  const profile = vaultProfileName(workspace)
  const res = await execAgentBrowser([`auth login ${shellQuote(profile)}`], {
    timeout: 45_000,
  })
  return { ok: res.ok, detail: res.ok ? "logged in" : res.error || "auth login failed" }
}

/**
 * Delete the run's vault profile. Idempotent: `auth delete` exits 1 with
 * "not found" when there is nothing to delete, which is a success for our
 * purposes — every caller is a cleanup path that must not throw.
 */
export async function deleteProfile(workspace: string): Promise<void> {
  let profile: string
  try {
    profile = vaultProfileName(workspace)
  } catch {
    return
  }
  try {
    const res = await execAgentBrowser([`auth delete ${shellQuote(profile)}`], {
      timeout: 10_000,
    })
    if (!res.ok && !/not found/i.test(`${res.error ?? ""}${res.output ?? ""}`)) {
      log.warn(`[credentials] failed to delete vault profile ${profile}: ${res.error}`)
    }
  } catch (err) {
    log.warn(
      `[credentials] delete threw for ${profile}: ${
        err instanceof Error ? err.message : String(err)
      }`
    )
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck`
Expected: clean (nothing imports this yet).

- [ ] **Step 3: Commit**

```bash
git add electron/agent/workflows/credentials.ts
git commit -m "feat: run-scoped login credentials in the agent-browser vault"
```

---

### Task 7: Camera-off login preflight

**Files:**
- Modify: `electron/agent/workflows/demo-video.ts:88-103` (add a step after `toScenesStep`), `demo-video.ts:479-491` (the workflow chain)

**Interfaces:**
- Consumes: `hasProfile`, `loginProfile` (Task 6); `sceneSchema` (existing).
- Produces: `preflightStep`, a `createStep` with `inputSchema: z.array(sceneSchema)` and the same `outputSchema`, inserted between `toScenesStep` and the `.foreach(sceneStep)`.

**Why here and not per scene:** spec §12 — *"Recording runs a camera-off pre-flight: if the session is dead, `auth login <profile>` silently before `record start`. Only if that fails does it ask the user — **before** any recording, never during."* One login per run, before the first frame, is exactly that. Putting it inside `sceneStep` would run it between takes, with the camera state ambiguous.

**The one judgement call, and why:** there is no reliable way to ask agent-browser "is this session still logged in?". `auth login` waits for the login form's fields to appear, so on an already-authenticated session it is expected to *time out*, not to succeed. Therefore the preflight **always attempts the login when a profile exists, and treats failure as advisory** — logged, never fatal. A genuinely dead session then fails at scene 1's first assertion, which is the existing, well-handled path: deviation → camera-off recovery → suspend → ask the user. Guessing harder here would trade a clear failure for a silent one.

- [ ] **Step 1: Add the step**

In `electron/agent/workflows/demo-video.ts`, add the imports:

```ts
import { hasProfile, loginProfile } from "./credentials"
```

and insert after `toScenesStep`:

```ts
/**
 * Camera-off login, once per run, before the first frame (spec §12).
 *
 * `auth login` waits for the login form to appear, so on a session that is
 * still authenticated it is expected to time out rather than succeed — which
 * is why a failure here is logged and not thrown. A session that really is
 * dead surfaces at scene 1's first assertion, and takes the ordinary
 * deviation → recovery → suspend path where the user can act on it.
 *
 * Passes scenes through untouched; it exists purely for the side effect.
 */
const preflightStep = createStep({
  id: "preflight-login",
  inputSchema: z.array(sceneSchema),
  outputSchema: z.array(sceneSchema),
  execute: async ({ inputData, getInitData }) => {
    const init = getInitData<DemoVideoInit>()
    if (!(await hasProfile(init.workspace))) return inputData
    const res = await loginProfile(init.workspace)
    if (!res.ok) {
      log.info(
        `[demo-workflow] preflight auth login did not complete (${res.detail}) — ` +
          `expected when the session is still authenticated; continuing`
      )
    }
    return inputData
  },
})
```

`demo-video.ts` does not currently import the logger. Add:

```ts
import log from "../../lib/logger"
```

- [ ] **Step 2: Put it in the chain**

Change the workflow chain at the bottom of the file:

```ts
  .then(toScenesStep)
  .then(preflightStep)
  .foreach(sceneStep, { concurrency: 1 })
```

- [ ] **Step 3: Typecheck**

Run: `bun run typecheck`
Expected: clean.

- [ ] **Step 4: Run tests**

Run: `bun run test:workflows`
Expected: PASS, unchanged.

- [ ] **Step 5: Commit**

```bash
git add electron/agent/workflows/demo-video.ts
git commit -m "feat: camera-off login preflight before the first frame of a run"
```

---

### Task 8: The rehearse mode, Gate B, and credential cleanup

**Files:**
- Modify: `electron/agent/controller.ts:102-116` (`PLAN_MODE_TOOLS`), `:186-390` (add two tools beside `generateDemoTool`, plus cleanup in its terminal paths), `:516-546` (the `modes` array), `:590-600` (`disposeThread`)

**Interfaces:**
- Consumes: `rehearseFlow` (Task 5), `saveCredentials` / `deleteProfile` (Task 6), `getWorkspace` (`./workspace`). The mode reads `findings.md` and `checkpoint.json` through its own workspace file tools, not through an import.
- Produces: `rehearseFlowTool` and `saveLoginTool` (module-private `createTool` values); the rehearse mode's tool allowlist and instructions; credential deletion at all three sites required by spec §12.

**Read decision D3 at the top of this plan before touching the mode.** The mode **id stays `"plan"`**. Only its `name`, `instructions` and tools change. Renaming the id would orphan every session persisted before this change.

- [ ] **Step 1: Define the two new tools**

In `electron/agent/controller.ts`, add the imports:

```ts
import { rehearseFlow } from "./workflows/rehearse"
import { saveCredentials, deleteProfile } from "./workflows/credentials"
```

and add, immediately before `const generateDemoTool = createTool({`:

```ts
/**
 * Walk one flow off camera and prove it. Defined here rather than in
 * `rehearse.ts` because it needs `readControllerCtx` / `threadIdFromCtx` /
 * `ensureWorkspace`, which are this module's — importing them out would make
 * a cycle with `rehearse.ts`. The runner itself lives in `rehearse.ts`.
 */
const rehearseFlowTool = createTool({
  id: "rehearse_flow",
  description:
    "Walk one flow of the product off camera and prove every step, producing an executable script. Call once per flow, one flow at a time, and read the result before starting the next.",
  inputSchema: z.object({
    flowId: z
      .string()
      .describe(
        "Kebab-case slug, e.g. `create-board`. Scenes from this flow are named <flowId>.01, <flowId>.02, …"
      ),
    label: z.string().describe("Short human name, e.g. 'Create a board'"),
    startUrl: z.string().describe("URL the flow starts from"),
    goal: z.string().describe("What this flow demonstrates, one sentence"),
    guidance: z
      .string()
      .optional()
      .describe(
        "Anything the rehearsal agent cannot discover for itself — an answer the user gave you, or a correction after a previous attempt."
      ),
  }),
  outputSchema: z.object({
    status: z.enum(["done", "blocked"]),
    detail: z.string(),
    sceneIds: z.array(z.string()),
  }),
  execute: async (input, context) => {
    const ctx = readControllerCtx(context.requestContext)
    const threadId = threadIdFromCtx(ctx)
    if (!threadId) {
      throw new Error("rehearse_flow: no threadId in request context")
    }
    return rehearseFlow({
      workspace: ensureWorkspace(threadId),
      modelId: ctx?.session.modelId || DEFAULT_MODEL_ID,
      flow: {
        id: input.flowId,
        label: input.label,
        startUrl: input.startUrl,
        goal: input.goal,
      },
      guidance: input.guidance,
      signal: context.abortSignal,
    })
  },
})

/**
 * Save this run's login into agent-browser's vault (spec §12).
 *
 * The password reaches the vault through the child's stdin and is never
 * written to demio's own storage. It does still pass through this tool's
 * arguments, which the controller persists — see the header comment in
 * `credentials.ts` for exactly what that does and does not protect.
 */
const saveLoginTool = createTool({
  id: "save_login",
  description:
    "Save this run's login credentials into agent-browser's secure vault so recording can log in unattended. Ask the user for the username and the password with two separate ask_user calls first. The credentials are deleted when the run finishes or the thread is deleted.",
  inputSchema: z.object({
    loginUrl: z.string().describe("The login page URL"),
    username: z.string(),
    password: z.string(),
    usernameSelector: z
      .string()
      .optional()
      .describe("CSS selector for the username field, if you discovered one"),
    passwordSelector: z.string().optional(),
    submitSelector: z.string().optional(),
  }),
  outputSchema: z.object({ ok: z.boolean(), detail: z.string() }),
  execute: async (input, context) => {
    const threadId = threadIdFromCtx(readControllerCtx(context.requestContext))
    if (!threadId) {
      throw new Error("save_login: no threadId in request context")
    }
    return saveCredentials({ workspace: ensureWorkspace(threadId), ...input })
  },
})
```

- [ ] **Step 2: Delete the vault profile on every terminal path of a run**

Spec §12: *"Delete the profile after compose, **and** on abort, **and** on thread deletion."*

In `generateDemoTool.execute`, add a `void deleteProfile(...)` immediately before **each** `throw err` in the two `catch (err)` blocks that already call `activeDemoRuns.delete(threadId)`:

```ts
      } catch (err) {
        activeDemoRuns.delete(threadId)
        void deleteProfile(workspace)
        throw err
      } finally {
```

and once more after the non-suspended terminal path's `activeDemoRuns.delete(threadId)`:

```ts
    activeDemoRuns.delete(threadId)
    // The run reached a terminal state — success or failure, abort included.
    // `deleteProfile` is idempotent and never throws (credentials.ts), so
    // fire-and-forget is safe and keeps cleanup off the result path.
    void deleteProfile(workspace)

    if (result.status !== "success") {
```

Do **not** add it to the `result.status === "suspended"` branch: that run is still alive and will resume.

- [ ] **Step 3: Delete the vault profile when a thread is deleted**

In `disposeThread`:

```ts
export function disposeThread(projectId: string, threadId: string): void {
  sessions.delete(`${projectId}:${threadId}`)
  // Spec §12's third deletion site. Sync function, async cleanup: the profile
  // name is derived from the workspace path, which is still computable here.
  void deleteProfile(getWorkspace(threadId))
  disposeDemioWorkspace(threadId)
}
```

`getWorkspace` (rather than `ensureWorkspace`) — this is a teardown path and must not create a directory on the way out. It is not imported yet: change `controller.ts:55` from `import { ensureWorkspace } from "./workspace"` to `import { ensureWorkspace, getWorkspace } from "./workspace"`.

- [ ] **Step 4: Widen the mode's tool allowlist**

Rename `PLAN_MODE_TOOLS` to `REHEARSE_MODE_TOOLS` and add the two new tool names. `availableTools` is a *visibility* allowlist applied over everything registered — a tool added via `additionalTools` but absent from this list would be registered and then hidden, so both names must appear here as well.

```ts
const REHEARSE_MODE_TOOLS = [
  "mastra_workspace_read_file",
  "mastra_workspace_list_files",
  "mastra_workspace_grep",
  "mastra_workspace_write_file",
  "mastra_workspace_edit_file",
  "mastra_workspace_mkdir",
  "mastra_workspace_execute_command",
  "ask_user",
  "submit_plan",
  "rehearse_flow",
  "save_login",
  "task_write",
  "task_update",
  "task_complete",
  "task_check",
]
```

Update the doc comment above it: the mode still needs `execute_command` for its own light discovery, and now also delegates the heavy walking to `rehearse_flow`.

- [ ] **Step 5: Rewrite the mode**

Replace the `id: "plan"` mode object with:

```ts
      {
        id: "plan",
        name: "Rehearse",
        metadata: { default: true },
        transitionsTo: "execute",
        availableTools: REHEARSE_MODE_TOOLS,
        additionalTools: {
          rehearse_flow: rehearseFlowTool,
          save_login: saveLoginTool,
        } as ToolsInput,
        instructions: `Rehearse the demo before anything is recorded, then submit a plan for approval.

Discovery is yours; walking flows is not. Open the product and look around with the shell tool if you need to — a handful of pages, snapshots not screenshots — enough to see what flows exist. Then hand each flow to \`rehearse_flow\`, one at a time, and read its result before starting the next. Do not walk a flow yourself; \`rehearse_flow\` is what produces the executable script the recording pass replays.

If the product needs a login: ask for the username with one \`ask_user\` call and the password with a second, then call \`save_login\` once. Do this BEFORE the first \`rehearse_flow\` call. Never put a password in any other tool call, and never write one to a file.

If scope is ambiguous — you found eight flows and the user asked for "a demo" — ask early with \`ask_user\`, after a light look around and before rehearsing anything. That one question is what stops you spending an hour proving the wrong flows.

If you are picking up a thread that already has work in it, read \`rehearsal/checkpoint.json\` before doing anything else. A flow still marked \`in-progress\` was interrupted and must be rehearsed again — call \`rehearse_flow\` for it first. Flows marked \`done\` are done; do not re-walk them.

A \`rehearse_flow\` result of \`blocked\` is information, not a dead end. Read the detail. If a person can unblock it, ask them and call \`rehearse_flow\` again with what they told you as \`guidance\`. If nobody can, leave it out of the plan and say so in the report.

When every flow you intend to use is rehearsed, write the plan to a markdown file under plans/ and call \`submit_plan({ path })\` with the path — never the plan body, and never as chat text. To revise after "Request changes", edit the same file and call \`submit_plan\` again with the same path.

The plan file must contain a fenced json block matching the scene plan schema (scenes with id/title/goal/startUrl/endUrl/actions/expectedOutcome/narrationHint).

- Scene \`id\`s must be **exactly** the sceneIds \`rehearse_flow\` returned, in the order it returned them. They are how the harness attaches each proven script to its scene; an id you invent will fail the run.
- Do NOT write a \`script\` field on any scene. The proven scripts already live in \`rehearsal/scripts.json\` and the harness merges them in. Copying them into the plan would create a second, stale copy.

The plan file must ALSO contain a "## Rehearsal report" section, in prose, covering:

- **Flows that could not be completed**, and what stopped each one.
- **One-shot flows** — any flow marked \`oneShot\` because it cannot be run a second time (a real invitation, a cancelled subscription, a first-run wizard). Name each one and say what recording it will actually do. The user needs to decide before approving, not after.
- **What this rehearsal already did to their product** — every \`state-created\` finding. Boards created, invites sent, files uploaded.
- **Anything that deviated from what the user asked for.**

\`rehearsal/findings.md\` in the workspace has all of this; read it before writing the report rather than reconstructing it from memory.

Do not record anything in this mode.`,
      },
```

- [ ] **Step 6: Typecheck**

Run: `bun run typecheck`
Expected: clean.

- [ ] **Step 7: Run tests**

Run: `bun run test:workflows`
Expected: PASS, unchanged.

- [ ] **Step 8: Commit**

```bash
git add electron/agent/controller.ts
git commit -m "feat: rehearse mode, Gate B report contract, and run-scoped credential cleanup"
```

---

### Task 9: Merge proven scripts into the plan, and clean up the scene schema

**Files:**
- Modify: `electron/agent/workflows/demo-video.ts:88-103` (`toScenesStep`)
- Modify: `electron/agent/workflows/schemas.ts:15-42`

**Interfaces:**
- Consumes: `readScripts` (Task 4).
- Produces: `toScenesStep` now emits scenes carrying their `script`. Nothing downstream changes — `recordSceneWithRetry` already reads `scene.script`.

**Why the harness merges, and not the model:** the alternative is the rehearse agent inlining every proven script into `submit_plan`'s plan file. A 12-scene demo is ~70 actions; re-emitting all of them as JSON is a large, purely mechanical copy in which the model can silently paraphrase a locator — and the plan file is not even where they would be read from. `scripts.json` is written by a tool call at the moment each step is proven; that is the copy to trust.

**Precedence rule:** a `script` written **inline on the scene** wins over the one in `scripts.json`. Explicit beats derived, and it is what keeps a hand-written script working — manual-checklist section E injects one directly into the plan json with no rehearsal at all, and that must keep working.

- [ ] **Step 1: Rewrite `toScenesStep`**

In `electron/agent/workflows/demo-video.ts`, add the import:

```ts
import { readScripts } from "./rehearsal"
```

and replace `toScenesStep` with:

```ts
const toScenesStep = createStep({
  id: "to-scenes",
  inputSchema,
  outputSchema: z.array(sceneSchema),
  execute: async ({ inputData }) => {
    for (const scene of inputData.plan.scenes) {
      if (!SAFE_SCENE_ID.test(scene.id)) {
        throw new Error(
          `generate_demo: scene id "${scene.id}" is not a safe filename slug ` +
            `(must match ${SAFE_SCENE_ID})`
        )
      }
    }

    // Attach each scene's proven script from rehearsal. A script written
    // inline on the scene wins: explicit beats derived, and a hand-written
    // script (manual-checklist section E) must keep working with no
    // rehearsal artifacts present at all.
    const doc = await readScripts(inputData.workspace)
    const byId = new Map(doc.scripts.map((s) => [s.sceneId, s]))
    const scenes = inputData.plan.scenes.map((scene) =>
      scene.script ? scene : { ...scene, script: byId.get(scene.id) }
    )

    // Fail here rather than per scene. `recordSceneWithRetry` also refuses a
    // scene with no script, but by then the run has already recorded
    // everything before it — and the cause is always the same one thing: the
    // plan named a scene id that rehearsal never produced. Say so once, with
    // both lists, before a single frame is captured.
    const missing = scenes.filter((s) => !s.script).map((s) => s.id)
    if (missing.length > 0) {
      throw new Error(
        `generate_demo: no rehearsed script for scene(s) ${missing.join(", ")}. ` +
          `Rehearsal proved: ${
            doc.scripts.map((s) => s.sceneId).join(", ") || "(nothing)"
          }. Scene ids in the plan must be exactly the sceneIds rehearse_flow returned.`
      )
    }

    return scenes
  },
})
```

- [ ] **Step 2: Clean up the scene schema**

In `electron/agent/workflows/schemas.ts`, delete `minDurationSec` and `maxDurationSec` entirely. They have **no reference anywhere in `electron/` or `src/`** — verified — and their `.describe()` text is model-visible prose from a deleted world ("the raw capture includes the recording agent's think-time", "verification clamps it up to at least 120s anyway"): both statements are now false, and the planner reads them.

Also correct two stale descriptions in the same object:

```ts
  endUrl: z
    .string()
    .describe(
      "URL prefix expected when the scene completes. Documentation only — the " +
        "authoritative end state is the last scripted action's `assert`, observed " +
        "during rehearsal rather than guessed here."
    ),
  actions: z
    .array(z.string())
    .min(1)
    .describe(
      "Ordered human-readable summary of what happens in this scene. " +
        "Documentation for the reviewer and the narrator; the executable form " +
        "is `script`."
    ),
```

Leave `verifyReportSchema`'s check-name enum alone — it still lists `duration-range`, `actions-ok` and `end-url` so that `SceneResult` rows persisted by earlier runs keep validating.

- [ ] **Step 3: Typecheck**

Run: `bun run typecheck`
Expected: clean. If anything referenced the two deleted fields, that is a genuine finding — report it rather than restoring them.

- [ ] **Step 4: Run tests**

Run: `bun run test:workflows`
Expected: PASS, unchanged.

- [ ] **Step 5: Commit**

```bash
git add electron/agent/workflows/demo-video.ts electron/agent/workflows/schemas.ts
git commit -m "feat: merge rehearsed scripts into scenes harness-side; drop dead duration fields"
```

---

### Task 10: Live proof and the manual walkthrough

**Files:**
- Modify: `docs/superpowers/plans/manual-e2e-checklist.md` (append section F)

**Interfaces:** none — this task produces evidence and a checklist, not code.

**Why this task exists:** every gate in this repo is blind to the two things most likely to be wrong here. `node --test` never starts a browser, and `tsc` never checks whether `record restart` and `--log-actions` compose. Phase 1 shipped a boot crash straight through nine task reviews and a whole-branch review for exactly this reason. The walkthrough is the gate.

**It also subsumes a risk parked in Phase 1.** Section E item 27 — *does `record restart` actually honour `--log-actions`?* — was never run. Section F exercises chained scenes end to end against a real product, so it settles that question. Do not ask the user to run section E first.

- [ ] **Step 1: Probe `auth login` against a real login form**

Pick any site with a plain username/password form. From a shell:

```bash
B=./node_modules/agent-browser/bin/agent-browser-darwin-arm64
printf '<password>' | $B auth save demio-probe --url <login-url> --username <user> --password-stdin
$B open <login-url>
$B auth login demio-probe          # expect: logs in
$B auth login demio-probe          # expect: ??? — this is the thing being measured
$B auth delete demio-probe
```

Record what the **second** call does — succeeds, hangs until the action timeout, or fails fast — and how long it takes. Then write that observed behaviour into the comment above `loginProfile` in `credentials.ts`, replacing the current "is expected to time out rather than succeed" with what actually happened. If it hangs for a long time, lower `loginProfile`'s 45s timeout to just above the observed action timeout, so the preflight cannot stall a run.

Commit that comment change on its own:

```bash
git add electron/agent/workflows/credentials.ts
git commit -m "docs: record observed auth login behaviour on an already-authenticated session"
```

- [ ] **Step 2: Write section F of the manual checklist**

Append to `docs/superpowers/plans/manual-e2e-checklist.md`, continuing the existing item numbering (section E ends at item 31, so this starts at 32):

```markdown
## F. Rehearse → Gate B → record (phase 2)

Prerequisites: a product with a login and at least one multi-step write flow.
Do **not** clean `~/.demio` — it holds your encrypted provider keys.

32. `bun start`. New project, new thread. Ask for a demo of two flows on the
    product, one of which requires logging in.

33. **Credentials.** The agent should ask for the username and the password in
    two SEPARATE questions, then call `save_login` once. Confirm with
    `agent-browser auth list` that a profile named `demio-<threadId>` exists,
    and with `agent-browser auth show demio-<threadId>` that **no password is
    printed**.

34. **One flow at a time.** Watch the tool cards: `rehearse_flow` must be
    called once per flow and awaited before the next. Two in flight at once
    is a prompt failure — report it.

35. **Incremental writing — the load-bearing one.** While a `rehearse_flow`
    call is still running, `cat ~/.demio/workspaces/<threadId>/rehearsal/scripts.json`.
    It must already contain the steps proven so far. If it is empty until the
    flow finishes, the agent is batching and spec §9's rule is violated: a
    crash would lose every locator.

36. **Durable locators.** Grep the finished `scripts.json` for `@e`. There must
    be **no** `@eN` ref in any `cmd`. Refs do not survive a page load and a
    script full of them will fail on replay in a way that looks random.

37. **Parameterisation.** For each write flow, confirm the script uses
    `{{name}}` in `cmd` and carries a `params` value that is **different** from
    what you watched it type during rehearsal. Same value means the record pass
    will collide with the rehearsal's own leftovers.

38. **Findings.** `cat rehearsal/findings.md`. It must have a `state-created`
    entry for everything rehearsal actually made in the product. Cross-check
    against the product itself — anything present there and missing from the
    file is a real gap, not a cosmetic one.

39. **Resume (spec §10, Case B).** Mid-way through the second flow, quit the
    app. Reopen it, reopen the thread, and ask it to continue.
    - `rehearsal/checkpoint.json` must show that flow as `in-progress` with its
      `startUrl`.
    - The re-run must re-open that URL and prove the flow from its start.
    - Afterwards, `scripts.json` must contain **no orphan** scene from the
      abandoned attempt — if the first attempt reached `flow.03` and the second
      only `flow.02`, there must be no `flow.03`.

40. **Gate B.** The plan file must contain a `## Rehearsal report` naming any
    blocked flow, any `oneShot` flow, and the state rehearsal created. A
    one-shot flow that reaches recording without being called out here is the
    failure this gate exists to prevent.

41. **No script in the plan.** The fenced json in the plan file must have no
    `script` field on any scene, and its scene ids must be exactly the ones
    `rehearse_flow` returned.

42. **Wrong scene id fails early.** Before approving, edit one scene's `id` in
    the plan file to something rehearsal never produced and approve it. The run
    must fail immediately with a message naming that id and listing what
    rehearsal did prove — **before any recording starts**. Restore the id and
    re-approve.

43. **Preflight.** Watch the log at the start of the run for the camera-off
    `auth login`. It must happen **before** the first `record start`, and a
    failure must be logged and not stop the run.

44. **Chained scenes really chain.** Play the second scene of a multi-scene
    flow. Its first frame must already show the end state of the previous
    scene — not a reloaded page. *(This is the check Phase 1's item 27 parked:
    it also proves `record restart` honours `--log-actions`, since the scene's
    `.actions.jsonl` must be non-empty.)*

45. **The record pass used the record-pass data.** After compose, check the
    product: the thing the video created must carry the `params` value, not the
    value rehearsal used. Both should now exist.

46. **Credentials are gone.** `agent-browser auth list` must no longer show
    `demio-<threadId>`. Repeat for the abort path: start a second run, cancel
    it mid-way, and confirm the profile is deleted then too. Repeat once more
    by deleting the thread.
```

- [ ] **Step 3: Run the walkthrough**

Work items 32–46 in order. Record the result of each. A failure here is a real
defect: fix it, note it in the run, and re-run the affected item.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/plans/manual-e2e-checklist.md
git commit -m "docs: manual e2e walkthrough for rehearse to record"
```

---

## Known-incomplete after this plan

Expected states, not bugs:

- **Narration still runs after recording.** `voiceExpected` stays `false` and `audio-track` is absent rather than failing. Phase 3 moves TTS ahead of the record pass (spec §14).
- **`narrationAnchor` is written by rehearsal but never read.** Phase 3 consumes it.
- **`settleMs` is whatever rehearsal chose.** Phase 3 derives a floor from each narration line's TTS duration, so a 4.2s line gets 4.2s of live footage instead of an EDL freeze-hold.
- **`oneShot` is surfaced at Gate B but not enforced.** The user is told; nothing stops them approving it. Spec §11.3's three-way offer (record the rehearsal itself / skip / "I've reset the account, proceed") is not built.
- **The password still transits the conversation.** See the header comment in `credentials.ts`. Closing it needs a capture path that bypasses the model entirely.
- **Observational Memory is not wired.** See decision D2, including the trigger to revisit.
- **No post-compose sanity check** on `demo.mp4`. Phase 3, when expected total duration becomes meaningful.
- **Scene stitching (spec §4, Option A) is still deferred.** Trigger unchanged: when a scene routinely needs more than ~10 steps.
- **The vision judge (spec §15) is still deferred.** Rehearsal's per-step screenshots are written and kept precisely so it can be built later; nothing reads them yet.
