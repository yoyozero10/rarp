import { readFileSync, writeFileSync, existsSync } from "node:fs";
const [role, mode = "repair"] = process.argv.slice(2);
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (prompt += chunk));
process.stdin.on("end", () => {
  let text;
  if (role === "worker") {
    const count = existsSync("count")
      ? Number(readFileSync("count", "utf8")) + 1
      : 1;
    writeFileSync("count", String(count));
    writeFileSync("prompt-" + count, prompt);
    writeFileSync(
      "cart.json",
      JSON.stringify({ payable: mode === "accept" || count > 1 ? 50000 : 999 }),
    );
    text = "Written cart.json";
  } else {
    if (mode === "hang") {
      writeFileSync("review-started", "yes");
      setInterval(() => {}, 1000);
      return;
    }
    const cart = JSON.parse(readFileSync("cart.json", "utf8"));
    const decision =
      mode === "reject" || cart.payable !== 50000
        ? "changes_requested"
        : "accepted";
    text =
      mode === "invalid"
        ? "looks fine"
        : JSON.stringify({
            decision,
            feedback:
              decision === "accepted" ? "Verified" : "Set payable to 50000",
            evidence: [`Read cart.json payable=${cart.payable}`],
          });
  }
  if (role === "worker")
    console.log(
      JSON.stringify({
        event: "result",
        result: { status: "SUCCESS", response: text },
      }),
    );
  else {
    console.log(
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text },
      }),
    );
    console.log(JSON.stringify({ type: "turn.completed" }));
  }
});
