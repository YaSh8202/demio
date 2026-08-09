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
