import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
const role = process.argv[2];
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (s) => (prompt += s));
process.stdin.on("end", () => {
  const line = prompt.split("\n").find((s) => s.startsWith("TASK "));
  const task = JSON.parse(line.slice(5)),
    body = JSON.parse(task.body);
  writeFileSync(
    join(body.probe, body.file + "." + role + ".pid"),
    String(process.pid),
  );
  if (role === "worker") writeFileSync(body.file, "partial");
  const finish = () => {
    let text;
    if (role === "worker") {
      writeFileSync(body.file, "done");
      text = "Wrote " + body.file;
    } else {
      const actual = readFileSync(body.file, "utf8");
      text = JSON.stringify({
        decision: actual === "done" ? "accepted" : "changes_requested",
        feedback: "Fixture read actual file",
        evidence: [body.file + "=" + actual],
      });
    }
    writeFileSync(
      join(body.probe, body.file + "." + role + ".finished"),
      "yes",
    );
    console.log(
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text },
      }),
    );
    console.log(JSON.stringify({ type: "turn.completed" }));
  };
  if (existsSync(join(body.probe, "release-" + role))) finish();
  else {
    const timer = setInterval(() => {
      if (existsSync(join(body.probe, "release-" + role))) {
        clearInterval(timer);
        finish();
      }
    }, 50);
  }
});
