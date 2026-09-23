# Ideas for Improving the Agent Harness and Evals

## 1. Mocking LLM Responses for Fast & Hermetic Evals
Currently, running the evals with a dummy API key (e.g., `GOOGLE_API_KEY=dummy bun run eval ...`) sends a real network request and fails with a `400 Bad Request` ("API key not valid").
**Idea:** Implement a mocking layer for the `fetch` calls inside `electron/agent/providers.ts`. We could use a library like `msw` (Mock Service Worker), or update the `instrumentedFetch` wrapper to intercept requests during tests and return recorded fixture responses. This would make the evaluations truly hermetic, fast, and eliminate the dependency on a live API and billing costs during continuous integration.

## 2. Fix the ESM Resolution & `safeStorage` Issues outside Electron
In `electron/store/provider-keys.ts`, `safeStorage` is resolved via `createRequire(import.meta.url)("electron")`. However, running these files in plain Node/Bun environments exposes ESM resolution issues (e.g. `ERR_MODULE_NOT_FOUND`).
**Idea:** We should refactor these files to correctly handle cross-environment compatibility so it can be evaluated outside of Electron without `ERR_MODULE_NOT_FOUND`.

## 3. Implement Tier 2 "Online Evals Proper"
`docs/superpowers/plans/evals.md` states: *"Once 1a exists, the same scorers can run inside the app on every recovery, via onlineEval... This is how the next new failure shape gets caught on the day it first happens."*
**Idea:** Wire up the heuristic and LLM-as-judge scorers to actively run asynchronously in the background of the Electron app after an agent completes a task. This enables telemetry on whether a run succeeded, how many shell commands reached outside the workspace, etc.

## 4. Improve the `fake-agent-browser` Stub
The `recovery.eval.ts` spins up a fake agent browser.
**Idea:** We can improve the agent browser harness by creating a more declarative state machine for the mock browser. Allowing it to simulate dynamic states like page loading delays, network failures, or changing DOM elements over time would make our agent recovery evaluations much more robust.

## 5. Expand Unit/Eval Coverage for Other Agent Tasks
We have `recovery.eval.ts`, `narrate.eval.ts`, and `title-generator.eval.ts`.
**Idea:** We should add an evaluation for `demo-video.ts` measuring the final composed video structure, proper handling of missing assets, or pacing errors.
