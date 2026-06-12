import { z } from "zod";
export const dispatchSchema = z.object({
  taskId: z.string().min(1),
  executionId: z.string().optional(),
  profile: z.string().default("default"),
  timeoutMs: z.number().int().min(100).max(3600000).default(120000),
  adapter: z.enum(["codex", "antigravity"]).default("codex"),
  maxRounds: z.number().int().min(1).max(10).default(3),
  requestKey: z.string().min(1).max(128).optional(),
  isolated: z.boolean().default(false),
  resumeReview: z.boolean().default(false),
  enqueue: z.boolean().default(false),
  scope: z.array(z.string()).default([]),
  check: z.array(z.string()).default([]),
  totalTimeoutMs: z.number().int().min(100).max(3600000).default(600000),
});
export type DispatchInput = z.infer<typeof dispatchSchema>;
export interface Dispatch {
  key: string;
  fingerprint: string;
  taskId: string;
  route: "run" | "workflow";
  input: DispatchInput;
  state: string;
  note: string;
}
