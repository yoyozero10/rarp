import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, lstatSync } from "node:fs";
import { join, delimiter } from "node:path";
import { z } from "zod";
import { codexPlannerCommand, codexReviewCommand } from "../adapters/codex.js";
import type { CommandSpec } from "../adapters/codex.js";
import { antigravityCommand, withFullAccess } from "../adapters/antigravity.js";
import { hash, waves, approvalSchema, planBudget, remainingTime } from "../core/plan.js";
import type { Store } from "../storage/store.js";
import { runWorker } from "./process.js";

export function repositorySnapshot(root: string) {
  const git=(args:string[])=>execFileSync('git',args,{cwd:root,encoding:'utf8',maxBuffer:16*1024*1024});
  const head=git(['rev-parse','HEAD']).trim();
  const paths=git(['ls-files','-z','--cached','--others','--exclude-standard']).split('\0').filter(p=>p && !p.startsWith('.rarp/') && !p.startsWith('.git/')).sort();
  const files=paths.map(path=>{ try { const stat=lstatSync(join(root,path)); if(!stat.isFile() || stat.isSymbolicLink()) return {path,hash:'nonregular'}; return {path,hash:hash(readFileSync(join(root,path)).toString('base64'))}; } catch { return {path,hash:'missing'}; } });
  return {baseHead:head,fingerprint:hash({head,files}),files};
}
export function available(file: string) {
  const extensions=process.platform==='win32' ? ['',...(process.env['PATHEXT']??'.EXE;.CMD;.BAT').split(';')] : [''];
  return [file,...(process.env['PATH']??'').split(delimiter).map(p=>join(p,file))].some(p=>extensions.some(e=>existsSync(p+e)));
}
export type PlanningAdapters = { antigravity?: CommandSpec; manager?: CommandSpec; planner?: CommandSpec; profiles?: Record<string, {adapter:'codex'|'antigravity'; command:CommandSpec; authenticated:boolean; model:string}> };
export function loadProfiles(root:string): PlanningAdapters['profiles'] {
  const file=join(root,'.rarp','profiles.json');
  if(!existsSync(file)) return undefined;
  const values=z.record(z.string(),z.object({adapter:z.enum(['codex','antigravity']),command:z.object({file:z.string().min(1),args:z.array(z.string()),protocol:z.enum(['codex','antigravity','check']).optional(),promptArgument:z.boolean().optional()}).strict(),authenticated:z.boolean(),model:z.string().min(1)}).strict()).parse(JSON.parse(readFileSync(file,'utf8')));
  return Object.fromEntries(Object.entries(values).map(([key,value])=>[key,{...value,command:{file:value.command.file,args:value.command.args,...(value.command.protocol?{protocol:value.command.protocol}:{}),...(value.command.promptArgument!==undefined?{promptArgument:value.command.promptArgument}:{})}}]));
}
export function profileCommand(adapters: PlanningAdapters, command:CommandSpec, adapter:'codex'|'antigravity', profile:string) {
  const configured=adapters.profiles?.[adapter+':'+profile];
  if(configured) { if(configured.adapter!==adapter || !configured.authenticated || !configured.model) throw new Error('Profile/model/authentication unavailable'); const args=[...configured.command.args]; const index=args.indexOf('--model'); if(index>=0 && args[index+1]!==configured.model) throw new Error('Profile model conflicts with command'); const short=args.indexOf('-m'); if(short>=0 && args[short+1]!==configured.model) throw new Error('Profile model conflicts with command'); if(index<0 && short<0) args.splice(args.includes('--print')?args.indexOf('--print'):args.includes('-p')?args.indexOf('-p'):args.at(-1)==='-'?args.length-1:args.length,0,'--model',configured.model); return {...configured.command,args}; }
  if(profile!=='default') throw new Error('Unknown profile: '+profile);
  if(adapter==='antigravity') { if(!adapters.antigravity) throw new Error('Antigravity profile not configured; no fallback'); return adapters.antigravity; }
  return command;
}
export function createPlanning(store:Store,root:string,scheduler: {snapshot:()=>{limits:{maxWorkers:number;maxReviewers:number}};cancel:(taskId?:string)=>Promise<void>},command:CommandSpec,adapters:PlanningAdapters) {
  const analyses=new Map<string,ReturnType<typeof runWorker>>();
  const cliProfile=(selected?:CommandSpec)=>{
    const args=selected?.args??[], index=args.findIndex(a=>a==='--profile'||a==='-p');
    return index>=0?args[index+1]??null:null;
  };
  const detail=(id:string)=>{ const p=store.plan(id); return {...p,budget:p.proposal?planBudget(p):null,remainingMs:p.proposal?remainingTime(p):null,counts:{tasks:p.proposal?.steps.length??0,workers:p.proposal?.workers.length??0,slots:p.approval?.maxWorkers??p.proposal?.maxWorkers??0},waves:p.proposal?waves(p.proposal):[],history:store.planHistory(id),tasks:store.planLinks(id).map(l=>({...l,task:store.show(l.taskId),usage:store.taskUsage(l.taskId),workspace:store.workspace(l.taskId)})),logs:store.planLogs(id)}; };
  async function analyze(id:string,body:unknown) {
    const input=z.object({clarification:z.string().max(12000).optional()}).strict().parse(body), plan=store.plan(id);
    if(analyses.has(id) || ['executing','completed','cancelled','materializing'].includes(plan.status)) throw new Error('Plan cannot be analyzed now');
    const before=repositorySnapshot(root), goal=store.goal(plan.goalId);
    const selected=adapters.planner??codexPlannerCommand(command.file);
    if(!available(selected.file)) throw new Error('Planner executable unavailable');
    store.planState(id,'analyzing');
    const prompt=`You are a read-only Rarp planner. Do not execute commands, tests, builds, tools that modify files, or delegate. Never approve or dispatch. Return only JSON matching this schema:\n${JSON.stringify(JSON.parse(readFileSync(new URL('../../schemas/plan.json',import.meta.url),'utf8')))}\nRead repository as needed without modifications. Ask unresolved questions; do not guess. Prefer one task/worker for small changes. Max slots ${Math.min(4,goal.maxWorkers,scheduler.snapshot().limits.maxWorkers)}. Explicitly serialize overlapping scopes. Tests are executable+argv arrays, no shell concatenation. Acceptance must be observable from code/tests, not tool usage history.\nGoal: ${JSON.stringify(goal)}\nClarification: ${input.clarification??''}\nRepository: ${JSON.stringify(before)}`;
    store.plannerLog(id,{type:'analysis.started',revision:plan.revision,clarification:input.clarification});
    const worker=runWorker(selected,root,prompt,120000,e=>store.plannerLog(id,e)); analyses.set(id,worker);
    try { const result=await worker.done; if(!result.success) throw new Error(result.note); const after=repositorySnapshot(root); if(after.fingerprint!==before.fingerprint) throw new Error('Repository changed during analysis'); if(store.plan(id).status!=='analyzing') throw new Error('Analysis cancelled'); store.updatePlan(id,plan.revision,JSON.parse(result.note),before.baseHead,before.fingerprint); return detail(id); }
    catch(error) { if(store.plan(id).status==='analyzing') store.planState(id,'failed',String(error)); throw error; }
    finally { analyses.delete(id); }
  }
  return {detail, analyze,
    profiles() { const configured=Object.entries(adapters.profiles??{}).map(([id,p])=>({id,adapter:p.adapter,profile:id.slice(id.indexOf(':')+1),model:p.model,available:available(p.command.file),authenticated:p.authenticated,supported:true})); return {profiles:[{id:'codex:default',adapter:'codex',profile:'default',model:'CLI default',available:available(command.file),authenticated:null,supported:true},{id:'antigravity:default',adapter:'antigravity',profile:'default',model:null,available:!!adapters.antigravity && available(adapters.antigravity.file),authenticated:null,supported:!!adapters.antigravity},...configured].filter((p,i,all)=>all.findLastIndex(x=>x.id===p.id)===i),planner:{adapter:'codex',readOnly:true,profile:cliProfile(adapters.planner)},reviewer:{adapter:'codex',separate:true,profile:cliProfile(adapters.manager)}}; },
    update(id:string,body:unknown) { const input=z.object({revision:z.number().int().nonnegative(),proposal:z.unknown()}).strict().parse(body); if(analyses.has(id)) throw new Error('Analysis active'); const snap=repositorySnapshot(root); store.updatePlan(id,input.revision,input.proposal,snap.baseHead,snap.fingerprint); return detail(id); },
    approve(id:string,body:unknown) { const input=approvalSchema.parse(body), capacity=scheduler.snapshot().limits;
      if(input.maxWorkers>capacity.maxWorkers || input.maxReviewers>capacity.maxReviewers) throw new Error('Approval exceeds runtime capacity');
      if(execFileSync('git',['status','--porcelain'],{cwd:root,encoding:'utf8',windowsHide:true}).trim()) throw new Error('Main checkout must be clean before approval');
      for(const w of input.workers) { const c=profileCommand(adapters,command,w.adapter,w.profile); if(!available(c.file)) throw new Error('Worker executable unavailable: '+w.adapter);
        if(!adapters.profiles?.[w.adapter+':'+w.profile]) {
          if(w.adapter==='codex' && c.args.includes('exec')) { const auth=spawnSync(c.file,['login','status'],{windowsHide:true,timeout:10000,stdio:'ignore'}); if(auth.error || auth.status!==0) throw new Error('Codex authentication unavailable'); }
          else if(c.protocol==='antigravity') throw new Error('Antigravity requires an explicit authenticated model profile');
        }
      }
      const snap=repositorySnapshot(root); store.approvePlan(id,input,snap.baseHead,snap.fingerprint,{...Object.fromEntries(input.workers.map(w=>[w.workerRef,hash(profileCommand(adapters,command,w.adapter,w.profile))])),__manager:hash(adapters.manager??codexReviewCommand(command.file))}); return detail(id);
    },
    async control(id:string,action:string) { const p=store.plan(id); if(action==='cancel') { store.planState(id,'cancelled'); await analyses.get(id)?.cancel(); for(const l of store.planLinks(id)) { try { await scheduler.cancel(l.taskId); } catch(error) { const d=store.dispatches().find(d=>d.taskId===l.taskId && ['active','waiting'].includes(d.state)); if(d) throw error; } } }
      else if(action==='reject') { if(!['awaiting_approval','needs_clarification','received','failed'].includes(p.status)) throw new Error('Plan cannot be rejected'); store.planState(id,'rejected'); }
      else if(action==='pause') { if(p.status!=='executing') throw new Error('Plan not executing'); store.planState(id,'paused','Human pause','human'); for(const link of store.planLinks(id)) if(store.runs().some(r=>r['task_id']===link.taskId && r['state']==='active'))await scheduler.cancel(link.taskId); }
      else if(action==='resume') { if(p.status==='executing')return detail(id);if(p.status!=='paused' || !p.approval) throw new Error('Approved paused execution required'); const snap=repositorySnapshot(root), expected=p.executionSnapshot??p; if(snap.baseHead!==expected.baseHead || snap.fingerprint!==expected.fingerprint) throw new Error('Repository stale; revise and approve again'); for(const w of p.approval.workers) {const selected=profileCommand(adapters,command,w.adapter,w.profile);if(!available(selected.file) || p.bindings?.[w.workerRef]!==hash(selected)) throw new Error('Profile changed or unavailable; revise and approve again');} store.retryPlan(id); }
      else throw new Error('Unknown action'); return detail(id);
    },
    async shutdown() { await Promise.all([...analyses.values()].map(a=>a.cancel())); }
  };
}
