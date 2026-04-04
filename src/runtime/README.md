# Runtime

server.ts owns a project lock and token-authenticated loopback HTTP control API. daemon.ts runs it independently of the CLI. process.ts supervises a worker-host process, parses bounded output, enforces timeout and cleans up the process tree. worker-host.ts keeps a parent alive for cleanup after Codex exits.

Phase 3 supports one explicitly dispatched task or automatic workflow at a time. workflow.ts owns worker/reviewer sequencing, feedback, maximum rounds and overall deadline. Cancellation stops the current process and prevents subsequent rounds. Review errors fail the task without rewriting the worker's submitted attempt. Crash recovery, queue scheduling, worktree isolation and interactive permission/input handling are not implemented. Stale locks are never automatically taken over; inspect processes before removing a lock.
