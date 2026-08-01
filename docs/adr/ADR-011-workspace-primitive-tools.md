# ADR-011: Workspace Primitive for Core Tools

Date: 2026-07-31
Status: accepted

## Decision

Core tools (`execute_command`, view, edit, grep, find) are provided by the Mastra Workspace primitive (`@mastra/core/workspace`), not custom code. Demio retains custom tools only for `present_files` and `synthesize_voiceover`. Agent-browser is invoked through `execute_command` with a PATH-shim environment variable.

## Context

Today's implementation in `electron/agent/tools/terminal.ts` (367 lines), `read.ts`, and `edit.ts` duplicate filesystem and shell abstractions. Workspace provides these primitives with allowed-paths enforcement, output truncation, and streamed shell output. Using Workspace reduces maintenance burden and ensures feature parity with other Mastra-based systems. The PATH shim (exposing bundled `agent-browser` and `ffmpeg`) is constructed once during Workspace initialization.

## Consequences

- Custom tool files (`terminal.ts`, `read.ts`, `edit.ts`) deleted; workspace-factory creates Workspace with thread cwd and PATH shim
- Core tools registered from Workspace primitive with auto-documentation and allowed-paths enforcement
- Custom tools (`present_files`, `synthesize_voiceover`) remain hand-rolled; new tools use Workspace or stay custom as needed
