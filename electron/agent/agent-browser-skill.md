# agent-browser

Fast browser automation CLI for AI agents. Chrome/Chromium via CDP with
accessibility-tree snapshots and compact `@eN` element refs.

Install: `npm i -g agent-browser && agent-browser install`

## Start here

This file is a discovery stub, not the usage guide. Before running any
`agent-browser` command, load the actual workflow content from the CLI:

```bash
agent-browser skills get core             # start here — workflows, common patterns, troubleshooting
agent-browser skills get core --full      # include full command reference and templates
```

The CLI serves skill content that always matches the installed version,
so instructions never go stale. The content in this stub cannot change
between releases, which is why it just points at `skills get core`.

## Specialized skills

Load a specialized skill when the task falls outside browser web pages:

```bash
agent-browser skills get electron          # Electron desktop apps (VS Code, Slack, Discord, Figma, ...)
agent-browser skills get slack             # Slack workspace automation
agent-browser skills get dogfood           # Exploratory testing / QA / bug hunts
agent-browser skills get vercel-sandbox    # agent-browser inside Vercel Sandbox microVMs
agent-browser skills get agentcore         # AWS Bedrock AgentCore cloud browsers
```

Run `agent-browser skills list` to see everything available on the
installed version.

## Recording demo videos

Recording looks natural when `record start` gets two flags:
`agent-browser record start <path> --cursor --input-mode human`
- `--cursor` draws an animated pointer into the video.
- `--input-mode human` is a global flag that sticks for the rest of the
  session: every later command glides the pointer to its click/hover/fill
  target, types text one key at a time, and pauses briefly after clicks.
  End the take with `record stop --input-mode instant` to turn it back off.
- Capture is 30 FPS from Chrome's screencast, paced to wall-clock time.
- `record start` records the page you are already on; it does not reload it.

Useful flags on `record start` / `record restart`:
- `--log-actions <path>` — append a JSONL line per user action with shape
  `{action, args, tsMs, durationMs, frameIdx, ok, target?:{x,y}}` (`target`
  appears when the pointer moved; a failed action has `ok:false` and `error`).
  Use this for voiceover/annotation alignment, and so the demio agent surfaces
  failed actions back to chat.
- `--fps <n>` — capture rate, 1-60 (default 30).

Disambiguating element lookups:
- `find role` and `find text` refuse to silently pick when several elements
  match; the error starts with "Ambiguous" and lists the candidates. Use
  `find role button click --name "Save" --exact` for buttons, `find role link
  click --name "Login" --exact` for links. Pass `--allow-ambiguous` only when
  you genuinely want first-match-wins behaviour.
- The action (`click`, `fill`, ...) comes right after the role or text, before
  any flags.

There is **no `AGENT_BROWSER_DEMO_MODE` env var** and **no `--demo-mode` flag** —
earlier docs described one; ignore. Locator selection guidance lives in the
Demio system prompt; do not duplicate it here.

## Why agent-browser

- Fast native Rust CLI, not a Node.js wrapper
- Works with any AI agent (Cursor, Claude Code, Codex, Continue, Windsurf, etc.)
- Chrome/Chromium via CDP with no Playwright or Puppeteer dependency
- Accessibility-tree snapshots with element refs for reliable interaction
- Sessions, authentication vault, state persistence, video recording
- Specialized skills for Electron apps, Slack, exploratory testing, cloud providers
