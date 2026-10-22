import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const mode = process.argv[2];
process.stdin.resume();
process.stdin.on("end", () => {
  if (mode === "hang") {
    const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      stdio: "ignore",
    });
    writeFileSync("child.pid", String(child.pid));
    setInterval(() => {}, 1000);
    return;
  }
  if (mode === "bad") {
    console.log("not json");
    setInterval(() => {}, 1000);
    return;
  }
  if (mode === "failure") {
    console.log(
      JSON.stringify({ type: "turn.failed", error: { message: "fixture" } }),
    );
    process.exitCode = 1;
    return;
  }
  if (mode === "incomplete") {
    console.log(JSON.stringify({ type: "thread.started" }));
    return;
  }
  const output =
    JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: "verified fixture" },
    }) +
    "\n" +
    JSON.stringify({ type: "turn.completed" }) +
    "\n";
  process.stdout.write(output.slice(0, 17));
  setTimeout(() => process.stdout.write(output.slice(17)), 20);
});
