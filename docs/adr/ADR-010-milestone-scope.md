# ADR-010: Milestone 1 Scope (Vertical Slice)

Date: 2026-07-31
Status: accepted

## Decision

Milestone 1 is a vertical slice: dependency upgrade → AgentController conversation layer migration → workflow with mechanical verification. Out of scope: vision judge, brand kits, typed browser tools, per-role model auto-selection.

## Context

A smaller scope reduces implementation risk and delivers working controller integration faster. The slice covers the most critical path: upgrading dependencies, migrating chat to the controller, and ensuring the demo-video workflow generates at least one scene correctly with mechanical verification. Deferred features are tracked separately for Milestone 2 planning.

## Consequences

- Tasks 1–11 implement the vertical slice; narration, composition (Task 12), vision judge, brand kits, and typed browser tools deferred
- Deferred decisions remain reviewable for Milestone 2 planning
- Milestone 2 will prioritize deferred items based on user feedback
