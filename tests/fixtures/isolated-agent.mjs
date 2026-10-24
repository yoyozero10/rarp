import { readFileSync, writeFileSync } from "node:fs";
const role = process.argv[2];
process.stdin.setEncoding("utf8");
let prompt = "";
process.stdin.on("data", (chunk) => { prompt += chunk; });
process.stdin.on("end", () => {
  if (role === "feature-worker") {
    if (prompt.includes('"src/total.mjs"'))
      writeFileSync("src/total.mjs", "export function total(items) { return items.reduce((sum, {price, quantity}) => { if (!Number.isFinite(price) || price < 0 || !Number.isInteger(quantity) || quantity < 0) throw new Error('Invalid item'); return sum + price * quantity; }, 0); }\n");
    else
      writeFileSync("src/discount.mjs", "import {total} from './total.mjs'; export function payable(items, percent) { if (!Number.isFinite(percent) || percent < 0 || percent > 100) throw new Error('Invalid percent'); return total(items) * (1 - percent / 100); }\n");
  }
  if (role === "feature-worker" || role === "feature-manager") {
    const text = role === "feature-worker" ? "Implemented feature; verification runs in workflow" : JSON.stringify({decision:"accepted",feedback:"Fixture reviewer; not a live model review",evidence:["Workflow verification command passed"]});
    console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text}}));
    console.log(JSON.stringify({type:"turn.completed"}));
    return;
  }
  if (role === "must-not-run") process.exit(9);
  if (role === "worker") writeFileSync("feature.txt", "done");
  const text =
    role === "worker"
      ? "Implemented feature"
      : JSON.stringify({
          decision:
            readFileSync("feature.txt", "utf8") === "done"
              ? "accepted"
              : "changes_requested",
          feedback: "Verified actual file",
          evidence: ["feature.txt contains done"],
        });
  console.log(
    JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text },
    }),
  );
  console.log(JSON.stringify({ type: "turn.completed" }));
});
