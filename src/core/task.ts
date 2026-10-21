import { z } from "zod";
export const statusSchema = z.enum([
  "queued",
  "running",
  "submitted",
  "reviewing",
  "accepted",
  "changes_requested",
  "blocked",
  "failed",
  "cancelled",
]);
export type TaskStatus = z.infer<typeof statusSchema>;
export const idSchema = z.string().trim().min(1).max(128);
export const roleSchema = z.enum(["manager", "worker"]);
export const textSchema = z.string().trim().min(1).max(20000);
export const createTaskSchema = z.object({
  title: z.string().trim().min(1).max(240),
  body: z.string().max(20000).default(""),
  actor: idSchema,
  assignee: idSchema,
  dependencies: z.array(idSchema).default([]),
});
export const transitions: Record<TaskStatus, readonly TaskStatus[]> = {
  queued: ["running", "blocked", "cancelled"],
  running: ["submitted", "blocked", "failed", "cancelled"],
  submitted: ["reviewing", "cancelled"],
  reviewing: ["accepted", "changes_requested", "cancelled"],
  changes_requested: ["queued", "cancelled"],
  blocked: ["queued", "cancelled"],
  failed: ["queued", "cancelled"],
  accepted: [],
  cancelled: [],
};
export interface Task {
  id: string;
  title: string;
  body: string;
  created_by: string;
  assigned_to: string;
  status: TaskStatus;
  created_at: string;
  updated_at: string;
}
