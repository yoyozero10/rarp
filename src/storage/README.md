# Storage

store.ts implements versioned SQLite migrations: v1 tasks/dependencies/attempts/reviews/events; v2 workspaces/runs/request fingerprints/leases; v3 durable dispatches with a unique pending task index. Task changes and corresponding events commit atomically. A failed event insert rolls back mutations. Observation snapshots include their event cursor in the same transaction. Queued dispatches do not create attempts until claimed. Recovery interrupts active dispatches and preserves waiting ones for explicit resume. Actor IDs are trusted local input, not authentication credentials.
