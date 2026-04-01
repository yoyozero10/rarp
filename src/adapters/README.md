# Adapters

codex.ts builds a non-interactive Codex command and incrementally parses JSONL. Successful submission requires exit 0, turn.completed, a nonempty agent_message, and no error/turn.failed event. Unknown event types are retained for observation. Malformed or oversized output fails the attempt.

Workers use workspace-write; Codex reviewers use read-only with a JSON output schema. Both use never approval policy, ephemeral mode and no shared daemon. The existing account/config selects the model. Auth is inherited; credentials are not stored by Rarp.

antigravity.ts normalizes AG stream-json result envelopes. Permission-denied actions are failures even when the envelope says SUCCESS. Prompts are passed as a separate argument, without a shell. Default command enables sandbox and does not bypass permission prompts. API models remain planned.
