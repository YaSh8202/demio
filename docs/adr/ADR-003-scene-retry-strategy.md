# ADR-003: Per-Scene Record→Verify→Retry Strategy

Date: 2026-07-31
Status: accepted

## Decision

Each scene in the demo-video workflow follows a bounded retry loop: attempt recording, run mechanical verification, and on failure retry up to 3 times. After all retries are exhausted, the workflow suspends and asks the user to intervene (retry, skip, or abort).

## Context

Current generation lacks explicit retry logic; failures in recording or verification halt the entire process. This is especially problematic for browser automation, which is inherently flaky due to timing, network, and UI rendering variability. Users cannot recover from transient failures without restarting the entire generation from scratch.

## Consequences

- Each scene encapsulates a retry loop within the workflow (max 3 attempts)
- Verification happens after every recording attempt, before declaring success or retry
- If all retries fail, the workflow suspends (not errors out) and presents the user with guidance
- The scene step records attempt count and failure reason for debugging
- User can gather more information (logs, browser state) before deciding to retry or skip
