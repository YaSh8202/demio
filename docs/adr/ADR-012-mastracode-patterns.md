# ADR-012: MastraCode Patterns

Date: 2026-07-31
Status: accepted

## Decision

Demio adopts architectural patterns from MastraCode (the reference implementation used to extract AgentController). These include: `availableTools` mode allowlists for tool visibility, `submit_plan({path})` plan-file contract, stable session/owner identifiers, promise-chain event listener patterns, and `display_state_changed` as the single re-render trigger.

## Context

MastraCode is the proven reference for AgentController patterns. Rather than inventing custom abstractions, reusing MastraCode's design reduces risk and increases maintainability. These patterns have been battle-tested and are documented in `mastracode:<path>:<line>` references throughout the plan.

## Consequences

- Controller modes use `availableTools` to filter tool visibility at LLM-call time (distinct from the full toolset)
- Plans are zod-validated objects written to disk, submitted via `submit_plan({path})`
- Session and owner IDs are stable (projectId/threadId) for reattachment and resumption
- Renderer event subscription uses promise chains to ensure event ordering (not array subscriptions)
- The renderer re-renders only on `display_state_changed` events, not on every message
- Future custom features adopt the same patterns for consistency
- Deviations from MastraCode are explicitly documented in code comments
