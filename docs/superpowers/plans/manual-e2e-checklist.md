# Manual E2E checklist — Mastra migration (Task 14)

Run against a fresh `bun start`. All items are interactive/GUI and were not
automatable in this environment (headless/sandboxed boot, no display for
window interaction) — a human must drive these.

Setup: a voice-configured project (ElevenLabs key present) with at least one
existing pre-migration thread if available (for item 8).

## A. Full pipeline run (brief Step 1)

1. **New thread, demo request** — In a fresh thread on a voice-configured
   project, send: "Create a demo of https://demo.playwright.dev/todomvc —
   add three todos, complete one."
   Expected: plan mode starts exploring the site (tool cards for browser
   actions appear), may call `ask_user` for clarification.

2. **ask_user round-trip** — If the agent calls `ask_user`, answer it.
   Expected: an `AskUserCard` renders with the question/options; after
   responding it flips to a resolved/answered state (not stuck pending).

3. **submit_plan → approve** — Agent submits a scene plan via
   `submit_plan`.
   Expected: a plan-review UI appears with the proposed scenes; approving
   it flips the thread from plan mode to execute mode.

4. **Mode flip visible** — After approval.
   Expected: UI reflects execute mode (mode indicator changes; tools
   available shift from plan-only to execute-only, e.g. `generate_demo`
   becomes callable).

5. **generate_demo progress card** — Execute mode calls `generate_demo`.
   Expected: a progress card appears showing scene rows, each advancing
   through per-attempt status (queued → recording → verifying → done/failed)
   as the workflow runs.

6. **Forced scene failure → retry → suspension → skip** — Before/during this
   run, edit the plan's `endUrl` for one scene to a URL that can never be
   reached, forcing verification failure.
   Expected: that scene retries up to 3 attempts (visible per-attempt in the
   progress card), then a suspension card appears (workflow paused, asking
   how to proceed). Choose "skip".
   Expected: pipeline resumes and continues with the remaining scenes
   (doesn't hang, doesn't abort the whole run).

7. **Final video presented and playable** — Once all scenes finish,
   `output/demo.mp4` is presented via a video panel in the thread.
   Expected: video is playable inline, voiceover audio is audible, and
   scenes play back concatenated in the plan's order (matches the scene
   sequence, not scrambled).

8. **Refresh mid-recording re-hydrates** — While a `generate_demo` run is
   actively recording (mid-scene), refresh/reload the renderer window.
   Expected: the thread re-hydrates showing prior messages with no
   flicker/revert, and the progress card resumes updating live (not stuck
   showing stale state, not duplicated).

9. **DB sanity** — After the run, `~/.demio/mastra.db` exists; run
   `sqlite3 ~/.demio/mastra.db ".tables"` and confirm Mastra tables are
   present with workflow snapshot rows for the run just completed.

## B. Regression checklist (brief Step 2, interactive parts)

10. **Plain chat still works** — In a thread, send an ordinary chat message
    with no demo request (e.g. "what's 2+2").
    Expected: streams a normal assistant reply with no tool cards, no
    plan/execute mode weirdness.

11. **Cancel mid-recording** — Start a `generate_demo` run, click Cancel
    while a scene is actively recording.
    Expected: the run aborts promptly, `agent-browser record stop` fires
    (check agent-browser daemon logs / no orphaned recording process), and
    starting a new `generate_demo` run afterward does NOT hit a stuck
    "Recording already active" error.

## C. Accumulated notes from Tasks 5 & 6 (carried into this checklist)

12. **Pre-migration thread opens with legacy fallback** — Open a thread that
    was created before this migration (old message format on disk, if one
    exists in `~/.demio`).
    Expected: it opens without error via the legacy-message fallback path
    (not a blank/broken thread), even though it never ran through the new
    AgentController.

13. **Workspace tool cards render** — During plan/execute mode, workspace
    tools (read_file, write_file, execute_command, browser actions, etc.)
    should render as distinct tool-call cards, not raw JSON or generic
    fallback cards.
    Expected: each known workspace tool has a recognizable, purpose-built
    card UI.

14. **Resolved ask_user card** — After answering an `ask_user` prompt (item
    2 above), confirm the card visually reflects "answered" state and does
    not remain interactive/re-clickable.

15. **Double-click suspension guard** — On a suspension card (e.g. the
    retry/skip choice from item 6), rapidly double-click a response option.
    Expected: only one response is sent (guarded against double-submit);
    no duplicate resume calls / no crash.

16. **Error styling after dismiss** — Trigger a tool error (e.g. a failing
    scene attempt) and dismiss/acknowledge it.
    Expected: the card retains distinct error styling after dismissal
    rather than reverting to a neutral/success look.

17. **present_files video panel** — Confirm the `present_files` tool (used
    to surface `output/demo.mp4`) renders a video panel component, not a
    generic file link.

18. **Parallel prompts (known limitation)** — If the agent attempts two
    `ask_user`-style suspensions in close succession, confirm behavior is
    at least non-broken: only one suspension surfaces interactively at a
    time (this is a documented framework limitation, not a bug — verify it
    degrades gracefully rather than corrupting UI state).

19. **Refresh mid-run — no message flicker** — Refresh the window during an
    active (non-recording) agent run, e.g. mid plan-mode tool call.
    Expected: no message list flicker/revert to an earlier state on
    re-hydration.

20. **Forced hydration failure — no silent blank** — Simulate a hydration
    IPC rejection if feasible (e.g. corrupt/lock the store briefly, or
    trigger while store is mid-write) when opening a thread.
    Expected: an explicit error state is shown, not a silently blank
    thread.

## D. Milestone 2 — sync/retiming (Task 7)

21. **Offline render smoke test (optional, automatable)** — Against a real
    archived scene (`scenes/scene-01.webm` + `scene-01.actions.jsonl` from an
    existing workspace), run `edl-pure.cjs`'s `buildEdl`/`validateEdl` and
    render the slots + concat with ffmpeg by hand (no app boot, no LLM). See
    `.superpowers/sdd/2026-08-02-sync-retiming-engine/task-7-report.md` for
    the exact script and a passing run.
    Expected: `validateEdl` returns `{"ok":true,"errors":[]}`; retimed
    duration is within ±1s of `edl.totalMs / 1000`; scrubbing through evenly
    spaced frames shows no long static stretches, each typed todo is visible
    on screen, and intro/outro freeze frames look like a calm page (not a
    mid-motion smear). This item is optional/offline — done once as
    engineering verification, does not need to be repeated per release.

22. **Live voiced run renders retimed, tightly-timed output** — `bun start`,
    new thread, generate a TodoMVC demo on a voice-configured project.
    Expected: workspace contains `scenes/*.edl.json` and `scenes/*.final.mp4`
    per scene, plus `output/demo.mp4`; total duration is in the tens-of-
    seconds-tight range (not padded out to the raw recording length).

23. **Narration/action alignment listen-through** — Play back the voiced
    `output/demo.mp4` from item 22 start to finish with audio on.
    Expected: narration about typing/clicking plays while that action is
    visible on screen (not before or after it), no narration is cut off
    mid-word, and there are no silent+static stretches longer than ~3s.

24. **Voiceless run still retimes (idle cut), edl.json shows empty
    segments** — Remove the project voice (or use a project without one
    configured) and regenerate the same demo.
    Expected: the demo still renders retimed (idle time cut, not raw-length
    passthrough) with a silent audio track, and the scene's `edl.json` has
    `segments: []`.

## E. Replay foundation (plan: 2026-08-24-replay-foundation)

Prerequisite: `bun start`, a thread open, a model configured. No rehearsal agent
exists yet — the script is supplied by hand in the fixture.

**Known limitation:** A scene with no `script` fails loudly, naming the scene id.
This is deliberate — nothing generates scripts yet, and rehearsal (plan 2) is
what will populate them. The fixture exists precisely because a script must be
hand-written until then.

**Known limitation:** A **state-dependent `chained` scene is effectively
single-attempt.** Any retry — an internal one from `recordSceneWithRetry`, or a
"retry" you choose on the suspension card — re-opens `script.startUrl` in a
fresh recording context, because the previous attempt's half-executed page is
not a valid start state. That fresh navigation throws away exactly the in-page
state the chained scene continues from. So if `scene-02` fails, expect its
attempts 2 and 3 to fail identically (on the fixture: Main_Page reloads with an
empty search box, and `press Enter` does nothing), and expect a recovery LLM run
before each. That is the designed behaviour, not a bug — do not read the
repeated identical failures as a flaky browser. Skip such a scene rather than
retrying it, and treat the FIRST attempt's failure as the one worth diagnosing.

25. **Request a plan, suspend at submit_plan, inject the fixture.** In a fresh
    thread, ask the agent to "create a demo of https://en.wikipedia.org/wiki/Main_Page
    showing how search works." The agent explores plan mode, then suspends on
    `submit_plan` with a file path. Do not approve yet.
    - Open a terminal and navigate to `~/.demio/workspaces/`
    - Find the active thread's directory (workspace directories are named by threadId)
    - Inside `plans/`, find the `.md` file the agent just wrote
    - Replace the scene plan JSON (inside the fenced ` ```json ` block) with the
      fixture from `docs/superpowers/fixtures/example-script.json`
    - Save the file
    - Approve the plan in the UI
    Expected: the plan approval reads the updated file from disk, extracts the
    fixture JSON, and mode flips to execute.

26. **Watch scene-01 replay without snapshot.** Expect exactly one `open`, one
    `record start`, one fill (semantic locator action), one wait (assertion).
    Confirm in the shell cards that **no snapshot is taken** — replay must not
    look at the page; it reads only the action log.
    Expected: the scene runs deterministically from script alone, with no image
    comparison or browser introspection during playback.

27. **Confirm continuity on scene-02 via first frame.** Expect a single
    `record restart` command and **no `open`** — the browser stays on the filled
    search page. Play `scenes/scene-02.webm`: **the first frame must already show
    the filled search box from scene-01**. If the page is blank or reloaded,
    `record restart` is not preserving state — stop and investigate before
    continuing.
    Also confirm, in the same terminal, that `scenes/scene-02.actions.jsonl`
    **exists** and that its **first entry's `tsMs` is near zero** (a second or
    two at most, not tens of seconds):
    `head -1 scenes/scene-02.actions.jsonl`
    `record restart` is a different code path from `record start`, and its
    handler is known to accept-and-ignore at least one of its arguments — so
    `--log-actions` may be dropped, or timestamps may continue from the prior
    recording's time base instead of restarting. Either would go unnoticed
    until `sync.ts` runs `validateEdl`, which is **after every scene has
    already been recorded** — `edl-pure.cjs`'s grouping math is relative to
    the recording timeline. Catch it here, at scene 2, not at the end of the
    run. If the file is missing or its first `tsMs` is large, stop and
    investigate.
    Expected: scene chaining works via shared page state, not re-navigation.
    This single observation validates the continuity half of the entire design.

28. **Force a deviation to test recovery isolation.** Edit the fixture in the
    thread's workspace (not the source file) so scene-01's `cmd` targets a role
    that does not exist (e.g. change `find role searchbox` to `find role slider`).
    Re-run `generate_demo`.
    - Expect: replay stops at step 0, `record stop` runs immediately, the recovery
      agent runs **after** the stop (with recording off), and a retake follows.
    - Play any resulting video file: **the failed attempt must not appear in any
      video file.** This is the single most important assertion in this checklist.
      Failed recordings must be discarded, not leaked into output.
    Expected: recovery isolation holds — no frame of the failed attempt reaches
    any `.webm` or `.mp4`.

29. **Confirm the recovery boundary.** Read `scenes/scene-01.attempt-1.agent.json`
    and look at its **`recovery.steps`** array — the recovery agent's own
    generation steps, persisted there after recovery runs. (`replay` in the same
    file is the deterministic replay that deviated; it is not the agent.) The
    commands inside the agent's tool calls must contain none of the script's own
    commands (must not include `find role searchbox` or `press Enter`), and
    `recovery.detail` should read `CLEARED: …` or `BLOCKED: …`.
    Expected: recovery is scoped to clearing blockage, not re-performing the scene.

30. **Check the artifact report.** After a clean run (with fixture restored),
    confirm the `VerifyReport` carries checks: `video-exists`, `duration-range`,
    `black-frames`, `freeze-frames`. Confirm `duration-range` reports an *expected*
    value derived from the script (sum of `settleMs` plus action baseline), not a
    `[4, 120]` range.
    Expected: verification knows the expected recording duration from the script,
    and can flag recordings that deviate significantly from it.

31. **Note audio-track absence (expected at this stage).** `audio-track` does not
    appear in the `VerifyReport` at all — the check is skipped entirely because
    `voiceExpected` is hard-coded `false` in `demo-video.ts`. This is correct:
    TTS is synthesized and muxed *after* every scene records, so a raw scene
    `.webm` can never carry narration at verify time. A later phase (plan 3) moves
    TTS ahead of recording and flips `voiceExpected` to `init.voiceId !== null`.
    Do not try to add audio to the scene at this stage; that work is planned.
    Expected: audio absence is understood as a pipeline sequencing issue, not a
    bug in replay or verification.

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
