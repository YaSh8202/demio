# ADR-004: Mechanical Verification (Layer 1)

Date: 2026-07-31
Status: accepted

## Decision

Scene verification starts with code-only checks: file existence, duration range via ffprobe, all `actions.jsonl` entries marked `ok:true`, and end-URL matching the scene contract. Vision-based verification (judge model reviewing recorded content) is deferred to Milestone 2.

## Context

Asking the agent to verify its own output requires another LLM call and introduces latency. Mechanical checks are deterministic, fast, and align with the scene definition (e.g., recording should end at a specific URL and log all actions). Starting with mechanical verification provides a foundation that catches 80% of failures without incurring additional inference cost.

## Consequences

- `electron/agent/workflows/verify.ts` contains pure Node code (testable via `node --test`)
- Verification runs synchronously after every recording attempt
- A scene passes verification only if all mechanical checks pass
- Vision judge verification is tracked as a separate Milestone 2 feature request
- Future mechanical checks can be added (e.g., screenshot content hash) without architectural changes
