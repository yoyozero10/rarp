# Storage

store.ts implements SQLite migration v1, tasks, dependencies, attempts, review history and durable events using node:sqlite. Task changes and corresponding events commit atomically. A failed event insert rolls back all mutations. Actor IDs are trusted local input, not authentication credentials.
