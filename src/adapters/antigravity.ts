import { CodexStream } from "./codex.js";
import type { CommandSpec } from "./codex.js";
export const ANTIGRAVITY_FULL_ACCESS = "--dangerously-skip-permissions";
export function withFullAccess(command: CommandSpec, enabled: boolean): CommandSpec {
  if (!enabled || command.protocol !== "antigravity") return command;
  const args = [...command.args];
  const print = args.indexOf("--print");
  args.splice(print >= 0 ? print : args.length, 0, ANTIGRAVITY_FULL_ACCESS);
  return { ...command, args };
}
export function antigravityCommand(file = "agy"): CommandSpec {
  return {
    file,
    args: [
      "--sandbox",
      "--disable-slash-commands",
      "--output-format",
      "stream-json",
      "--print",
    ],
    protocol: "antigravity",
    promptArgument: true,
  };
}
/** Reuses bounded JSONL framing, normalizing the AG result envelope. */
export class AntigravityStream {
  failureReason = "";
  private parser: CodexStream;
  get completed() {
    return this.parser.completed;
  }
  get failed() {
    return this.parser.failed;
  }
  get result() {
    return this.parser.result;
  }
  private buffer = "";
  constructor(private emit: (event: Record<string, unknown>) => void) {
    this.parser = new CodexStream(() => {});
  }
  feed(chunk: string) {
    this.buffer += chunk;
    if (this.buffer.length > 1024 * 1024)
      throw new Error("Antigravity event exceeds 1 MiB");
    let end: number;
    while ((end = this.buffer.indexOf("\n")) !== -1) {
      this.line(this.buffer.slice(0, end));
      this.buffer = this.buffer.slice(end + 1);
    }
  }
  finish() {
    if (this.buffer.trim()) this.line(this.buffer);
    this.buffer = "";
  }
  private line(line: string) {
    if (!line.trim()) return;
    const event = JSON.parse(line) as Record<string, unknown>;
    if (!event || typeof event.event !== "string")
      throw new Error("Invalid Antigravity event");
    this.emit(event);
    if (event.event === "result") {
      const result = event.result as Record<string, unknown> | undefined;
      if (
        Array.isArray(result?.denied_actions) &&
        result.denied_actions.length
      ) {
        this.failureReason =
          "Antigravity tool permissions denied; configure permissions before retrying";
        this.parser.feed('{"type":"turn.failed"}\n');
        return;
      }
      if (result?.status === "SUCCESS" && typeof result.response === "string") {
        this.parser.feed(
          JSON.stringify({
            type: "item.completed",
            item: { type: "agent_message", text: result.response },
          }) + "\n",
        );
        this.parser.feed('{"type":"turn.completed"}\n');
      } else {
        const error=result?.error;
        const message=typeof error==='string'?error:error && typeof error==='object'?(error as Record<string,unknown>)['message']:result?.message??result?.response;
        if(typeof message==='string')this.failureReason=message.slice(-19000);
        this.parser.feed('{"type":"turn.failed"}\n');
      }
    }
  }
}
