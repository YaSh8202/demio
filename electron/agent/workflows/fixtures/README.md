# Script fixtures

Real `rehearsal/scripts.json` documents from local runs, one file per
workspace (named by the first 8 chars of its thread id). They are the
dataset `script-lint.test.js` pins its findings against — every one of
these was written by the rehearsal agent for real, and several of them
failed for real.

- `b041e55a` — `electron-chromium-talk.01` is the scene whose only action
  was `wait --load complete` on an already-loaded page: 25 s of dead air on
  every take. The `leading-load-wait` rule exists because of it.
- `b38d6bdc` — `search-wikipedia.01` recorded 0.5 s against a 4.2 s
  prediction. Its replay timing is in band (three steps plus 3 s of settles);
  the file was short because the recording was, not the script — the case
  the linter deliberately does NOT route to a script amendment.

Typed literals on `fill` / `type` are redacted at copy time; `{{param}}`
placeholders are kept. The workspace that contained a leaked credential is
excluded outright rather than redacted.
