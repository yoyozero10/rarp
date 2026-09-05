import { test } from "node:test";
import assert from "node:assert/strict";
import { planLabel, planEditable, planActions, planActionLabel, planCanIntegrate, planRemaining } from "../dist/core/planview.js";

test("plan status labels fall back to the raw status", () => {
  assert.equal(planLabel("waiting_permission"), "Chờ cấp quyền");
  assert.equal(planLabel("paused"), "Tạm dừng");
  assert.equal(planLabel("unknown_state"), "unknown_state");
});

test("only non-terminal, non-permission states allow editing the proposal", () => {
  assert.equal(planEditable("awaiting_approval"), true);
  assert.equal(planEditable("paused"), true);
  assert.equal(planEditable("executing"), false);
  assert.equal(planEditable("waiting_permission"), false);
  assert.equal(planEditable("completed"), false);
});

test("toolbar actions match the plan state", () => {
  assert.deepEqual(planActions("awaiting_approval"), ["reject", "cancel"]);
  assert.deepEqual(planActions("executing"), ["pause", "cancel"]);
  assert.deepEqual(planActions("paused"), ["resume", "cancel"]);
  assert.deepEqual(planActions("waiting_permission"), ["resume", "cancel"]);
  assert.deepEqual(planActions("completed"), []);
  assert.deepEqual(planActions("rejected"), ["reject"]);
});

test("the resume button names a permission wait", () => {
  assert.equal(planActionLabel("resume", "waiting_permission"), "Đã cấp quyền, tiếp tục");
  assert.equal(planActionLabel("resume", "paused"), "Tiếp tục kế hoạch");
  assert.equal(planActionLabel("cancel", "waiting_permission"), "Hủy riêng kế hoạch");
});

test("accepted tasks can be integrated while the plan waits for permission", () => {
  assert.equal(planCanIntegrate("executing"), true);
  assert.equal(planCanIntegrate("paused"), true);
  assert.equal(planCanIntegrate("waiting_permission"), true);
  assert.equal(planCanIntegrate("completed"), false);
  assert.equal(planCanIntegrate("awaiting_approval"), false);
});

test("remaining budget never goes negative", () => {
  assert.equal(planRemaining(1, 3), 2);
  assert.equal(planRemaining(5, 3), 0);
});
