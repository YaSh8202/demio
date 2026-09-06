# Demo test prompts

A catalog of domains and prompts for exercising the rehearse → record pipeline,
ordered from "nothing can go wrong" to "everything that broke this week". Each
level adds one mechanism on top of the previous one, so when a level fails you
know which mechanism to look at.

Companion to `manual-e2e-checklist.md` — the item numbers below (32–46) refer
to section F of that file.

## How to run one

1. **Restart the app.** Prompts, workflows and the controller are main-process
   code; Vite HMR does not pick them up.
2. **Fresh thread per run.** A suspended run holds a frozen scene snapshot and
   will not route through new code.
3. The **Domain** box takes a bare hostname (`normalizeDomain` strips the
   scheme and anything after the first `/`). Any path goes in the prompt text.
4. Artifacts land in `~/.demio/workspaces/<threadId>/`:
   `rehearsal/scripts.json`, `rehearsal/checkpoint.json`,
   `rehearsal/findings.md`, `scenes/<id>/*.agent.json`, `*.actions.jsonl`.
   The main log is `~/Library/Logs/demio/main.log`.
5. **Never write credentials into this file** or into a prompt. Level 3 uses
   sites that print their own test credentials on the login page; Level 4 uses
   your own test account, entered through `save_login`'s `ask_user` prompts.

Entry template:

| Field | Meaning |
|---|---|
| Domain | exactly what goes in the domain box |
| Prompt | verbatim, pasted into the description box |
| Voice | on / off |
| Creds | none / on the login page / your own test account |
| Exercises | the mechanism this prompt is here to test |
| Expect | what a pass looks like, with checklist items to tick |
| Weak spot | where it is most likely to fail, and what that failure means |

---

## Level 0 — Smoke

Public, static, read-only, one scene, no voice. Proves the pipeline end to end
with nothing that can fail for product reasons. If this fails, the problem is
plumbing (daemon, shim, ffmpeg, IPC), not the agent.

### 0.1 One page, one scroll

- **Domain:** `example.com`
- **Prompt:** `A 10-second demo: open the homepage and scroll to the bottom. One scene, no narration.`
- **Voice:** off
- **Creds:** none
- **Exercises:** `open` → `wait --load complete` → `record restart`, compose, the "Video ready" card.
- **Expect:** one scene, no black frames (`ffmpeg -vf blackdetect` on the output), `scripts.json` has one scene with no `@e` refs (item 36). Duration within a couple of seconds of the plan.
- **Weak spot:** the shim copy failing on thread creation (`Failed to create shim …/bin/agent-browser`, ENOENT). If the run never starts, check the log for that line first.

### 0.2 Two independent scenes

- **Domain:** `developer.mozilla.org`
- **Prompt:** `Two short scenes. Scene 1: open the homepage and hover the main navigation. Scene 2: open /en-US/docs/Web/JavaScript and scroll through the first section. Both scenes start from a fresh page load.`
- **Voice:** off
- **Creds:** none
- **Exercises:** `continuity: independent` for both scenes; two `open`s; the plan-file scene-id check (item 41).
- **Expect:** two scenes, each starts on its own `startUrl`. Scene ids are `<flowId>.01`, `<flowId>.02` exactly as `rehearse_flow` returned them.
- **Weak spot:** the agent deciding on its own to chain them. If scene 2's first frame is scene 1's end state, the prompt's "fresh page load" was ignored.

---

## Level 1 — Async content and preconditions

Public sites whose content arrives after the page load. This is the level that
produced failure #1 (click at 160ms into an unrendered list). Bot-tolerant sites
only — npm/GitHub search will rate-limit or wall the daemon.

### 1.1 Search with a lazy results list

- **Domain:** `en.wikipedia.org`
- **Prompt:** `Show searching Wikipedia. Type "Electron (software framework)" into the search box, wait for the suggestion dropdown, click the first suggestion, and scroll the article's infobox into view. Keep it under 20 seconds.`
- **Voice:** off
- **Creds:** none
- **Exercises:** `waitBefore` on the suggestion click; the precondition-gating path in `runScript` (a failed precondition never attempts the command).
- **Expect:** the click action carries `waitBefore` (a `--text` or selector wait) in `scripts.json`. The dress rehearsal passes. Replay shows the dropdown rendered before the click.
- **Weak spot:** rehearsal proving `wait X && click Y` and writing only `click Y`. Grep `scripts.json` for `waitBefore` — if it is absent on the click, the schema `.describe()` is not landing in the prompt.

### 1.2 Chained scenes across a navigation

- **Domain:** `en.wikipedia.org`
- **Prompt:** `One flow, three chained scenes with no reloads between them. Scene 1: open the "Electron (software framework)" article. Scene 2: click the "Chromium" link in the infobox. Scene 3: click "Talk" at the top of the Chromium article. Each scene must start where the previous one ended.`
- **Voice:** off
- **Creds:** none
- **Exercises:** `continuity: chained`, `record restart` on the live page, `endUrl` observed not guessed, `.actions.jsonl` non-empty per scene (item 44).
- **Expect:** scene 2's first frame is scene 1's last frame. Each scene's `endUrl` in `scripts.json` matches the URL the next scene's `startUrl` — and it is a real URL, not the flow's first URL repeated.
- **Weak spot:** a retry of scene 2 re-`open`ing `startUrl` and landing somewhere the chain did not expect. Force it: kill the network for 5s during scene 2 and watch the recovery path reposition via `positioningCommands`.

### 1.3 Vague prompt

- **Domain:** `en.wikipedia.org`
- **Prompt:** `Make a demo of this site.`
- **Voice:** off
- **Creds:** none
- **Exercises:** planning and clarification. The agent has nothing to go on.
- **Expect:** an `ask_user` asking what to showcase, OR a plan of 2–3 obviously reasonable read-only flows presented for approval. Either is a pass. Recording anything before the plan is approved is a fail.
- **Weak spot:** the agent inventing a "sign up" flow because it looks demo-worthy. Anything that creates state on a site you do not own is a fail regardless of whether it works.

---

## Level 2 — Write flows, no login

Client-side apps that hold state in the page. First appearance of `params`,
`state-created` findings and the rehearsal/record data split.

### 2.1 Create, edit, complete

- **Domain:** `todomvc.com`
- **Prompt:** `Demo the React TodoMVC example at /examples/react/dist/. Add three todos, mark the second one complete, then filter to "Active". Use realistic todo names, not "test".`
- **Voice:** off
- **Creds:** none
- **Exercises:** `{{param}}` substitution in `cmd` (item 37); `params` values that differ from what rehearsal typed; `findings.md` `state-created` entries (item 38).
- **Expect:** three `{{todoN}}`-style placeholders in `scripts.json`, each with a `params` value different from what you watched rehearsal type. The video shows the record-pass values (item 45).
- **Weak spot:** `localStorage` survives `record restart` inside one browser profile, so rehearsal's three todos may still be on screen when recording starts. The rehearsal should either clear them or the script should not assume an empty list. If the video opens on six todos, that is the finding to file.

### 2.2 Delete — a one-shot flow

- **Domain:** `todomvc.com`
- **Prompt:** `On /examples/react/dist/: add two todos, then delete the first one with the X button, then click "Clear completed" after completing the remaining one. End on an empty list.`
- **Voice:** off
- **Creds:** none
- **Exercises:** whether the agent flags any of this as `oneShot`. It should NOT — every step is reproducible with fresh data — so this tests false positives. The Gate B rehearsal report (item 40).
- **Expect:** no `oneShot: true` anywhere. The plan's `## Rehearsal report` says so explicitly. If a scene is marked `oneShot`, the dress rehearsal must have skipped it and said so.
- **Weak spot:** "delete" pattern-matching to "irreversible" in the prompt. Irreversible means *cannot be re-run*, not *removes something*.

### 2.3 Resume mid-rehearsal

- **Domain:** `todomvc.com`
- **Prompt:** Same as 2.1, but with `Two flows: (1) add and complete todos, (2) use the filter tabs and the "toggle all" checkbox.`
- **Voice:** off
- **Creds:** none
- **Exercises:** checkpoint resume (item 39). Quit the app while flow 2 is mid-rehearsal, reopen, ask it to continue.
- **Expect:** `checkpoint.json` shows flow 2 `in-progress` with its `startUrl`; the re-run re-opens that URL; no orphan `flow-2.03` if the second attempt only reached `.02`.
- **Weak spot:** an in-flight chat turn is not durable — expect the last message before the quit to be missing from the thread. That is known (`use-agent-events.ts` holds the only copy); an orphan scene in `scripts.json` is not known and is a bug.

---

## Level 3 — Login with public test credentials

Sites built for automation testing whose credentials are printed on their own
login page. Tests the vault with zero secret exposure. Tell the agent to read
the credentials off the page; do not put them in the prompt.

### 3.1 Standard `<form>` login

- **Domain:** `the-internet.herokuapp.com`
- **Prompt:** `Demo the login at /login. The test username and password are printed on the login page itself — read them from there. Sign in, show the secure area, then sign out.`
- **Voice:** off
- **Creds:** on the login page
- **Exercises:** `save_login` → test sign-in → `verified: true` on a real `<button type="submit">`; camera-off `auth login` in preflight (item 43); profile deletion on success (item 46).
- **Expect:** `save_login` returns `verified: true` on the first call with no selectors. The log shows `auth login` before the first `record restart`. `agent-browser auth list` no longer shows `demio-<threadId>` after the run.
- **Weak spot:** the agent typing the credentials into a `fill` command instead of calling `save_login`. Grep `scripts.json` for `SuperSecretPassword` — one hit is a prompt failure, even though the credential is public.

### 3.2 Logged-in state that must not be assumed

- **Domain:** `saucedemo.com`
- **Prompt:** `The accepted usernames and the password are listed on the login page. Sign in as standard_user. Then, in a separate flow, add the backpack and the bike light to the cart and open the cart. The second flow must work on its own even if the session is fresh.`
- **Voice:** off
- **Creds:** on the login page
- **Exercises:** the dress rehearsal catching a flow-2 script that assumes flow 1 already signed in. This is the regression test for "it started assuming the logged in state".
- **Expect:** flow 2's script either begins with `auth login` or its `startUrl` is proven to survive a cold open. If the agent wrote flow 2 assuming the session, the dress rehearsal must flip it to `blocked` with `blockedByDressRehearsal` — and NOT offer "split this flow" advice.
- **Weak spot:** `saucedemo` stores the cart in a cookie, so rehearsal's cart contents can leak into the record pass. Same class as 2.1's localStorage; same expectation.

### 3.3 Wrong password (negative)

- **Domain:** `the-internet.herokuapp.com`
- **Prompt:** `Demo the login at /login.` — and when `save_login` asks, give the right username and a wrong password.
- **Voice:** off
- **Creds:** deliberately wrong
- **Exercises:** `saveCredentials` → `loginProfile` → `stillOnLoginForm` → `verified: false`.
- **Expect:** `verified: false` with the actionable text, and the agent **stops and asks** rather than rehearsing. The log line is `warn`, not `info`. Nothing reaches `scripts.json`.
- **Weak spot:** `auth login` exiting 0 and the false positive being swallowed as "already authenticated". If rehearsal starts, the password-field probe did not run.

---

## Level 4 — Real product, real login

Your own product with your own test account. This is the regression suite for
this week's failures. Enter credentials only through `save_login`'s two
`ask_user` prompts.

### 4.1 The `<div>` submit button

- **Domain:** `workik.com`
- **Prompt:** `Sign in and show creating a new project from the dashboard. Two scenes: the sign-in, and the new-project flow. Keep it under 30 seconds.`
- **Voice:** off
- **Creds:** your own test account
- **Exercises:** the submit control that is a `<div class="auth-form-button">` — agent-browser's auto-submit cannot click it. `save_login` must return `verified: false` *before rehearsal*, the agent must read the real selector off the DOM and retry with `submitSelector`.
- **Expect:** first `save_login` → `verified: false`; second call carries a `submitSelector` the agent read from the page (not `button[type=submit]`); second call → `verified: true`. Then, and only then, rehearsal. The password appears nowhere on disk except the vault: grep `scripts.json`, `*.agent.json` and `mastra.db` for it.
- **Weak spot:** the agent guessing `--username-selector` values. Any selector in the second call that does not exist in the live DOM is a prompt failure — the description says "READ off the live form, never guessed".

### 4.2 Script rewrite under recovery

- **Domain:** `workik.com`
- **Prompt:** `Sign in, open the most recent project, and show the chat panel. One chained flow, three scenes.`
- **Voice:** off
- **Creds:** your own test account
- **Exercises:** `amend_scene_script`. After rehearsal succeeds, hand-edit one action's `cmd` in `scripts.json` to a selector that does not exist (keep the backup), then start recording.
- **Expect:** the pre-roll or mid-take deviation reaches `recoverFromDeviation`; the agent calls `amend_scene_script` with the same number of actions; the amendment is replayed cold with `isRetry: true`; only then is `scripts.json` rewritten; the retake plays the amended script. A `.agent.json` transcript exists for the failed attempt.
- **Weak spot:** the agent "fixing" the scene by shortening the action list — the tool must reject it. Or the agent clearing the page state with the shell when the script was the thing that was wrong — check the transcript's diagnosis says "the script is wrong", not "the page is wrong".

### 4.3 Full brief, multi-flow, voiced

- **Domain:** `workik.com`
- **Prompt:** `A 60-second product tour with narration. Flow 1: sign in and land on the dashboard. Flow 2: create a project called something realistic and open it. Flow 3: send one message in the project chat and show the response arriving. Warm, concise narration; no marketing fluff.`
- **Voice:** on
- **Creds:** your own test account
- **Exercises:** everything above, plus narrate → tts → sync → compose, `params` on the project name, `state-created` for the project.
- **Expect:** three flows in the plan, the Gate B report listing the created project, the video's project name matching `params` not the rehearsal name (item 45), and audio on the output.
- **Weak spot:** narration pacing. Design spec §14 is unwritten, so expect the voiceover to run long or short against the footage. That is a known gap, not a regression — note the mismatch in seconds and move on. Also the suspension card's false green "Video ready" (`workflow-progress.tsx:174`) if any scene suspends.

---

## Level 5 — Stress

### 5.1 Budget

- **Domain:** `en.wikipedia.org`
- **Prompt:** `One long flow, eight chained scenes: start at the "Electron (software framework)" article and follow the first blue link in the body text of each article, eight times. Each hop is one scene.`
- **Voice:** off
- **Creds:** none
- **Exercises:** `REHEARSAL_MAX_STEPS = 100` under a long flow; incremental writing of `scripts.json` (item 35); transcript size.
- **Expect:** either eight proven scenes, or a clean budget exhaustion *with* the scenes proven so far already on disk and the "split this flow" advice (correct here — the flow is genuinely long). `scripts.json` grows while the flow runs.
- **Weak spot:** a 25–42MB `.agent.json` transcript. Watch the workspace size; this prompt will find the ceiling.

### 5.2 A genuine one-shot

- **Domain:** `workik.com`
- **Prompt:** `Sign in, create a project, then delete it from its settings. Show the confirmation dialog.`
- **Voice:** off
- **Creds:** your own test account
- **Exercises:** correct `oneShot: true` on the delete flow (a project cannot be deleted twice); the dress rehearsal skipping it *and saying so*; the Gate B report naming it (item 40).
- **Expect:** the delete scene is `oneShot`, is not replayed off camera, is called out in the rehearsal report, and the retake's first run is its first test (logged). Creating a project in the same run makes the delete replayable in practice — a sharp agent may parameterise instead of marking one-shot; both are passes if the report explains which.
- **Weak spot:** the delete being rehearsed and recorded on the *same* project, leaving the record pass with nothing to delete. `state-created` must show two projects.

### 5.3 Explicit duration

- **Domain:** `developer.mozilla.org`
- **Prompt:** `Exactly 15 seconds. Open the homepage, search for "fetch", open the first result. Narrate it.`
- **Voice:** on
- **Creds:** none
- **Exercises:** `expectedDurationMs` versus a hard target; narration fit.
- **Expect:** footage within ±3s of 15. Narration that fits is a bonus (§14 unwritten).
- **Weak spot:** a `waitBefore` that adds `ACTION_BASELINE_MS` per step and pushes a tight target over. Compare `expectedDurationMs` in the plan against the ffprobe duration of the output.

---

## Level 6 — Negative and edge

These should fail *well*: early, with a clear message, with no half-recorded
artifacts, and with the vault profile deleted.

### 6.1 Unresolvable domain

- **Domain:** `this-domain-does-not-exist-demio.invalid`
- **Prompt:** `Make a demo of the homepage.`
- **Expect:** failure at discovery/first `open`, before any plan. No workspace scenes. No suspension card.

### 6.2 Feature the product does not have

- **Domain:** `example.com`
- **Prompt:** `Demo the user settings page and the billing tab.`
- **Expect:** an `ask_user` or a plan that states plainly the site has no such page. Recording a scroll of the homepage and calling it "settings" is a fail.

### 6.3 Cancel mid-run

- **Domain:** `the-internet.herokuapp.com`
- **Prompt:** 3.1's prompt; cancel from the UI during the second scene's recording.
- **Expect:** `record stop` fires, no orphaned recording process, `agent-browser auth list` no longer shows the profile (item 46 abort path), and the next run in a fresh thread does not hit "Recording already active".

### 6.4 Delete the thread

- **Domain:** any Level 3 prompt, run to completion, then delete the thread.
- **Expect:** the vault profile is gone (item 46, third path) and the workspace directory is removed.

### 6.5 Gated flow

- **Domain:** `the-internet.herokuapp.com`
- **Prompt:** `Demo /basic_auth — it needs HTTP basic auth, the credentials are on the linked page.`
- **Expect:** rehearsal reports the flow `blocked` with a reason (HTTP auth is not a form; `save_login` cannot vault it). Not: a 40-step loop trying selectors on a browser-native dialog. Budget exhaustion here is a fail — the block should be recognised early.

### 6.6 Bot-walled site

- **Domain:** `github.com`
- **Prompt:** `Search for "electron" and open the first repository.`
- **Expect:** graceful degradation — a rate limit or challenge page reported as `blocked`, not recorded as if it were the product. This one is informational; the outcome depends on what GitHub serves the daemon that day.

---

## Suggested order

Run 0.1 → 1.1 → 2.1 → 3.1 → 3.3 → 4.1 → 4.2 → 4.3 first. That path touches
every mechanism changed on `fix/rehearse-record-reliability` once, in the order
the mechanisms depend on each other. Everything else is for when that path is
green.
