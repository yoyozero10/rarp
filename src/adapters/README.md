# Adapters

codex.ts builds a non-interactive Codex command and incrementally parses JSONL. Successful submission requires exit 0, turn.completed, a nonempty agent_message, and no error/turn.failed event. Unknown event types are retained for observation. Malformed or oversized output fails the attempt.

Uses workspace-write sandbox, never approval policy, ephemeral mode and no shared daemon. The existing account/config selects the model. Auth is inherited; credentials are not stored by Rarp. API models and other CLI adapters remain planned.
