# ADR-012: MastraCode Patterns

Date: 2026-07-31
Status: accepted

## Decision

Demio adopts architectural patterns from MastraCode (the reference implementation used to extract AgentController). These include: `availableTools` mode allowlists for tool visibility, `submit_plan({path})` plan-file contract, stable session/owner identifiers, promise-chain event listener patterns, and `display_state_changed` as the single re-render trigger.

## Context

MastraCode is the proven reference for AgentController patterns. Rather than inventing custom abstractions, reusing MastraCode's design reduces risk and increases maintainability. These patterns have been battle-tested and are documented in `mastracode:<path>:<line>` references throughout the plan.

## Consequences

- Controller modes use `availableTools` visibility allowlists; plans are zod-validated objects submitted via `submit_plan({path})`
- Session/owner IDs are stable (projectId/threadId); renderer uses promise-chain event subscriptions and re-renders only on `display_state_changed`
- Deviations from MastraCode patterns documented in code comments; future features adopt same patterns for consistency
