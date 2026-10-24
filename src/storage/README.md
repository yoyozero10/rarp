# Storage

store.ts implements SQLite migration v1/v2 (v2 adds workspaces, durable runs, request fingerprints and leases), tasks, dependencies, attempts, review history and durable events using node:sqlite. Task changes and corresponding events commit atomically. A failed event insert rolls back all mutations. Actor IDs are trusted local input, not authentication credentials.
