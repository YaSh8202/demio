# ADR-011: Workspace Primitive for Core Tools

Date: 2026-07-31
Status: accepted

## Decision

Core tools (`execute_command`, view, edit, grep, find) are provided by the Mastra Workspace primitive (`@mastra/core/workspace`), not custom code. Demio retains custom tools only for `present_files` and `synthesize_voiceover`. Agent-browser is invoked through `execute_command` with a PATH-shim environment variable.

## Context

Today's implementation in `electron/agent/tools/terminal.ts` (367 lines), `read.ts`, and `edit.ts` duplicate filesystem and shell abstractions. Workspace provides these primitives with allowed-paths enforcement, output truncation, and streamed shell output. Using Workspace reduces maintenance burden and ensures feature parity with other Mastra-based systems. The PATH shim (exposing bundled `agent-browser` and `ffmpeg`) is constructed once during Workspace initialization.

## Consequences

- `electron/agent/tools/terminal.ts`, `read.ts`, and `edit.ts` are deleted
- `electron/agent/workspace-factory.ts` creates a Workspace with cwd = thread workspace dir and env with PATH shim
- Tools are registered from the Workspace primitive; Mastra documents them automatically
- Workspace enforces allowed paths (thread workspace + global temp dirs)
- Custom tools (`present_files`, `synthesize_voiceover`) remain hand-rolled in `electron/agent/tools/`
- Future tool additions (e.g., web search, API calls) use Workspace as the base or stay custom depending on scope
