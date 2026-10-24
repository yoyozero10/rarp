// Disposable local UI demo. Agent processes use fixtures, never a paid model.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Store } from "../dist/storage/store.js";
import { startRuntime } from "../dist/runtime/server.js";
import {
  git,
  prepareWorkspace,
  checkpoint,
  verifyWorkspace,
  integrateWorkspace,
} from "../dist/runtime/workspace.js";
const root = mkdtempSync(join(tmpdir(), "rarp-phase5-demo-"));
git(root, "init");
git(root, "config", "user.name", "Rarp demo");
git(root, "config", "user.email", "demo@localhost");
writeFileSync(join(root, ".gitignore"), ".rarp/\n");
writeFileSync(join(root, "feature.txt"), "base");
git(root, "add", ".");
git(root, "commit", "-m", "Demo base");
const store = new Store(root, true);
store.register("manager", "manager");
store.register("worker-ui", "worker");
store.register("worker-core", "worker");
const create = (title, worker, dependencies = []) =>
  store.create({
    title,
    body: "Dữ liệu demo để kiểm tra UI. Worker sử dụng fixture, không gọi model AI.",
    actor: "manager",
    assignee: worker,
    dependencies,
  });
const completed = create("Chuẩn hóa dữ liệu giỏ hàng", "worker-core");
store.transition(completed.id, "running", "worker-core", "Bắt đầu demo");
const workspace = prepareWorkspace(
  root,
  completed.id,
  ["feature.txt"],
  [
    process.execPath,
    "-e",
    "require('node:assert').equal(require('node:fs').readFileSync('feature.txt','utf8'),'done')",
  ],
);
writeFileSync(join(workspace.path, "feature.txt"), "done");
checkpoint(workspace);
const evidence = verifyWorkspace(workspace);
store.saveWorkspace(workspace);
store.transition(completed.id, "submitted", "worker-core", evidence);
store.transition(completed.id, "reviewing", "manager", "Đọc thay đổi demo");
store.transition(
  completed.id,
  "accepted",
  "manager",
  "Fixture: kiểm tra feature.txt bằng node:assert thành công",
);
workspace.integrated = integrateWorkspace(root, workspace);
store.saveWorkspace(workspace);
create("Bổ sung quy tắc giảm giá", "worker-core", [completed.id]);
const failed = create("Kiểm tra định dạng đầu vào", "worker-ui");
store.transition(failed.id, "running", "worker-ui", "Bắt đầu");
store.transition(
  failed.id,
  "failed",
  "worker-ui",
  "Fixture: lỗi đầu vào; kiểm tra và retry có kiểm soát.",
);
const submitted = create("Kiểm tra thông báo kết quả", "worker-ui");
store.transition(submitted.id, "running", "worker-ui", "Bắt đầu");
store.transition(
  submitted.id,
  "submitted",
  "worker-ui",
  "Demo report: cần manager kiểm tra độc lập.",
);
const blocked = create("Chuẩn bị bài kiểm tra tích hợp", "worker-core", [
  submitted.id,
]);
store.transition(
  blocked.id,
  "blocked",
  "manager",
  "Chờ nghiệm thu task phụ thuộc.",
);
const command = (role) => ({
  file: process.execPath,
  args: [resolve("tests/fixtures/isolated-agent.mjs"), role],
});
const runtime = await startRuntime(root, command("worker"), {
  manager: command("manager"),
});
const meta = JSON.parse(readFileSync(join(root, ".rarp/runtime.json"), "utf8"));
console.log(
  JSON.stringify({
    root,
    url: `http://127.0.0.1:${meta.port}/ui/#token=${meta.token}`,
  }),
);
async function stop() {
  await runtime.stop();
  store.close();
  process.exit();
}
process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());
