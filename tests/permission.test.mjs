import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { Store } from "../dist/storage/store.js";
import { planStatusFor } from "../dist/core/plan.js";
import { classifyFailure } from "../dist/runtime/workflow.js";
import { repositorySnapshot } from "../dist/runtime/planning.js";
import { startRuntime, runtimeRequest } from "../dist/runtime/server.js";
import { git } from "../dist/runtime/workspace.js";

test("permission denials are classified and mapped to a waiting status", () => {
  assert.equal(
    classifyFailure("Antigravity tool permissions denied: command(node)", "worker"),
    "permission",
  );
  assert.equal(classifyFailure("boom", "worker"), "worker");
  assert.equal(planStatusFor("permission"), "waiting_permission");
  assert.equal(planStatusFor("review"), "paused");
});

test("denied Antigravity work pauses for approval and resumes without losing the round", async (t) => {
  const root = join(tmpdir(), "rarp-permission-" + randomUUID());
  mkdirSync(root);
  git(root, "init");
  git(root, "config", "user.name", "Tests");
  git(root, "config", "user.email", "tests@localhost");
  writeFileSync(join(root, ".gitignore"), ".rarp/\n");
  writeFileSync(join(root, "a.txt"), "base");
  git(root, "add", ".");
  git(root, "commit", "-m", "base");
  const store = new Store(root, true);
  t.after(() => {
    delete process.env.RARP_FIXTURE_ALLOW;
    store.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const fixture = resolve("tests/fixtures/phase7-agent.mjs");
  const command = { file: process.execPath, args: [fixture] };
  const profiles = {
    "antigravity:deny": {
      adapter: "antigravity",
      authenticated: true,
      model: "fixture",
      command: { ...command, args: [...command.args, "--antigravity", "--deny"], protocol: "antigravity", promptArgument: true },
    },
  };
  const proposal = {
    understood: "Write a.txt",
    assumptions: [],
    questions: [],
    rationale: "One worker suffices",
    size: "small",
    confidence: "high",
    workers: [{ workerRef: "W1", rationale: "Sequential scoped change" }],
    maxWorkers: 1,
    steps: [
      {
        key: "first",
        title: "Write a.txt",
        requirements: "Write done to a.txt",
        deliverable: "a.txt",
        dependencies: [],
        workerRef: "W1",
        scope: ["a.txt"],
        check: [process.execPath, "-e", "process.exit(0)"],
        acceptance: ["a.txt contains done"],
      },
    ],
    policy: { maxRounds: 1, timeoutMs: 10000, totalTimeoutMs: 20000 },
  };
  const { plan } = store.createGoal({ title: "Goal", requirements: "Scoped change", acceptance: ["a.txt correct"] });
  const snap = repositorySnapshot(root);
  const draft = store.updatePlan(plan.id, 0, proposal, snap.baseHead, snap.fingerprint);
  const approval = {
    revision: 1,
    contentHash: draft.contentHash,
    actor: "human",
    maxWorkers: 1,
    maxReviewers: 1,
    workers: [{ workerRef: "W1", adapter: "antigravity", profile: "deny" }],
    integration: "reviewed-local",
  };
  const runtime = await startRuntime(root, command, { manager: command, profiles }, { maxWorkers: 2 });
  try {
    await runtimeRequest(root, "plans/" + draft.id + "/approve", approval);
    let current = store.plan(draft.id);
    for (let i = 0; i < 400 && current.status === "executing"; i++) {
      await delay(50);
      current = store.plan(draft.id);
    }
    assert.equal(current.status, "waiting_permission", current.note);
    assert.equal(current.stopReason, "permission");
    assert.match(current.note, /permissions denied/i);
    const [link] = store.planLinks(draft.id);
    assert.equal(store.show(link.taskId).status, "blocked");
    assert.equal(current.execution.tasks[link.taskId].rounds, 0);
    assert.equal(store.workspace(link.taskId).integrated, null);

    process.env.RARP_FIXTURE_ALLOW = "1";
    await runtimeRequest(root, "plans/" + draft.id + "/resume", {});
    for (let i = 0; i < 400 && store.plan(draft.id).status === "executing"; i++) await delay(50);
    const finished = store.plan(draft.id);
    assert.equal(finished.status, "completed", finished.note);
    assert.ok(store.workspace(link.taskId).integrated);
  } finally {
    await runtime.stop();
  }
});
