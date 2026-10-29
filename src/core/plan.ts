import { z } from "zod";
import { createHash } from "node:crypto";

const text = z.string().trim().min(1).max(12000);
const key = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,39}$/);
export const budgetSchema = z.object({
  maxRounds: z.number().int().min(1).max(10),
  maxRetries: z.number().int().min(0).max(10).default(2),
  timeoutMs: z.number().int().min(100).max(3600000),
  totalTimeoutMs: z.number().int().min(100).max(3600000),
}).strict();
export type Budget = z.infer<typeof budgetSchema>;
export type StopReason = 'human' | 'budget' | 'worker' | 'review' | 'integration' | 'verification' | 'configuration' | 'repository' | 'no-progress';
export interface TaskUsage { rounds: number; retries: number; feedback?: string; stopReason?: StopReason; retryAt?: number; signature?: string; }
export interface Execution { startedAt?: number; elapsedMs?: number; tasks: Record<string, TaskUsage>; verification?: { head: string; passed: boolean; evidence: string[] }; }
export const safeScope = z.string().min(1).max(240).refine((s) =>
  !s.includes("\\") && !s.includes(":") && !s.startsWith("/") &&
  s.split("/").every((p) => p !== "." && p !== ".." && p.length > 0 && !/[. ]$/.test(p) && !p.startsWith('-') && !/[\x00-\x1f*?]/.test(p) && ![".git", ".rarp"].includes(p.toLowerCase())), "Unsafe repository scope");
export const checkSchema = z.array(z.string().min(1).max(2000)).min(1).max(64).refine((argv) =>
  /^[^{}\[\]"';&|<>\r\n]+$/.test(argv[0]!) && !argv.some((s) => /dangerously|bypass|skip.*(?:approval|sandbox)|yolo|--approval|--sandbox|--full-auto/i.test(s)), "Expected executable + argv without unsafe verification flags");
export const proposalSchema = z.object({
  understood: text,
  assumptions: z.array(text).max(30),
  questions: z.array(text).max(30),
  rationale: text,
  size: z.enum(["small", "medium", "large"]),
  confidence: z.enum(["low", "medium", "high"]),
  workers: z.array(z.object({ workerRef: key, rationale: text }).strict()).min(1).max(16),
  maxWorkers: z.number().int().min(1).max(16),
  steps: z.array(z.object({
    key, title: text.max(500), requirements: text, deliverable: text,
    dependencies: z.array(key).max(64), workerRef: key,
    scope: z.array(safeScope).min(1).max(64), check: checkSchema.describe('Executable followed by individual arguments, for example ["node", "-e", "require(\'node:assert\').equal(1,1)"]. Never JSON strings, prose, command objects, or shell strings.'),
    acceptance: z.array(text).min(1).max(30),
  }).strict()).min(1).max(64),
  policy: budgetSchema,
}).strict();
export type Proposal = z.infer<typeof proposalSchema>;
export const goalSchema = z.object({ title: text.max(500), requirements: text, acceptance: z.array(text).min(1).max(30), maxWorkers: z.number().int().min(1).max(16).default(4) }).strict();
export const approvalSchema = z.object({
  revision: z.number().int().positive(), contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  actor: z.literal("human"), maxWorkers: z.number().int().min(1).max(16), maxReviewers: z.number().int().min(1).max(16),
  workers: z.array(z.object({ workerRef: key, adapter: z.enum(["codex", "antigravity"]), profile: key }).strict()).min(1).max(16),
  integration: z.enum(["reviewed-local", "manual"]),
  budget: budgetSchema.optional(),
}).strict();
export type Approval = z.infer<typeof approvalSchema>;
export interface Goal { id: string; title: string; requirements: string; acceptance: string[]; maxWorkers: number; status: string; createdAt: string; }
export interface Plan { id: string; goalId: string; revision: number; contentHash: string; baseHead: string; fingerprint: string; status: string; proposal: Proposal | null; approval?: Approval; bindings?: Record<string,string>; executionSnapshot?: {baseHead:string;fingerprint:string}; execution?: Execution; stopReason?: StopReason; note?: string; createdAt: string; }
export const planBudget = (p: Plan): Budget => budgetSchema.parse(p.approval?.budget ?? p.proposal?.policy);
export const remainingTime = (p: Plan) => Math.max(0,planBudget(p).totalTimeoutMs-(p.execution?.elapsedMs??0)-(p.execution?.startedAt?Date.now()-p.execution.startedAt:0));
export function overlap(a: string[], b: string[]) {
  return a.some((x) => b.some((y) => { x=x.toLowerCase(); y=y.toLowerCase(); return x===y || x.startsWith(y+"/") || y.startsWith(x+"/"); }));
}
export function validateProposal(input: unknown): Proposal {
  const p = proposalSchema.parse(input), steps = new Map(p.steps.map((s) => [s.key,s])), workers = new Set(p.workers.map((w) => w.workerRef));
  if (steps.size!==p.steps.length || workers.size!==p.workers.length) throw new Error("Duplicate step or workerRef");
  const visiting=new Set<string>(), done=new Set<string>();
  const visit=(id:string) => { if(visiting.has(id)) throw new Error("Dependency cycle"); if(done.has(id)) return; const s=steps.get(id); if(!s) throw new Error("Unknown dependency: "+id); visiting.add(id); for(const d of s.dependencies) visit(d); visiting.delete(id); done.add(id); };
  for(const s of p.steps) { if(!workers.has(s.workerRef)) throw new Error("Unknown workerRef"); if(new Set(s.dependencies).size!==s.dependencies.length) throw new Error("Duplicate dependency"); visit(s.key); }
  const before=(a:string,b:string):boolean => steps.get(b)!.dependencies.some((d) => d===a || before(a,d));
  for(let i=0;i<p.steps.length;i++) for(let j=i+1;j<p.steps.length;j++) { const a=p.steps[i]!, b=p.steps[j]!; if(overlap(a.scope,b.scope) && !before(a.key,b.key) && !before(b.key,a.key)) throw new Error("Overlapping scopes require explicit dependency: "+a.key+", "+b.key); }
  if(p.maxWorkers>workers.size) throw new Error("Slot count exceeds worker count");
  if(p.maxWorkers>Math.max(...waves({...p,maxWorkers:16}).map(w=>w.length))) throw new Error('Slot count exceeds safe DAG parallelism');
  return p;
}
export function waves(p: Proposal) {
  const done=new Set<string>(), result:string[][]=[];
  while(done.size<p.steps.length) { const used=new Set<string>(); const wave=p.steps.filter((s) => !done.has(s.key) && s.dependencies.every((d) => done.has(d)) && !used.has(s.workerRef) && !!used.add(s.workerRef)).slice(0,p.maxWorkers).map((s)=>s.key); if(!wave.length) throw new Error("Invalid DAG"); result.push(wave); wave.forEach((k)=>done.add(k)); }
  return result;
}
function canonical(value: unknown): unknown { if(Array.isArray(value)) return value.map(canonical); if(value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,canonical(v)])); return value; }
export const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
