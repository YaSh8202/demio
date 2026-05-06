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

Recording is **natural-looking by default**. `agent-browser record start <path>` automatically:
- Injects a visible cursor that animates to each click/hover/fill target.
- Types text one character at a time with realistic jitter.
- Captures at 30 FPS via CDP screenshots piped to ffmpeg.

Useful flags on `record start` / `record restart`:
- `--log-actions <path>` — append a JSONL line per user action with shape
  `{action, args, target:{x,y}, tsMs, frameIdx, durationMs, ok}`. Use this for
  voiceover/annotation alignment, and so the demio agent surfaces failed
  actions back to chat.
- `--robotic` — opt out of natural mode (instant cursor, no typing jitter).
- `--auto-cursor` / `--no-auto-cursor` — toggle the cursor independently.

Disambiguating element lookups:
- `find text` now refuses to silently pick when multiple leaves match. Use
  `find role button --name "Save" --exact click` for buttons, `find role link
  --name "Login" --exact click` for links. Pass `--allow-ambiguous` only when
  you genuinely want first-match-wins behaviour.

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
