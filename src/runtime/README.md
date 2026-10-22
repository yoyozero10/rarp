# Runtime

server.ts owns a project lock and token-authenticated loopback HTTP control API. daemon.ts runs it independently of the CLI. process.ts supervises a worker-host process, parses bounded output, enforces timeout and cleans up the process tree. worker-host.ts keeps a parent alive for cleanup after Codex exits.

Phase 2 supports one explicitly dispatched task at a time. Cancellation/timeout marks the running attempt failed with a reason, leaving retry/review to the manager. Crash recovery, queue scheduling, worktree isolation and interactive permission/input handling are not implemented. Stale locks are never automatically taken over; inspect processes before removing a lock.
