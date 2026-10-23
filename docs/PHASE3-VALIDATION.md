# Phase 3 validation

Date: 2026-10-24 (Asia/Saigon).

## Automated coverage

21 tests pass locally on Windows/Node 26. Includes prior storage and process tests, AG JSONL success/error/denied-actions envelopes, immediate acceptance, deliberately incorrect artifact followed by feedback-driven repair, round exhaustion, invalid review output, cancellation, deadline and stop during review.

The repair fixture writes payable=999 on attempt 1. A separate reviewer process reads the file and requests payable=50000. Attempt 2 receives that persisted feedback, writes 50000, and the reviewer accepts. This verifies the orchestration state machine deterministically; it is not a claim about real-model correction reliability.

## Live protocol findings

- Antigravity headless denied a command permission and emitted SUCCESS with an empty response and denied_actions. Rarp correctly rejected completion. Adapter now rejects denied_actions even alongside a nonempty response.
- An unconstrained Codex reviewer emitted evidence objects instead of strings. Validation rejected that review. The production reviewer now uses schemas/review.json with --output-schema, followed by Zod validation in Rarp.
- User explicitly authorized dangerously-skip-permissions for the temporary live test only. The default Antigravity adapter does not use that flag. No persistent account settings were modified.

## Scope

## Successful live run

Final live run passed: Antigravity worker created items totaling 55000 and Codex reviewer accepted. A dependent task then ran through a Codex worker to add discount=5000 and payable=50000, followed by a second accepted review. The harness independently parsed cart.json and verified all three amounts. Runtime stopped normally. Both tasks were accepted on the first attempt; the repair branch is covered by the deterministic test above.

## Scope and limitations

One workflow at a time, sequential worker/reviewer processes. Codex is the production reviewer; worker can be Codex or Antigravity. No automatic planning, queue dispatch, merge, worktree isolation or crash resume. File/log observations and model evidence must still be reviewed against meaningful acceptance criteria for real features.

Run `npm test` for deterministic fixtures. `node scripts/smoke-phase3.mjs` runs real CLI agents and consumes their account usage. The explicit test-only flag `--allow-agy-auto-approve` requires permission for that invocation; the test workspace is temporary and is not a security boundary.
