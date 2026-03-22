import { startRuntime } from "./server.js";
import { codexCommand } from "../adapters/codex.js";
try {
  const runtime = await startRuntime(
    process.argv[2]!,
    codexCommand(process.argv[3] ?? "codex"),
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
