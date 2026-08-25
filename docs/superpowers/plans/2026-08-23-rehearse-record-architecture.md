# Rehearse → Record architecture

**Status:** design agreed 2026-08-23, not implemented
**Supersedes in practice:** ADR-003 (scene retry), ADR-004 (mechanical verification), ADR-005 (recording lifecycle) — each is amended rather than replaced; see "ADR impact".

---

## The one-line change

Today a scene's **discovery and performance happen in the same pass, on camera**. The recorder
agent figures out what to click while the recording is running.

Split them. A **rehearsal** pass explores and proves every step off camera and emits an
executable script; a **record** pass replays that script deterministically. An LLM only wakes
during recording when a step deviates — and it works with the camera off.

```
BEFORE   plan ──▶ record(agent decides + performs) ──▶ verify ──▶ narrate ──▶ tts ──▶ sync ──▶ compose

AFTER    rehearse(agent decides, proves, narrates) ──▶ [Gate B] ──▶ tts
                                                                    │
                                                                    ▼
                                              record(deterministic replay) ──▶ verify ──▶ sync ──▶ compose
```

---

## What this fixes

| Reported problem | Resolution |
|---|---|
| Planner gives a wrong `endUrl`; every attempt fails; retry can never fix it (`demo-video.ts:150-159` only appends to `actions`) | `endUrl` becomes **observed** during rehearsal, not guessed. The class of failure disappears. |
| Recorder fumbles on camera — tries a selector 2–3 times before succeeding | Replay is deterministic. Recovery happens with the recording stopped. |
| Dead gaps inside scenes | Two sources, both addressed: LLM think-time is gone from the take entirely, and narration-driven waits replace EDL freeze-holds with live footage. |
| Each scene resets the page and cursor | Chained scenes use `record restart`, which does not reload. |
| No eval on the final output | Deterministic artifact checks ship now; the vision judge is deferred with a defined shape. |
| Recorder has no memory | There is no recorder agent any more. Rehearsal has both a resumable conversation and durable findings. |

Two items from the same review are **out of scope here** and remain separate fixes:
`present_files`'s false turn-end claim (`present-files.ts:7,32` cite a deleted orchestrator),
and batching `ask_user`.

---

## Decisions

### 1. Recording unit — per-scene files

One agent holds full-demo context, but the harness still brackets **each scene with its own
recording file**. Not one continuous take.

*Why:* `renderScene()` takes one video + one action log (`sync.ts`), `syncStep` loops per scene
(`demo-video.ts:404`), `composeStep` concatenates per-scene finals (`demo-video.ts:442`). Scene
boundaries are the unit the retimer, the narration anchors and the concat all operate on. A
continuous take would require inferring scene boundaries back out of the action log, and would
destroy per-scene repair.

### 2. Continuity is a per-scene contract

Each scene is declared `chained` or `independent` by the rehearsal agent.

| Kind | Recording call | Page state |
|---|---|---|
| `independent` | `open <startUrl>` then `record start` | reset (fresh browser context) |
| `chained` | `record restart <path> --log-actions <path>` | **preserved** — same live page |

*Evidence:* `handle_recording_start` (agent-browser `native/actions.rs:4528`) creates a fresh
browser context, opens `about:blank`, then `Page.navigate`s. `handle_recording_restart`
(`native/actions.rs:4719`) does none of that — it stops the frame-capture task and starts a new
one against `browser.active_session_id()`. Cookies and localStorage survive both; DOM/SPA state
survives only `restart`.

**Retry fallback:** retrying a `chained` scene falls back to `open <startUrl>` + `record start`,
because scene N's wreckage is not a valid start state. Continuity is sacrificed for that take
only.

**Known gotchas:**
- The cursor resets on every start *and* restart (`recording.rs:116` sets
  `state.cursor = CursorTracker::default()`; restart re-runs `cursor::install`). Cursor position
  is not continuous across scene boundaries regardless of approach.
- `record restart <path> <url>` **parses the URL and silently ignores it** — the handler never
  reads `cmd.get("url")`. Report upstream. Do not rely on restart to navigate.

### 3. Rehearsal output is executable, with prose alongside

```json
{
  "sceneId": "scene-03",
  "continuity": "chained",
  "oneShot": false,
  "goal": "Create a board and add the first list",
  "gotchas": ["cookie banner appears on first load only"],
  "narrationHint": "confident, matter-of-fact",
  "actions": [
    { "cmd": "find role textbox --name \"Board title\" fill \"{{boardName}}\"",
      "assert": "--text \"{{boardName}}\"", "settleMs": 400, "narrationAnchor": 0 },
    { "cmd": "click 'form button[type=\"submit\"]'",
      "assert": "--url 'https://app.x.com/b/'", "settleMs": 900 }
  ],
  "endUrl": "https://app.x.com/b/",
  "startUrl": "https://app.x.com/boards"
}
```

The `actions[]` array drives recording. The prose drives the narrator and Gate B review.
Two audiences, one artifact.

**Locators must be durable.** `@eN` refs are not — the RefMap stores `{role, name, nth,
frame_id, backend_node_id}` and falls back to an accessibility-tree re-query by role/name/nth
when the node id goes stale (`element.rs:157-190`). So the durable form of a resolved ref is
`find role <role> --name "<name>" --exact`, never `@e17`.

### 4. Deviation handling — camera-off recovery, retake

Each scripted step carries its own assertion. **Detection needs no LLM**: a command that errors
or an assertion that times out *is* the deviation signal. The happy path therefore costs zero
tokens.

```
step 3 fails
  record stop                       ← camera off
  recovery agent clears the blocker ← not in the video
  retake the scene from step 1
```

**Recovery is bounded and narrow:** ≤3 commands, and it is **forbidden from performing any of
the scene's own scripted actions**. It may dismiss a banner, close a modal, scroll. It may not
click Create. Violating this breaks the retake (already-done work) and the narration anchors.

**Chosen: Option B (retake).** Reuses the existing 3-attempt loop, no new code, no visual seam.
**Deferred: Option A (stitch)** — keep `seg1 + seg2`, concat `-c copy` before the EDL, rebase
segment 2's `tsMs` by segment 1's duration. **Trigger to build it:** when a scene routinely
needs more than ~10 steps.

### 5. Scene shape — dynamic, split long flows

The agent decides scene count and length freely. Drop `.max(12)` from `scenePlanSchema`
(`schemas.ts:41`); keep `.min(1)`.

**Rehearsal prompt guidance:** *when a flow runs long, split it into consecutive `chained`
scenes rather than one long scene.* Because chained scenes don't reload, the viewer sees one
continuous action while the pipeline gets small repair units. This is what keeps Option B cheap
on a ten-minute demo.

### 6. One gate, after rehearsal

**Gate B only.** No pre-rehearsal approval. Rejecting the plan does not waste the rehearsal —
the findings and the conversation both survive, so revision is cheap.

**Scope protection without a second gate:** rehearsal asks early via `ask_user` when scope is
ambiguous — *"I found these 8 flows. Which should the demo cover?"* — after light discovery,
before investing in walking any of them.

Gate B must surface, at minimum: flows that could not be completed, `oneShot` flows,
blockers found, and anything that deviated from the stated intent.

### 7. Rehearsal is a mode of the existing AgentController

Not a new bare agent. It needs sessions, `Memory`, suspension on `ask_user`, and restart
survival — all of which `AgentController` + LibSQL already provide for the chat agent
(`controller.ts:446`).

Mode structure becomes: **director/rehearse** → `submit_plan` (Gate B) → **execute**.

### 8. One rehearsal agent — one turn per flow

Same agent, same thread, same memory. The workflow calls it once per flow rather than once for
the whole demo.

*Why not one long call:* a 12-scene demo is ~70 browser steps, each preceded by a snapshot of
1–5k tokens — 70k–350k tokens of snapshots in one conversation. Today's recorder gets
`maxSteps: 30` for **one** scene.

One turn per flow gives: step budget ~30–40 per turn, Observational Memory activating between
turns (its documented behaviour), and a natural checkpoint boundary for resume.

### 9. Memory — Observational Memory plus durable files

```ts
new Memory({
  storage: mastraStore,
  options: {
    observationalMemory: {
      model: <the user's configured model>,   // NOT the google default
      scope: "resource",                       // knowledge spans runs on the same product
      retrieval: true,                         // `recall` tool for raw messages behind a summary
      observation: {
        instruction:
          "Focus on: which selectors were ambiguous and what worked instead; " +
          "waits that were required; flows that were blocked and why; " +
          "state this rehearsal created in the product.",
      },
    },
  },
})
```

**Critical constraint:** OM *summarises*. It will compress `@e17 button "Create board"` into a
description, destroying the exact locator. Therefore **the agent must write each proven step to
`script.json` at the moment it proves it**, never batching to the end. The files hold precision;
memory holds understanding.

`observationalMemory` defaults to `google/gemini-2.5-flash`. Demio supports Anthropic, OpenAI,
Google and Bedrock keys (`store/provider-keys.ts`) — a user with only an Anthropic key breaks
unless the model is pointed at their configured provider.

### 10. Persistence and resume

**Written incrementally, per flow:**

| Artifact | Contents |
|---|---|
| `rehearsal/script.json` | executable steps, appended per flow as proven |
| `rehearsal/findings.md` | ambiguous selectors, required waits, blockers, **state created** |
| `rehearsal/screenshots/` | per-step, for human review and a future judge |
| `rehearsal/<flow>.agent.json` | write-only transcript, debug only |

**Two resume paths**, chosen by whether the agent-browser daemon survived:

- **Case A — app still running** (user answered `ask_user` late, stream stopped and resumed).
  Daemon alive, page intact. **Resume as-is.** No rewind.
- **Case B — app restarted.** The browser is *guaranteed* gone: `cleanupStaleSessions()` runs
  `close --all` at app start specifically to kill crash leftovers (`daemon.ts:18-32`), and
  `before-quit` closes everything (`main.ts:144`). **Rewind to the current flow's start** —
  re-open its start URL, fresh snapshot, and inject: *"The app restarted. The browser was reset.
  Everything you learned is still valid; everything you did in the page is gone."*

The conversation keeps the **knowledge**; only the **work** rewinds, and only to a clean flow
boundary. This requires the checkpoint to record *which flow is in progress and its start URL*,
not only which flows are done.

### 11. Idempotency — products are not idempotent

Rehearsal is not a dry run: to prove a step works it must actually click Create. Every write
flow therefore runs twice.

**Three-part fix, all required:**

1. **Parameterise script data.** `fill "{{boardName}}"`, not `fill "Demio QA"`. Rehearsal and
   recording resolve it to different values. *Cost:* rehearsal proves the flow's shape, not the
   exact keystrokes — a field that rejects the record pass's value but accepted rehearsal's slips
   through. Accepted.
2. **Rehearsal records what it left behind** in `findings.md`: boards created, items archived,
   invites sent. Diagnosable now; consumable by a cleanup step later.
3. **`oneShot: true` as a first-class field**, not prose. For flows that cannot be
   parameterised away — sending a real invite, cancelling a subscription, a first-run onboarding
   wizard. **Gate B stops and asks**, offering: record the rehearsal itself (accepting fumbling
   for that scene), skip it, or "I've reset the account, proceed".

### 12. Credentials — vault, scoped to the run

- Rehearsal captures credentials once via `ask_user` (one field per call), then saves them to
  the agent-browser vault with the login-form selectors **it just discovered**:
  `auth save <profile> --url <login> --username <u> --password-stdin
  [--username-selector …]`. `--password-stdin` keeps the password out of command lines, logs and
  action logs.
- **Recording runs a camera-off pre-flight**: if the session is dead, `auth login <profile>`
  silently before `record start`. Only if that fails does it ask the user — **before** any
  recording, never during.
- **Demio never stores the password itself.** Same reasoning that kept `elevenLabsKey` out of
  the workflow input schema (`demo-video.ts:58-64`): `createRun`/`start`/`resume` snapshot
  `inputData` into a LibSQL row on every suspend, and a user password has less business there
  than an API key.
- **Run-scoped.** Delete the profile after compose, **and** on abort, **and** on thread deletion.
  A next-day approval whose session has expired falls back to asking — acceptable.

### 13. Verification — replay owns process, verify owns artifact

| Concern | Owner | Checks |
|---|---|---|
| **Process** | replay, in real time | every scripted step ran; every assertion passed; log length == script length. Failure triggers camera-off recovery immediately. |
| **Artifact** | `verifyScene`, after the file exists | video exists and is non-empty; **computed** duration (script waits + TTS durations) within tolerance; `blackdetect`; `freezedetect`; audio track present when a voice was configured. |

Consequences:
- **The 120s duration clamp dies** (`verify.ts:55`). Duration becomes a real check again: a take
  40% short means something silently didn't happen.
- **`end-url` as a check disappears** — it is an *assertion inside the script*, sourced from
  rehearsal's observation rather than the planner's guess.
- The failure that passes today — right URL, wrong page — is caught by a per-step assertion at
  the moment it happens.

### 14. Narration — written during rehearsal, paced into the recording

Rehearsal writes narration (it knows the steps in advance). TTS runs **after Gate B, before
recording**, so every line's duration is known before a frame is captured.

**Those durations set a minimum wait after each step during replay.** The line over step 3 is
4.2s → step 3 gets at least 4.2s of *live* footage. Today the EDL instead clones the last frame
to stretch the moment (`edl-pure.cjs`), which is why parts of current videos are static.

**The EDL remains the authority.** It now covers a fraction-of-a-second shortfall instead of a
multi-second one. Revise a line later and nothing breaks — the EDL absorbs it exactly as today;
you lose optimal pacing, not correctness.

This works because recovery is forbidden from performing scene steps (§4), so a take's action
log matches the script one-for-one and script-indexed anchors resolve correctly.

### 15. Final-output evaluation — deterministic now, judge deferred

**Ship now (no LLM):** the artifact checks in §13, plus post-compose `ffprobe` sanity — duration
≈ sum of scene durations, expected scene count. These catch the silent degradations that ship
today: a skipped scene (`demo-video.ts:205`), a fully silent video from a missing ElevenLabs key
(`demo-video.ts:273`).

**Deferred — the vision judge.** Shape agreed for when it is built:
- Runs **per scene, before joining** — so a rejection has an obvious repair unit.
- Compares recorded frames against **rehearsal's per-step screenshots** plus the scene goal.
  Sharp question ("does this match what we proved works?") rather than fuzzy ("is this good?").
- Rejects with a **specific, actionable reason**, not a verdict.
- **One automatic retake, then the user decides** — retry with guidance / accept anyway / skip /
  abort. Bounded: two agents must never be able to argue with each other indefinitely.

Keep rehearsal screenshots regardless. They cost nothing and are useful for human review now.

---

## ADR impact

| ADR | Impact |
|---|---|
| ADR-003 (scene retry) | Amended. Retry budget stays 3, but failures are now classified: process deviations trigger camera-off recovery; plan-contract failures largely cease to exist. |
| ADR-004 (mechanical verification) | Amended. Layer 1 splits into process (replay) and artifact (verify). Layer 2's shape is now specified. |
| ADR-005 (recording lifecycle) | Reaffirmed and extended. The harness still owns `record start`/`stop` — and now also owns `record restart` and the camera-off recovery window. |
| ADR-011 (workspace primitive tools) | Unchanged. |

## Open risks

- **`record restart` behaviour under load / long chains** is untested at demo scale. Chaining 15
  scenes on one live page has no precedent in this codebase.
- **Parameterised data can diverge from proven data** (§11.1) — a validated field could accept
  rehearsal's value and reject recording's.
- **Observational Memory activation inside long turns** is not documented. The one-turn-per-flow
  design avoids depending on it, but if turns grow this assumption needs re-testing.
- **Rehearsal is now the single point of failure.** Everything downstream trusts its script. A
  confidently wrong rehearsal produces a confidently wrong video with no fumbling to signal it —
  which is exactly what makes the deferred vision judge eventually necessary.
