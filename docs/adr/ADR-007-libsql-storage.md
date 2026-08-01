# ADR-007: LibSQL Storage for Controller Threads and Workflow Snapshots

Date: 2026-07-31
Status: accepted

## Decision

Controller threads and workflow snapshots are persisted in `~/.demio/mastra.db` (LibSQL), while project metadata and legacy thread JSON remain in the existing JSON store. New conversations live in controller storage; legacy threads remain readable for backward compatibility.

## Context

**Original decision (pre-AgentController):** Workflow snapshots only in LibSQL, threads stay in JSON.

**Amended (AgentController adoption):** AgentController requires persistent session storage. LibSQL is the natural choice (embedded SQLite with Mastra integration via `@mastra/libsql`). The existing project/meta store stays in JSON for backward compatibility with the file-based project model; new conversations (via controller) live in the new database, ensuring clean separation of concerns.

## Consequences

- `electron/store/paths.ts` adds `mastraDbPath()` helper returning `~/.demio/mastra.db`
- AgentController is initialized with LibSQL storage (via `@mastra/libsql` adapter)
- Controller sessions can be reattached across app restarts
- Workflow snapshots are stored alongside thread state in the same database
- Existing project metadata and old thread JSON files are not migrated; new threads created in controller are not exported to JSON
- Migration tooling (if needed) is deferred to a future phase
