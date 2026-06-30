import { startRuntime } from "./server.js";
import { codexCommand, codexPlannerCommand, codexReviewCommand } from "../adapters/codex.js";
import { antigravityCommand } from "../adapters/antigravity.js";
try {
  const runtime = await startRuntime(
    process.argv[2]!,
    codexCommand(process.argv[3] ?? "codex"),
    {
      antigravity: antigravityCommand(process.argv[4] ?? "agy"),
      planner: codexPlannerCommand(process.argv[3] ?? "codex", process.argv[7]),
      manager: codexReviewCommand(process.argv[3] ?? "codex", process.argv[7]),
    },
    {
      maxWorkers: Number(process.argv[5] ?? 2),
      maxReviewers: Number(process.argv[6] ?? 1),
    },
  );
  process.send?.({ ready: true });
  process.disconnect?.();
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.on(signal, () => {
      void runtime.stop().catch(console.error);
    });
} catch (error) {
  process.send?.({ error: String(error) });
  process.exitCode = 1;
  process.disconnect?.();
}
