# ADR-001: Code-Enforced Workflow Pipeline

Date: 2026-07-31
Status: accepted

## Decision

The demo-video generation pipeline is enforced as a code-driven Mastra Workflow with explicit agent steps, rather than relying on prompt-enforced phases embedded in system instructions. This provides deterministic control over the generation process and enables per-scene retry logic.

## Context

The current implementation uses a 6-phase system prompt in `electron/agent/prompts.ts` to guide agent behavior through recording, verification, and composition steps. Hard stops are scattered through orchestrator logic: `stepCountIs(50)` and a `present_files` tool in `electron/agent/orchestrator.ts:142`. This approach is fragile; retry behavior is ad-hoc, and tracking progress across scenes is implicit in the prompt rather than explicit in code.

## Consequences

- The workflow layer (Mastra Workflow) manages scene iteration, retry loops, and state transitions explicitly
- Agent execution is scoped to individual steps within the workflow (e.g., a recorder agent runs only for the "record" step)
- System prompts focus on task-specific instructions (e.g., how to operate the browser) rather than pipeline choreography
- Mechanical verification logic moves from prompts to code in `electron/agent/workflows/verify.ts`
