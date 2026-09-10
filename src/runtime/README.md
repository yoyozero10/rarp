# Runtime

server.ts owns a project lock and token-authenticated loopback HTTP control API. daemon.ts runs it independently of the CLI. process.ts supervises a worker-host process, parses bounded output, enforces timeout and cleans up the process tree. worker-host.ts keeps a parent alive for cleanup after Codex exits.

workflow.ts owns worker/reviewer sequencing, feedback, round limits and deadlines. scheduler.ts manages durable explicit dispatches, workflow capacity, scope/worker ownership, dependency gates, task cancellation and serialized integration. Default capacity is 2 workflows and 1 reviewer; non-isolated jobs run exclusively. review-pool.ts provides FIFO reviewer slots with abortable waits. process.ts also supervises plain-output verification commands, so slow tests do not block the HTTP API.

Phase 4 worktrees, checkpoint/scope validation and run leases remain in use. Phase 6 journals integration check hosts too. Interrupted workers require inspected explicit retry; interrupted reviews may resume the preserved commit. Waiting dispatches persist but restart paused. Active dispatches recover as interrupted; completed side effects are never automatically replayed. Integration conflicts remain in a separate worktree. Short Git operations are still synchronous. Plan permission denials wait for explicit resume. Structured final-response input requests persist questions and answers for a new worker prompt; interactive stdin and model-session resume are not implemented. Stale locks are never automatically taken over.

observer.ts serves the built React dashboard and authenticated snapshot/events/diff/SSE API. Snapshot includes workers[], queue[], limits and integration state; active is retained as the first workflow for older clients.
