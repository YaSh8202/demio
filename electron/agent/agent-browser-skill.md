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

## Demo Mode

For creating high-quality, human-like demo videos, you can enable Demo Mode by passing the `--demo-mode` flag or setting the `AGENT_BROWSER_DEMO_MODE=1` environment variable.

```bash
# Enable Demo Mode globally for the session
export AGENT_BROWSER_DEMO_MODE=1

agent-browser record start ./demo.webm
# ... your automation steps ...
agent-browser record stop
```

**Features included in Demo Mode:**
- **Auto Cursor Positioning:** A visible CSS cursor (red dot) is injected into the page and smoothly transitions to the target element's center before `click`, `type`, `hover`, or `fill` actions.
- **Human-like Typing Delays:** Enforces a natural typing delay (50ms per keystroke) for all typing actions.
- **Action Timing Logs:** A structured JSON log of all actions (including `timestamp`, `video_time_ms`, `duration_ms`, `x`, `y` coordinates) is automatically dumped to the console when the recording is stopped or if an action fails. This is highly useful for aligning voiceovers or annotations with the video.

## Why agent-browser

- Fast native Rust CLI, not a Node.js wrapper
- Works with any AI agent (Cursor, Claude Code, Codex, Continue, Windsurf, etc.)
- Chrome/Chromium via CDP with no Playwright or Puppeteer dependency
- Accessibility-tree snapshots with element refs for reliable interaction
- Sessions, authentication vault, state persistence, video recording
- Specialized skills for Electron apps, Slack, exploratory testing, cloud providers
