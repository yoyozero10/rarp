import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {Store} from '../dist/storage/store.js';
import {repositorySnapshot} from '../dist/runtime/planning.js';
import {startRuntime,runtimeRequest} from '../dist/runtime/server.js';
import {git,prepareWorkspace,checkpoint} from '../dist/runtime/workspace.js';
import {AntigravityStream} from '../dist/adapters/antigravity.js';
import {remainingTime} from '../dist/core/plan.js';
const command={file:process.execPath,args:[resolve('tests/fixtures/phase7-agent.mjs')]};
test('Antigravity preserves temporary service errors for retry classification',()=>{
 const stream=new AntigravityStream(()=>{});stream.feed(JSON.stringify({event:'result',result:{status:'ERROR',error:{message:'HTTP 429 rate limit'}}})+'\n');assert.equal(stream.failed,true);assert.equal(stream.failureReason,'HTTP 429 rate limit');
});
function setup(t,rounds=2){
 const root=mkdtempSync(join(tmpdir(),'rarp-phase8-'));
 git(root,'init');git(root,'config','user.name','Tests');git(root,'config','user.email','tests@localhost');
 writeFileSync(join(root,'.gitignore'),'.rarp/\n');for(const f of ['a.txt','b.txt'])writeFileSync(join(root,f),'base');git(root,'add','.');git(root,'commit','-m','base');
 const store=new Store(root,true);t.after(()=>{store.close();rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
 const {plan}=store.createGoal({title:'Recovery',requirements:'Both files done',acceptance:['Both files done']});
 const proposal={understood:'Both files',assumptions:[],questions:[],rationale:'Independent files',size:'small',confidence:'high',workers:[{workerRef:'W1',rationale:'a'},{workerRef:'W2',rationale:'b'}],maxWorkers:2,steps:['a','b'].map((f,i)=>({key:f,title:f,requirements:'Write done',deliverable:f+'.txt',dependencies:[],workerRef:'W'+(i+1),scope:[f+'.txt'],check:[process.execPath,'-e',`require('node:assert').equal(require('node:fs').readFileSync('${f}.txt','utf8'),'done')`],acceptance:['File is done']})),policy:{maxRounds:rounds,maxRetries:1,timeoutMs:10000,totalTimeoutMs:60000}};
 const snap=repositorySnapshot(root),draft=store.updatePlan(plan.id,0,proposal,snap.baseHead,snap.fingerprint);
 const approval={revision:1,contentHash:draft.contentHash,actor:'human',maxWorkers:2,maxReviewers:1,workers:proposal.workers.map(w=>({workerRef:w.workerRef,adapter:'codex',profile:'default'})),integration:'manual'};
 return {root,store,draft,proposal,approval};
}
async function until(fn){for(let i=0;i<400;i++){if(fn())return;await new Promise(r=>setTimeout(r,30));}throw new Error('Timed out');}
function settle(f,taskId,status){
 const task=f.store.show(taskId),ws=prepareWorkspace(f.root,taskId,[task.title+'.txt'],f.proposal.steps.find(s=>s.key===task.title).check);
 f.store.transition(taskId,'running',task.assigned_to,'fixture');writeFileSync(join(ws.path,task.title+'.txt'),'done');checkpoint(ws);f.store.saveWorkspace(ws);
 f.store.transition(taskId,'submitted',task.assigned_to,'fixture');f.store.transition(taskId,'reviewing',task.created_by,'fixture');f.store.transition(taskId,status,task.created_by,'Keep backend; fix frontend');
 for(const d of f.store.dispatches().filter(d=>d.taskId===taskId)){d.state='completed';f.store.saveDispatch(d);}
 f.store.saveUsage(taskId,{rounds:1,retries:0});return ws;
}
test('paused integration and approved revision retain accepted task, failed task identity and history',async t=>{
 const f=setup(t),runtime=await startRuntime(f.root,command,{manager:command});
 try{
 await runtimeRequest(f.root,'scheduler',{action:'pause'});await runtimeRequest(f.root,`plans/${f.draft.id}/approve`,f.approval);
 const links=f.store.planLinks(f.draft.id);settle(f,links[0].taskId,'accepted');settle(f,links[1].taskId,'changes_requested');
 f.store.planState(f.draft.id,'paused','Round limit','budget');
 await runtimeRequest(f.root,'integrate',{taskId:links[0].taskId});await runtimeRequest(f.root,'integrate',{taskId:links[0].taskId});
 const snap=repositorySnapshot(f.root),p=f.store.updatePlan(f.draft.id,1,{...f.proposal,policy:{...f.proposal.policy,maxRounds:3}},snap.baseHead,snap.fingerprint);
 await runtimeRequest(f.root,`plans/${p.id}/approve`,{...f.approval,revision:2,contentHash:p.contentHash,integration:'reviewed-local'});
 await runtimeRequest(f.root,'scheduler',{action:'resume'});await until(()=>f.store.plan(p.id).status!=='executing');
 assert.equal(f.store.plan(p.id).status,'completed',f.store.plan(p.id).note);assert.deepEqual(f.store.planLinks(p.id),links);assert.equal(f.store.list().length,2);
 assert.equal(f.store.show(links[0].taskId).attempts.length,1);assert.equal(f.store.show(links[1].taskId).attempts.length,2);
 }finally{await runtime.stop();}
});
test('revision retains accepted unintegrated work and rejects changing accepted requirements',t=>{
 const f=setup(t),snap=repositorySnapshot(f.root);f.store.approvePlan(f.draft.id,f.approval,snap.baseHead,snap.fingerprint);
 const links=f.store.planLinks(f.draft.id);settle(f,links[0].taskId,'accepted');f.store.planState(f.draft.id,'paused');
 const bad=structuredClone(f.proposal);bad.steps[0].requirements='Changed';assert.throws(()=>f.store.updatePlan(f.draft.id,1,bad,snap.baseHead,snap.fingerprint),/Accepted/);
 f.store.updatePlan(f.draft.id,1,f.proposal,snap.baseHead,snap.fingerprint);assert.deepEqual(f.store.planLinks(f.draft.id),links);assert.equal(f.store.workspace(links[0].taskId).integrated,null);
});
test('paused integration rejects repo drift and reviewed workspace tampering',async t=>{
 const f=setup(t),runtime=await startRuntime(f.root,command,{manager:command});
 try{await runtimeRequest(f.root,'scheduler',{action:'pause'});await runtimeRequest(f.root,`plans/${f.draft.id}/approve`,f.approval);
 const id=f.store.planLinks(f.draft.id)[0].taskId,ws=settle(f,id,'accepted');f.store.planState(f.draft.id,'paused');
 writeFileSync(join(f.root,'b.txt'),'changed');await assert.rejects(runtimeRequest(f.root,'integrate',{taskId:id}),/Repository stale/);writeFileSync(join(f.root,'b.txt'),'base');
 writeFileSync(join(ws.path,'a.txt'),'tampered');await assert.rejects(runtimeRequest(f.root,'integrate',{taskId:id}),/reviewed commit/);assert.equal(readFileSync(join(f.root,'a.txt'),'utf8'),'base');
 }finally{await runtime.stop();}
});
for(const mode of ['check-repair','review-repair','transient','denied','stuck'])test('durable bounded workflow: '+mode,async t=>{
 const f=setup(t,3),proposal=structuredClone(f.proposal);proposal.steps=proposal.steps.slice(0,1);proposal.workers=proposal.workers.slice(0,1);proposal.maxWorkers=1;
 if(['review-repair','stuck'].includes(mode))proposal.steps[0].check=[process.execPath,'-e','process.exit(0)'];
 const snap=repositorySnapshot(f.root),p=f.store.updatePlan(f.draft.id,1,proposal,snap.baseHead,snap.fingerprint);
 const state=join(f.root,'.rarp','fixture-count'),cmd={file:process.execPath,args:[resolve('tests/fixtures/phase8-agent.mjs'),mode,state]};
 let runtime=await startRuntime(f.root,cmd,{manager:cmd});
 try{
 await runtimeRequest(f.root,`plans/${p.id}/approve`,{...f.approval,revision:2,contentHash:p.contentHash,maxWorkers:1,workers:f.approval.workers.slice(0,1),integration:'reviewed-local'});
 await until(()=>f.store.plan(p.id).status!=='executing');
 const plan=f.store.plan(p.id),id=f.store.planLinks(p.id)[0].taskId,usage=f.store.taskUsage(id);
 assert.equal(plan.status,['denied','stuck'].includes(mode)?'paused':'completed',plan.note);
 if(mode==='denied'){assert.equal(plan.stopReason,'configuration');assert.equal(usage.retries,0);assert.equal(readFileSync(state,'utf8'),'1');}
 if(mode==='stuck'){assert.equal(plan.stopReason,'no-progress');assert.equal(usage.rounds,2);}
 if(mode==='transient'){assert.equal(usage.rounds,1);assert.equal(usage.retries,1);assert.equal(readFileSync(state,'utf8'),'2');}
 if(mode.endsWith('repair'))assert.equal(usage.rounds,2);
 await runtime.stop();runtime=await startRuntime(f.root,cmd,{manager:cmd});assert.deepEqual(f.store.taskUsage(id),usage);
 }finally{await runtime.stop();}
});
test('final verification repairs the owning task without rerunning accepted peers',async t=>{
 const f=setup(t,3),proposal=structuredClone(f.proposal);
 proposal.steps[1].dependencies=['a'];proposal.maxWorkers=1;
 proposal.steps[0].check=[process.execPath,'-e',"const fs=require('node:fs');require('node:assert').equal(fs.readFileSync('a.txt','utf8'),fs.readFileSync('b.txt','utf8')==='done'?'combined':'done')"];
 const snap=repositorySnapshot(f.root),p=f.store.updatePlan(f.draft.id,1,proposal,snap.baseHead,snap.fingerprint);
 const cmd={file:process.execPath,args:[resolve('tests/fixtures/phase8-agent.mjs'),'final-repair',join(f.root,'.rarp','fixture-count')]};
 const runtime=await startRuntime(f.root,cmd,{manager:cmd});
 try{await runtimeRequest(f.root,`plans/${p.id}/approve`,{...f.approval,revision:2,contentHash:p.contentHash,maxWorkers:1,integration:'reviewed-local'});
 await until(()=>f.store.plan(p.id).status!=='executing');assert.equal(f.store.plan(p.id).status,'completed',f.store.plan(p.id).note);
 const [a,b]=f.store.planLinks(p.id);assert.equal(f.store.show(a.taskId).attempts.length,2);assert.equal(f.store.show(b.taskId).attempts.length,1);
 assert.equal(readFileSync(join(f.root,'a.txt'),'utf8'),'combined');assert.equal(f.store.plan(p.id).execution.verification.passed,true);
 }finally{await runtime.stop();}
});
test('resume idempotency and exhausted budget survive runtime restart',async t=>{
 const f=setup(t,1),runtime=await startRuntime(f.root,command,{manager:command});
 try{await runtimeRequest(f.root,'scheduler',{action:'pause'});await runtimeRequest(f.root,`plans/${f.draft.id}/approve`,f.approval);
 const [a,b]=f.store.planLinks(f.draft.id);settle(f,a.taskId,'accepted');settle(f,b.taskId,'changes_requested');f.store.planState(f.draft.id,'paused','Budget','budget');
 await assert.rejects(runtimeRequest(f.root,`plans/${f.draft.id}/resume`,{}),/budget exhausted/);assert.equal(f.store.list().length,2);assert.equal(f.store.show(b.taskId).status,'changes_requested');
 const snap=repositorySnapshot(f.root),p=f.store.updatePlan(f.draft.id,1,{...f.proposal,policy:{...f.proposal.policy,maxRounds:2}},snap.baseHead,snap.fingerprint);
 await runtimeRequest(f.root,`plans/${p.id}/approve`,{...f.approval,revision:2,contentHash:p.contentHash});
 await runtimeRequest(f.root,`plans/${p.id}/pause`,{});await runtimeRequest(f.root,`plans/${p.id}/resume`,{});await runtimeRequest(f.root,`plans/${p.id}/resume`,{});
 assert.equal(f.store.dispatches().filter(d=>d.taskId===b.taskId&&d.state==='waiting').length,1);assert.equal(f.store.taskUsage(b.taskId).rounds,1);
 }finally{await runtime.stop();}
});
test('integration verification failure returns feedback for bounded repair',async t=>{
 const f=setup(t,3),proposal=structuredClone(f.proposal);proposal.steps=proposal.steps.slice(0,1);proposal.workers=proposal.workers.slice(0,1);proposal.maxWorkers=1;
 proposal.steps[0].check=[process.execPath,'-e',"const v=require('node:fs').readFileSync('a.txt','utf8');require('node:assert').ok(process.cwd().includes('integrations')?v==='combined':['done','combined'].includes(v))"];
 const snap=repositorySnapshot(f.root),p=f.store.updatePlan(f.draft.id,1,proposal,snap.baseHead,snap.fingerprint);
 const cmd={file:process.execPath,args:[resolve('tests/fixtures/phase8-agent.mjs'),'integration-repair',join(f.root,'.rarp','fixture-count')]},runtime=await startRuntime(f.root,cmd,{manager:cmd});
 try{await runtimeRequest(f.root,`plans/${p.id}/approve`,{...f.approval,revision:2,contentHash:p.contentHash,maxWorkers:1,workers:f.approval.workers.slice(0,1),integration:'reviewed-local'});
 await until(()=>f.store.plan(p.id).status!=='executing');assert.equal(f.store.plan(p.id).status,'completed',f.store.plan(p.id).note);
 const id=f.store.planLinks(p.id)[0].taskId;assert.equal(f.store.taskUsage(id).rounds,2);assert.equal(readFileSync(join(f.root,'a.txt'),'utf8'),'combined');
 }finally{await runtime.stop();}
});
test('human pause cancels work and preserves consumed time and rounds across restart',async t=>{
 const f=setup(t,3),state=join(f.root,'.rarp','fixture-count'),cmd={file:process.execPath,args:[resolve('tests/fixtures/phase8-agent.mjs'),'hang',state]};
 let runtime=await startRuntime(f.root,cmd,{manager:cmd},{maxWorkers:1});
 try{await runtimeRequest(f.root,`plans/${f.draft.id}/approve`,{...f.approval,maxWorkers:1});await until(()=>existsSync(state));
 await runtimeRequest(f.root,`plans/${f.draft.id}/pause`,{});assert.equal(runtime.status().workers.length,0);
 const p=f.store.plan(f.draft.id),id=f.store.planLinks(p.id)[0].taskId;assert.equal(p.stopReason,'human');assert.ok(p.execution.elapsedMs>0);assert.equal(p.execution.startedAt,undefined);assert.equal(f.store.taskUsage(id).rounds,1);
 await runtime.stop();runtime=await startRuntime(f.root,cmd,{manager:cmd},{maxWorkers:1});assert.equal(f.store.plan(p.id).execution.elapsedMs,p.execution.elapsedMs);assert.equal(f.store.taskUsage(id).rounds,1);
 await runtimeRequest(f.root,`plans/${p.id}/resume`,{});await until(()=>f.store.show(id).status==='accepted');assert.equal(f.store.taskUsage(id).rounds,2);
 }finally{await runtime.stop();}
});
test('plan time budget is cumulative; pause and reopening never replenish it',t=>{
 const f=setup(t),snap=repositorySnapshot(f.root);f.store.approvePlan(f.draft.id,f.approval,snap.baseHead,snap.fingerprint);
 const now=Date.now;let clock=100000;Date.now=()=>clock;
 try {
  assert.equal(f.store.startExecution(f.draft.id),160000);clock+=1000;f.store.planState(f.draft.id,'paused','Human pause','human');
  clock+=100000;const reopened=new Store(f.root);try{assert.equal(remainingTime(reopened.plan(f.draft.id)),59000);reopened.retryPlan(f.draft.id);assert.equal(reopened.startExecution(f.draft.id),clock+59000);clock+=59000;reopened.planState(f.draft.id,'paused','Budget','budget');assert.throws(()=>reopened.retryPlan(f.draft.id),/Time budget exhausted/);}finally{reopened.close();}
 }finally{Date.now=now;}
});
