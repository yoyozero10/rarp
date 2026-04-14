import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { Store } from "../storage/store.js";
export function recoverRuntime(root: string) {
  const guard = join(root, ".rarp", "recovery.lock");
  writeFileSync(guard, String(process.pid), { flag: "wx" });
  let store: Store | undefined;
  try {
    const lock = join(root, ".rarp", "runtime.json");
    let original: string | undefined;
    if (existsSync(lock)) {
      original = readFileSync(lock, "utf8");
      const data = JSON.parse(original) as { pid: number };
      if (!Number.isInteger(data.pid) || data.pid < 1)
        throw new Error("Invalid runtime PID; inspect manually");
      try {
        process.kill(data.pid, 0);
        throw new Error("Runtime still alive; recovery refused");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e;
      }
    }
    store = new Store(root);
    const runs = store.recoverRuns();
    if (original !== undefined) {
      if (readFileSync(lock, "utf8") !== original)
        throw new Error("Runtime lock changed");
      unlinkSync(lock);
    }
    return {
      recovered: runs,
      message:
        "Inspect preserved workspaces. Submitted tasks may resume review; interrupted workers require explicit retry.",
    };
  } finally {
    store?.close();
    unlinkSync(guard);
  }
}
