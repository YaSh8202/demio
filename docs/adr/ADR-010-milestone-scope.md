# ADR-010: Milestone 1 Scope (Vertical Slice)

Date: 2026-07-31
Status: accepted

## Decision

Milestone 1 is a vertical slice: dependency upgrade → AgentController conversation layer migration → workflow with mechanical verification. Out of scope: vision judge, brand kits, typed browser tools, per-role model auto-selection.

## Context

A smaller scope reduces implementation risk and delivers working controller integration faster. The slice covers the most critical path: upgrading dependencies, migrating chat to the controller, and ensuring the demo-video workflow generates at least one scene correctly with mechanical verification. Deferred features are tracked separately for Milestone 2 planning.

## Consequences

- Tasks 1–11 implement the vertical slice
- Task 12 (demo-video narration and composition) is future work
- Vision judge verification is explicitly deferred (mechanical checks only)
- Brand kits (intros/outros) are deferred
- Typed browser tools (vision-based locators) are deferred
- These decisions remain reviewable and can be revisited in subsequent planning
- Milestone 2 planning will prioritize the deferred items based on user feedback
