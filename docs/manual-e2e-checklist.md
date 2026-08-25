# Manual End-to-End Checklist

This document contains manual tests that cannot run in CI. These checks require a real browser, a live website, and human observation of video playback. They are the gate for validating architectural assumptions before a plan's automated systems are built.

## Replay foundation (plan: 2026-08-24-replay-foundation)

Prerequisite: `bun start`, a thread open, a model configured. No rehearsal agent
exists yet — the script is supplied by hand.

1. **Feed the fixture.** In the thread's workspace, save
   `docs/superpowers/fixtures/example-script.json` as the approved plan and call
   `generate_demo` with it.
2. **Watch scene-01.** Expect exactly one `open`, one `record start`, one fill, one
   wait. Confirm in the shell cards that **no snapshot is taken** — replay must not
   look at the page.
3. **Confirm continuity on scene-02.** Expect a single `record restart` command and
   **no `open`**. Play `scenes/scene-02.webm`: the first frame must already show the
   filled search box from scene-01. If the page is blank or reloaded, `record restart`
   is not preserving state — stop and investigate before continuing.
4. **Force a deviation.** Edit the fixture so scene-01's `cmd` targets a role that does
   not exist (e.g. `find role slider fill "x"`). Re-run.
   - Expect: replay stops at step 0, `record stop` runs, the recovery agent runs
     **after** the stop, and a retake follows.
   - Play the take: **the failed attempt must not appear in any video file.** This is
     the single most important assertion in this checklist.
5. **Confirm the recovery boundary.** Read
   `scenes/scene-01.attempt-1.agent.json`. The recovery agent's commands must contain
   none of the script's own commands.
6. **Check the artifact report.** After a clean run, confirm the `VerifyReport` carries
   `video-exists`, `duration-range`, `black-frames`, `freeze-frames` — and that
   `duration-range` reports an *expected* value derived from the script, not a
   `[4, 120]` range.
7. **Confirm the audio check fires.** With an ElevenLabs voice configured, confirm
   `audio-track` appears. The raw `.webm` has no audio, so this check is expected to
   **fail** at this stage — that is correct until plan 3 moves TTS ahead of recording.
   Note the failure; do not "fix" it here.
