import { fileURLToPath } from "node:url";
export function codexReviewCommand(file = "codex"): CommandSpec {
  const command = codexCommand(file, "read-only");
  command.args.splice(
    -1,
    0,
    "--output-schema",
    fileURLToPath(new URL("../../schemas/review.json", import.meta.url)),
  );
  return command;
}
export interface CommandSpec {
  file: string;
  args: string[];
  protocol?: "codex" | "antigravity";
  promptArgument?: boolean;
}
export function codexCommand(
  file = "codex",
  sandbox = "workspace-write",
): CommandSpec {
  return {
    file,
    args: [
      "--no-daemon",
      "-a",
      "never",
      "exec",
      "--json",
      "--ephemeral",
      "--skip-git-repo-check",
      "--sandbox",
      sandbox,
      "--color",
      "never",
      "-",
    ],
  };
}
/** Bounded incremental JSONL parser; accepts split UTF-8 through setEncoding upstream. */
export class CodexStream {
  private buffer = "";
  completed = false;
  failed = false;
  result = "";
  failureReason = "";
  constructor(private emit: (event: Record<string, unknown>) => void) {}
  feed(chunk: string) {
    this.buffer += chunk;
    if (this.buffer.length > 1024 * 1024)
      throw new Error("Codex event exceeds 1 MiB");
    let end: number;
    while ((end = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 1);
      this.line(line);
    }
  }
  finish() {
    if (this.buffer.trim()) this.line(this.buffer);
    this.buffer = "";
  }
  private line(line: string) {
    if (!line.trim()) return;
    const event: unknown = JSON.parse(line);
    if (
      !event ||
      typeof event !== "object" ||
      !("type" in event) ||
      typeof event.type !== "string"
    )
      throw new Error("Invalid Codex event");
    const data = event as Record<string, unknown>;
    if (data.type === "turn.completed") this.completed = true;
    if (data.type === "turn.failed" || data.type === "error")
      this.failed = true;
    if (
      data.type === "item.completed" &&
      data.item &&
      typeof data.item === "object"
    ) {
      const item = data.item as Record<string, unknown>;
      if (item.type === "agent_message" && typeof item.text === "string")
        this.result = item.text.slice(-19000);
    }
    this.emit(data);
  }
}
