# ADR-003: Per-Scene Record→Verify→Retry Strategy

Date: 2026-07-31
Status: accepted

## Decision

Each scene in the demo-video workflow follows a bounded retry loop: attempt recording, run mechanical verification, and on failure retry up to 3 times. After all retries are exhausted, the workflow suspends and asks the user to intervene (retry, skip, or abort).

## Context

Current generation lacks explicit retry logic; failures in recording or verification halt the entire process. This is especially problematic for browser automation, which is inherently flaky due to timing, network, and UI rendering variability. Users cannot recover from transient failures without restarting the entire generation from scratch.

## Consequences

- Each scene encapsulates a max-3-attempt retry loop; verification runs after every attempt
- On retry exhaustion, workflow suspends (not errors) and presents user guidance to retry, skip, or abort
- Attempt count and failure reason recorded for debugging and user context
