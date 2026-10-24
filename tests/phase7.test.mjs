import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {Store} from '../dist/storage/store.js';
import {validateProposal,waves} from '../dist/core/plan.js';
import {repositorySnapshot,createPlanning,profileCommand} from '../dist/runtime/planning.js';
import {startRuntime,runtimeRequest} from '../dist/runtime/server.js';
import {git} from '../dist/runtime/workspace.js';
const proposal=()=>({understood:'Change scoped files',assumptions:[],questions:[],rationale:'One worker suffices',size:'small',confidence:'high',workers:[{workerRef:'W1',rationale:'Sequential scoped changes'}],maxWorkers:1,steps:[{key:'first',title:'Write first',requirements:'Write a',deliverable:'a.txt',dependencies:[],workerRef:'W1',scope:['a.txt'],check:[process.execPath,'-e','process.exit(0)'],acceptance:['File contains done']},{key:'second',title:'Write second',requirements:'Write b',deliverable:'b.txt',dependencies:['first'],workerRef:'W1',scope:['b.txt'],check:[process.execPath,'-e','process.exit(0)'],acceptance:['File contains done']}],policy:{maxRounds:1,timeoutMs:10000,totalTimeoutMs:20000}});
function setup(t){const root=join(tmpdir(),'rarp-phase7-fixture-'+randomUUID());mkdirSync(root);git(root,'init');git(root,'config','user.name','Tests');git(root,'config','user.email','tests@localhost');writeFileSync(join(root,'.gitignore'),'.rarp/\n');writeFileSync(join(root,'a.txt'),'base');writeFileSync(join(root,'b.txt'),'base');git(root,'add','.');git(root,'commit','-m','base'); const store=new Store(root,true);t.after(()=>{store.close();rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});});const {plan}=store.createGoal({title:'Goal',requirements:'Scoped changes',acceptance:['All files correct']});const snap=repositorySnapshot(root);const draft=store.updatePlan(plan.id,0,proposal(),snap.baseHead,snap.fingerprint);const approval={revision:1,contentHash:draft.contentHash,actor:'human',maxWorkers:1,maxReviewers:1,workers:[{workerRef:'W1',adapter:'codex',profile:'default'}],integration:'manual'};return {root,store,draft,approval,snap};}
test('plan DAG, scopes, worker ownership, argv and clarification validation',()=>{assert.deepEqual(waves(validateProposal(proposal())),[['first'],['second']]);for(const path of ['../a','.git/config','x/.rarp/state','C:/x','a\\b','/root','a//b']){const p=proposal();p.steps[0].scope=[path];assert.throws(()=>validateProposal(p));}let p=proposal();p.steps[0].dependencies=['second'];assert.throws(()=>validateProposal(p),/cycle/);p=proposal();p.steps[1].scope=['a.txt'];p.steps[1].dependencies=[];assert.throws(()=>validateProposal(p),/Overlapping/);p=proposal();p.steps[0].workerRef='missing';assert.throws(()=>validateProposal(p),/workerRef/);p=proposal();p.steps[0].check=['codex','--dangerously-bypass-approvals-and-sandbox'];assert.throws(()=>validateProposal(p));});
test('v4 atomic materialization, exact approval, duplicate/restart idempotency',t=>{const f=setup(t);assert.throws(()=>f.store.approvePlan(f.draft.id,{...f.approval,revision:2},f.snap.baseHead,f.snap.fingerprint),/Stale/);assert.throws(()=>f.store.approvePlan(f.draft.id,f.approval,'changed',f.snap.fingerprint),/stale/);f.store.approvePlan(f.draft.id,f.approval,f.snap.baseHead,f.snap.fingerprint);f.store.approvePlan(f.draft.id,f.approval,f.snap.baseHead,f.snap.fingerprint);assert.equal(f.store.list().length,2);assert.equal(f.store.dispatches().length,2);assert.equal(f.store.list().every(t=>f.store.show(t.id).attempts.length===0),true);const reopened=new Store(f.root);assert.equal(reopened.planLinks(f.draft.id).length,2);assert.equal(reopened.plan(f.draft.id).status,'executing');reopened.close();});
test('materialization crash rollback leaves no partial task, approval or worker',t=>{const f=setup(t);const db=new DatabaseSync(join(f.root,'.rarp','state.db'));db.exec("CREATE TRIGGER crash BEFORE INSERT ON plan_task_links BEGIN SELECT RAISE(ABORT,'injected crash'); END");assert.throws(()=>f.store.approvePlan(f.draft.id,f.approval,f.snap.baseHead,f.snap.fingerprint),/injected crash/);assert.equal(f.store.list().length,0);assert.equal(f.store.plan(f.draft.id).status,'awaiting_approval');assert.equal(db.prepare('SELECT count(*) AS n FROM plan_approvals').get().n,0);db.exec('DROP TRIGGER crash');db.close();f.store.approvePlan(f.draft.id,f.approval,f.snap.baseHead,f.snap.fingerprint);assert.equal(f.store.list().length,2);});
test('revision invalidates hash, clarification blocks approval; planner logs separate',t=>{const f=setup(t);const p=proposal();p.questions=['Which output?'];const updated=f.store.updatePlan(f.draft.id,1,p,f.snap.baseHead,f.snap.fingerprint);assert.equal(updated.status,'needs_clarification');assert.throws(()=>f.store.approvePlan(updated.id,f.approval,f.snap.baseHead,f.snap.fingerprint),/Stale/);assert.throws(()=>f.store.approvePlan(updated.id,{...f.approval,revision:2,contentHash:updated.contentHash},f.snap.baseHead,f.snap.fingerprint),/awaiting/);f.store.plannerLog(updated.id,{type:'fixture'});assert.equal(f.store.planLogs(updated.id).length,1);assert.equal(f.store.list().length,0);});
test('HTTP observer surfaces, read-only fixture planning, missing binding, scoped cancellation and restart drafts',async t=>{const f=setup(t);const command={file:process.execPath,args:[resolve('tests/fixtures/phase7-agent.mjs')]};const runtime=await startRuntime(f.root,command,{planner:command},{maxWorkers:2});try{const listing=await runtimeRequest(f.root,'goals');assert.equal(listing.goals.length,1);const analyzed=await runtimeRequest(f.root,'plans/'+f.draft.id+'/analyze',{clarification:'fixture'});assert.equal(analyzed.revision,2);assert.equal(analyzed.status,'awaiting_approval');assert.equal(f.store.list().length,0);assert.ok(analyzed.logs.length);await assert.rejects(runtimeRequest(f.root,'plans/'+f.draft.id+'/approve',{...f.approval,revision:2,contentHash:analyzed.contentHash,workers:[{workerRef:'W1',adapter:'antigravity',profile:'default'}]}),/not configured/);await runtimeRequest(f.root,'scheduler',{action:'pause'});await runtimeRequest(f.root,'plans/'+f.draft.id+'/approve',{...f.approval,revision:2,contentHash:analyzed.contentHash});await runtimeRequest(f.root,'plans/'+f.draft.id+'/cancel',{});assert.equal(f.store.plan(f.draft.id).status,'cancelled');assert.ok(f.store.dispatches().every(d=>d.state==='cancelled'));assert.ok(f.store.list().every(t=>f.store.show(t.id).attempts.length===0));}finally{await runtime.stop();}});

test('fixture end-to-end reviewed-local execution integrates accepted scoped work',async t=>{
 const f=setup(t), command={file:process.execPath,args:[resolve('tests/fixtures/phase7-agent.mjs')]};
 const p=proposal();p.steps=p.steps.slice(0,1);
 const snap=repositorySnapshot(f.root), draft=f.store.updatePlan(f.draft.id,1,p,snap.baseHead,snap.fingerprint);
 const runtime=await startRuntime(f.root,command,{manager:command},{maxWorkers:2});
 try {
 await runtimeRequest(f.root,'plans/'+draft.id+'/approve',{...f.approval,revision:2,contentHash:draft.contentHash,integration:'reviewed-local'});
 for(let i=0;i<300 && f.store.plan(draft.id).status==='executing';i++) await new Promise(r=>setTimeout(r,50));
 assert.equal(f.store.plan(draft.id).status,'completed',f.store.plan(draft.id).note);
 const links=f.store.planLinks(draft.id);assert.equal(links.length,1);assert.equal(f.store.show(links[0].taskId).attempts.length,1);assert.ok(f.store.workspace(links[0].taskId).integrated);
 }finally{await runtime.stop();}
});

test('restart preserves unapproved draft; repository/profile changes pause before dispatch',async t=>{
 const f=setup(t), command={file:process.execPath,args:[resolve('tests/fixtures/phase7-agent.mjs')]};
 let runtime=await startRuntime(f.root,command,{manager:command});await runtime.stop();
 assert.equal(f.store.plan(f.draft.id).status,'awaiting_approval');assert.equal(f.store.list().length,0);
 runtime=await startRuntime(f.root,command,{manager:command});
 try{await runtimeRequest(f.root,'scheduler',{action:'pause'});await runtimeRequest(f.root,'plans/'+f.draft.id+'/approve',f.approval);writeFileSync(join(f.root,'a.txt'),'external change');await runtimeRequest(f.root,'scheduler',{action:'resume'});await new Promise(r=>setTimeout(r,350));assert.equal(f.store.plan(f.draft.id).status,'paused');assert.ok(f.store.list().every(t=>f.store.show(t.id).attempts.length===0));}finally{await runtime.stop();}
});
test('cancel one execution leaves unrelated queued work untouched',async t=>{
 const f=setup(t), command={file:process.execPath,args:[resolve('tests/fixtures/phase7-agent.mjs')]};
 f.store.register('other-manager','manager');f.store.register('other-worker','worker');const unrelated=f.store.create({title:'Unrelated',body:'unrelated',actor:'other-manager',assignee:'other-worker'});
 const runtime=await startRuntime(f.root,command,{manager:command});
 try{await runtimeRequest(f.root,'scheduler',{action:'pause'});await runtimeRequest(f.root,'workflow',{taskId:unrelated.id,enqueue:true,requestKey:'unrelated'});await runtimeRequest(f.root,'plans/'+f.draft.id+'/approve',f.approval);await runtimeRequest(f.root,'plans/'+f.draft.id+'/cancel',{});assert.equal(f.store.dispatch('unrelated').state,'waiting');assert.equal(f.store.show(unrelated.id).status,'queued');}finally{await runtime.stop();}
});
test('replan preserves integrated work, invalidates bindings and never reuses old dispatch keys',async t=>{
 const f=setup(t);f.store.approvePlan(f.draft.id,f.approval,f.snap.baseHead,f.snap.fingerprint);const old=f.store.planLinks(f.draft.id);f.store.planState(f.draft.id,'paused');const changed=proposal();changed.steps[1].requirements='Revised b';const p=f.store.updatePlan(f.draft.id,1,changed,f.snap.baseHead,f.snap.fingerprint);assert.equal(p.revision,2);assert.equal(p.approval,undefined);assert.ok(f.store.dispatches().every(d=>d.state==='cancelled'));f.store.approvePlan(p.id,{...f.approval,revision:2,contentHash:p.contentHash},f.snap.baseHead,f.snap.fingerprint);assert.equal(f.store.planLinks(p.id).length,2);assert.ok(f.store.planLinks(p.id).every(l=>!old.some(o=>o.taskId===l.taskId)));assert.equal(f.store.dispatches().length,4);
});

test('dependency waits for reviewed-local integration; one execution slot stays bounded',async t=>{
 const f=setup(t), command={file:process.execPath,args:[resolve('tests/fixtures/phase7-agent.mjs')]};const runtime=await startRuntime(f.root,command,{manager:command},{maxWorkers:4});
 try{await runtimeRequest(f.root,'plans/'+f.draft.id+'/approve',{...f.approval,integration:'reviewed-local'});for(let i=0;i<400 && f.store.plan(f.draft.id).status==='executing';i++){assert.ok(runtime.status().workers.length<=1);const links=f.store.planLinks(f.draft.id), first=f.store.show(links[0].taskId), second=f.store.show(links[1].taskId);if(second.attempts.length)assert.ok(f.store.workspace(first.id).integrated);await new Promise(r=>setTimeout(r,30));}assert.equal(f.store.plan(f.draft.id).status,'completed',f.store.plan(f.draft.id).note);assert.equal(f.store.planLinks(f.draft.id).every(l=>f.store.show(l.taskId).attempts.length===1),true);}finally{await runtime.stop();}
});

test('mixed CLI bindings run their selected protocols and integrate both outputs',async t=>{
 const f=setup(t), command={file:process.execPath,args:[resolve('tests/fixtures/phase7-agent.mjs')]};
 const p=proposal();p.workers.push({workerRef:'W2',rationale:'Independent file'});p.maxWorkers=2;p.steps[1].dependencies=[];p.steps[1].workerRef='W2';
 const draft=f.store.updatePlan(f.draft.id,1,p,f.snap.baseHead,f.snap.fingerprint);
 const runtime=await startRuntime(f.root,command,{manager:command,profiles:{'antigravity:fixture':{adapter:'antigravity',authenticated:true,model:'fixture',command:{file:process.execPath,args:[resolve('tests/fixtures/phase7-agent.mjs'),'--antigravity'],protocol:'antigravity',promptArgument:true}}}},{maxWorkers:2});
 try {
  assert.equal(f.store.list().length,0);
  await runtimeRequest(f.root,'plans/'+draft.id+'/approve',{...f.approval,revision:2,contentHash:draft.contentHash,maxWorkers:2,integration:'reviewed-local',workers:[{workerRef:'W1',adapter:'codex',profile:'default'},{workerRef:'W2',adapter:'antigravity',profile:'fixture'}]});
  for(let i=0;i<600 && f.store.plan(draft.id).status==='executing';i++)await new Promise(r=>setTimeout(r,30));
  assert.equal(f.store.plan(draft.id).status,'completed',f.store.plan(draft.id).note);
  assert.deepEqual(f.store.dispatches().map(d=>d.input.adapter).sort(),['antigravity','codex']);
  assert.ok(f.store.planLinks(draft.id).every(l=>f.store.workspace(l.taskId).integrated && f.store.show(l.taskId).attempts.length===1));
 }finally{await runtime.stop();}
});

test('dispatch configuration failure pauses the execution instead of leaving queued work stuck',async t=>{
 const f=setup(t), command={file:process.execPath,args:[resolve('tests/fixtures/phase7-agent.mjs')]};
 const profiles={'codex:custom':{adapter:'codex',authenticated:true,model:'fixture',command}};
 const runtime=await startRuntime(f.root,command,{manager:command,profiles});
 try {
  await runtimeRequest(f.root,'scheduler',{action:'pause'});
  await runtimeRequest(f.root,'plans/'+f.draft.id+'/approve',{...f.approval,workers:[{workerRef:'W1',adapter:'codex',profile:'custom'}]});
  delete profiles['codex:custom'];
  await runtimeRequest(f.root,'scheduler',{action:'resume'});
  assert.equal(f.store.plan(f.draft.id).status,'paused');
  assert.match(f.store.plan(f.draft.id).note,/Unknown profile/);
  assert.ok(f.store.list().every(t=>f.store.show(t.id).attempts.length===0));
 }finally{await runtime.stop();}
});


test('Antigravity model option precedes the print prompt flag',()=>{
 const command={file:'agy',args:['--sandbox','--output-format','stream-json','--print'],protocol:'antigravity',promptArgument:true};
 const selected=profileCommand({profiles:{'antigravity:live':{adapter:'antigravity',authenticated:true,model:'gemini-3.8-flash-medium',command}}},command,'antigravity','live');
 assert.deepEqual(selected.args,['--sandbox','--output-format','stream-json','--model','gemini-3.8-flash-medium','--print']);
 assert.deepEqual(command.args,['--sandbox','--output-format','stream-json','--print']);
});

test('approval rejects a dirty checkout even when its analyzed fingerprint matches',async t=>{
 const f=setup(t), command={file:process.execPath,args:[resolve('tests/fixtures/phase7-agent.mjs')]};
 writeFileSync(join(f.root,'a.txt'),'uncommitted work');
 const snap=repositorySnapshot(f.root), draft=f.store.updatePlan(f.draft.id,1,proposal(),snap.baseHead,snap.fingerprint);
 const runtime=await startRuntime(f.root,command,{manager:command});
 try {
  await assert.rejects(runtimeRequest(f.root,'plans/'+draft.id+'/approve',{...f.approval,revision:2,contentHash:draft.contentHash}),/checkout must be clean/);
  assert.equal(f.store.list().length,0);
  assert.equal(f.store.dispatches().length,0);
  assert.equal(f.store.plan(draft.id).status,'awaiting_approval');
 }finally{await runtime.stop();}
});
