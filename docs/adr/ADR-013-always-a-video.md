# ADR-013: Every Run Ends With a Video — Degrade Loudly, Never Silently

Date: 2026-09-20
Status: accepted
Supersedes: the suspend-on-exhaustion clause of ADR-003; the "NO silent degrade to unretimed video" rule in `docs/superpowers/plans/2026-08-02-sync-retiming-engine.md`

## Decision

A run terminates, and it terminates with `output/demo.mp4`. When a stage cannot do its job the harness falls back one rung and carries on; it does not stop and it does not ask. Every fallback is recorded on the run's scorecard line as `degraded: [{stage, reason, sceneId?}]` and told to the user in chat once the video is delivered.

The only run that ends without a video is one the harness could not have saved: no browser, no ffmpeg, the domain unreachable, or the user cancelled.

## Context

The harness could not make this promise, and with a weak model it broke it routinely:

- A turn could end "normally" — plain text, a blocked rehearsal, an exhausted step budget — with no video and no error.
- A scene that failed its three takes suspended the run on a `retry | skip | abort` question (ADR-003). A user who had walked away came back to nothing, and the parked run read as `isRunning: false`. For a state-dependent `chained` scene, `retry` could never succeed (`record-scene.ts`: the retry re-opens `startUrl` and discards the state the scene continues from).
- `narrate`, `tts` and `sync` had no fallback. A throw in any of them, after every scene was recorded, left the takes on disk and no `demo.mp4`.
- Nothing had a wall-clock limit.

The sync plan forbade degrading for a good reason: a fallback hides the bug that triggered it. That reason is kept. What changes is how it is served — not by refusing to degrade, but by making a degradation impossible to miss: it is on the scorecard, in the chat, and `smoke report` fails on any degradation a scenario did not expect.

## The ladder

| When | The harness |
|---|---|
| A scene fails its retry budget | drops the scene, records it, continues. A `chained` scene whose predecessor was dropped is dropped too — its start state no longer exists. A state-dependent chained scene gets one attempt, not three. |
| `narrate` or `tts` fails | delivers a silent video |
| `sync` fails for a scene | uses that scene's raw take, transcoded to the concat's uniform stream parameters |
| The stream-copy concat fails | re-encodes; a part that is missing is left out |
| A stage outlives its wall-clock budget | is aborted, and treated as that stage failing |
| The agent's turn ends with no video and no open gate | is nudged, at most twice, with what is missing and what to call next |
| It is still stalled, and rehearsal proved at least one scene | the harness builds the scene plan from `rehearsal/scripts.json` and starts the workflow itself |
| No scene survives — whatever the cause | records the floor scene: open the domain, slow scroll. Labelled as a fallback, never passed off as the demo. |

`ask_user` and `submit_plan` are untouched. They are the user's decisions; the ladder only covers what the harness was previously asking the user to rescue.

## Consequences

- ADR-003's bounded retry stays. Its suspension does not: after the retry budget the scene is dropped. `generate_demo` no longer suspends, and `activeDemoRuns` no longer has a resume role.
- A degraded run is a successful run with findings, not a failed one. `smoke report` exits 1 for it, 2 only when there is no video.
- Each rung is proven by a hermetic test (`bun run test:harness`) that forces the failure through `DEMIO_FAULT` — a rung that only fires on a bad day is a rung nobody has seen work.
- The floor video is reported as `critical`. It keeps the promise to the user and is never mistaken for success by whoever reads the report.
- A fallback that fires often is a bug report, not a feature. The scorecard makes the rate visible.
