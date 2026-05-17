// Disposable four-worker fixture demo; no paid model calls.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Store } from "../dist/storage/store.js";
import { startRuntime, runtimeRequest } from "../dist/runtime/server.js";
import { git } from "../dist/runtime/workspace.js";
const root = mkdtempSync(join(tmpdir(), "rarp-phase6-demo-"));
git(root, "init");
git(root, "config", "user.name", "Rarp demo");
git(root, "config", "user.email", "demo@localhost");
writeFileSync(join(root, ".gitignore"), ".rarp/\n");
for (const file of ["a.txt", "b.txt", "c.txt", "d.txt", "e.txt"])
  writeFileSync(join(root, file), "base");
git(root, "add", ".");
git(root, "commit", "-m", "Demo base");
const store = new Store(root, true),
  probe = join(root, ".rarp", "probe");
mkdirSync(probe);
store.register("manager", "manager");
for (let i = 0; i < 4; i++) store.register("worker-" + (i + 1), "worker");
const titles = [
  "Chuẩn hóa giỏ hàng",
  "Bổ sung quy tắc giảm giá",
  "Tính phí giao hàng",
  "Kiểm tra làm tròn tiền",
  "Tổng hợp kết quả thanh toán",
];
const tasks = titles.map((title, i) =>
  store.create({
    title: "Demo · " + title,
    body: JSON.stringify({ file: String.fromCharCode(97 + i) + ".txt", probe }),
    actor: "manager",
    assignee: "worker-" + ((i % 4) + 1),
    dependencies: i === 4 ? store.list().map((t) => String(t.id)) : [],
  }),
);
const command = (role) => ({
  file: process.execPath,
  args: [resolve("tests/fixtures/parallel-agent.mjs"), role],
});
const runtime = await startRuntime(
  root,
  command("worker"),
  { manager: command("manager") },
  { maxWorkers: 4, maxReviewers: 1 },
);
for (let i = 0; i < tasks.length; i++) {
  const file = String.fromCharCode(97 + i) + ".txt";
  await runtimeRequest(root, "workflow", {
    taskId: tasks[i].id,
    isolated: true,
    enqueue: true,
    scope: [file],
    check: [
      process.execPath,
      "-e",
      `require('node:assert').equal(require('node:fs').readFileSync('${file}','utf8'),'done')`,
    ],
    requestKey: tasks[i].id,
    timeoutMs: 600000,
    totalTimeoutMs: 900000,
  });
}
const meta = JSON.parse(readFileSync(join(root, ".rarp/runtime.json"), "utf8"));
console.log(
  JSON.stringify({
    root,
    url: `http://127.0.0.1:${meta.port}/ui/#token=${meta.token}`,
  }),
);
console.log(
  "Fixture demo. Press Enter to release workers/reviewer; integrate accepted tasks in the UI.",
);
process.stdin.once("data", () => {
  writeFileSync(join(probe, "release-worker"), "go");
  writeFileSync(join(probe, "release-manager"), "go");
  process.stdin.pause();
});
async function stop() {
  await runtime.stop();
  store.close();
  process.exit();
}
process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());
