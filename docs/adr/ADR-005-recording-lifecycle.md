# ADR-005: Harness-Owned Recording Lifecycle

Date: 2026-07-31
Status: accepted

## Decision

The harness code (workflow step) owns the recording lifecycle: starting the recorder, running the recorder agent to drive browser actions, stopping the recorder, and collecting the artifact. The agent (recorder) does not start/stop recording itself; it only drives the browser via the `execute_command` tool. Bash-based driving of agent-browser stays inside the record step for now.

## Context

Today's architecture in `electron/agent/tools/terminal.ts` (367 lines) conflates recording lifecycle management with agent execution. The terminal tool parses agent-browser error text because exit codes mislead. Moving recording lifecycle to the harness provides clear ownership and enables the harness to implement bounded retries and recovery logic.

## Consequences

- `electron/agent/workflows/record-scene.ts` sets up the recorder, creates a temporary recorder agent, runs a step that executes the agent, collects results, and tears down
- The recorder agent is short-lived and scoped to a single scene
- Agent-browser invocation still uses bash in `execute_command`, but it's hidden inside the record step rather than surfaced as an agent decision
- Bash error handling (sniffing agent-browser output) remains but is localized to the record step's error-handling logic
