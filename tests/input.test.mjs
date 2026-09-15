import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../dist/storage/store.js';
import { workerInputRequest, planStatusFor } from '../dist/core/plan.js';
import { planLabel, planActions, planEditable, planCanIntegrate } from '../dist/core/planview.js';
import { repositorySnapshot } from '../dist/runtime/planning.js';
import { startRuntime, runtimeRequest } from '../dist/runtime/server.js';
import { git } from '../dist/runtime/workspace.js';

test('input protocol accepts only a bounded explicit final response',()=>{
  assert.deepEqual(workerInputRequest('{"rarp_input":{"question":" Pick value "}}'),{question:'Pick value'});
  for(const text of ['Can you help?', 'not JSON', '{"question":"Pick value"}', 'null']) assert.equal(workerInputRequest(text),undefined);
  for(const question of ['', ' '.repeat(3), 'x'.repeat(12001)]) assert.throws(()=>workerInputRequest(JSON.stringify({rarp_input:{question}})));
  assert.throws(()=>workerInputRequest('{"rarp_input":{"question":"Q","permissions":"all"}}'));
  assert.equal(planStatusFor('input'),'waiting_input');
  assert.equal(planLabel('waiting_input'),'Chờ trả lời');
  assert.deepEqual(planActions('waiting_input'),['resume','cancel']);
  assert.equal(planEditable('waiting_input'),false);
  assert.equal(planCanIntegrate('waiting_input'),true);
});

test('durable answers are scoped, immutable, and do not replenish the execution budget',async t=>{
  const root=mkdtempSync(join(tmpdir(),'rarp-input-store-'));
  let store=new Store(root,true);
  t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
  const {plan}=store.createGoal({title:'Question',requirements:'Use input',acceptance:['Correct output']});
  const draft=store.updatePlan(plan.id,0,{understood:'Write a.txt',assumptions:[],questions:[],rationale:'One task',size:'small',confidence:'high',workers:[{workerRef:'W1',rationale:'One task'}],maxWorkers:1,
    steps:[{key:'first',title:'Write',requirements:'Use input',deliverable:'a.txt',dependencies:[],workerRef:'W1',scope:['a.txt'],check:['node','--version'],acceptance:['Correct output']}],policy:{maxRounds:2,maxRetries:0,timeoutMs:10000,totalTimeoutMs:30000}},'head','fingerprint');
  store.approvePlan(plan.id,{revision:1,contentHash:draft.contentHash,actor:'human',maxWorkers:1,maxReviewers:1,workers:[{workerRef:'W1',adapter:'codex',profile:'default'}],integration:'manual'},'head','fingerprint');
  const [{taskId}]=store.planLinks(plan.id);
  const worker=store.show(taskId).assigned_to;
  const running=store.transition(taskId,'running',worker,'fixture');
  const requestId=running.attempts.at(-1).id;
  store.saveUsage(taskId,{rounds:1,retries:0,input:{requestId,question:'Value?'},stopReason:'input'});
  store.transition(taskId,'blocked',worker,'Value?');
  for(const dispatch of store.dispatches())store.saveDispatch({...dispatch,state:'completed'});
  store.startExecution(plan.id);
  store.planState(plan.id,'paused','Value?','input');
  assert.equal(store.plan(plan.id).status,'waiting_input');
  assert.equal(store.plan(plan.id).execution.startedAt,undefined);
  assert.throws(()=>store.retryPlan(plan.id),/Answer pending/);
  assert.equal(store.show(taskId).status,'blocked');
  store.close();store=new Store(root);
  const body={taskId,requestId,answer:'done'};
  const runtime=await startRuntime(root,{file:process.execPath,args:[]});
  try {
    for(const invalid of [{...body,answer:' '},{...body,answer:'x'.repeat(12001)},{...body,permissions:'all'},{...body,requestId:'stale'}])
      await assert.rejects(runtimeRequest(root,`plans/${plan.id}/answer`,invalid));
    const saved=await runtimeRequest(root,`plans/${plan.id}/answer`,body);
    assert.equal(saved.status,'waiting_input');
    assert.equal(saved.tasks[0].usage.input.answer,'done');
  } finally { await runtime.stop(); }
  assert.throws(()=>store.answerPlanInput(plan.id,{...body,taskId:'other'}),/Stale/);
  assert.throws(()=>store.answerPlanInput(plan.id,{...body,requestId:'old'}),/Stale/);
  store.answerPlanInput(plan.id,body);store.answerPlanInput(plan.id,body);
  assert.throws(()=>store.answerPlanInput(plan.id,{...body,answer:'changed'}),/already answered/);
  assert.equal(store.plan(plan.id).status,'waiting_input');
  assert.equal(store.taskUsage(taskId).rounds,1);
  assert.deepEqual(store.taskUsage(taskId).input,{requestId,question:'Value?',answer:'done'});
  store.saveUsage(taskId,{rounds:2});
  assert.throws(()=>store.retryPlan(plan.id),/Round budget exhausted/);
  assert.equal(store.plan(plan.id).status,'waiting_input');
  store.saveUsage(taskId,{rounds:1});
  store.retryPlan(plan.id);
  assert.equal(store.plan(plan.id).status,'executing');
  assert.equal(store.show(taskId).status,'queued');
  assert.equal(store.taskUsage(taskId).rounds,1);
  assert.throws(()=>store.answerPlanInput(plan.id,body),/Stale/);
  // A later attempt can block for another reason while old input remains in usage.
  store.transition(taskId,'running',worker,'Another attempt');
  store.transition(taskId,'blocked',worker,'Other blocker');
  store.planState(plan.id,'paused','Other blocker','worker');
  assert.throws(()=>store.answerPlanInput(plan.id,body),/Stale/);
});

async function waitFor(store,id,status) {
  for(let i=0;i<400;i++) {
    const p=store.plan(id);
    if(p.status===status)return p;
    if(p.status!=='executing')assert.fail(`Expected ${status}: ${p.status}: ${p.note}`);
    await delay(50);
  }
  assert.fail('Plan timed out');
}

test('input wait survives restart, rejects stale answers and resumes to verified integration',async(t)=>{
  const root=mkdtempSync(join(tmpdir(),'rarp-input-'));
  git(root,'init');git(root,'config','user.name','Tests');git(root,'config','user.email','tests@localhost');
  writeFileSync(join(root,'.gitignore'),'.rarp/\n');writeFileSync(join(root,'a.txt'),'base');
  git(root,'add','.');git(root,'commit','-m','base');
  let store=new Store(root,true),runtime;
  t.after(async()=>{await runtime?.stop();store.close();rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
  const command={file:process.execPath,args:[resolve('tests/fixtures/input-agent.mjs')]};
  const proposal={understood:'Write a.txt',assumptions:[],questions:[],rationale:'One scoped task',size:'small',confidence:'high',workers:[{workerRef:'W1',rationale:'One task'}],maxWorkers:1,
    steps:[{key:'first',title:'Write a.txt',requirements:'Ask user for the value then write a.txt',deliverable:'a.txt',dependencies:[],workerRef:'W1',scope:['a.txt'],check:[process.execPath,'-e',"require('node:assert').equal(require('node:fs').readFileSync('a.txt','utf8'),'done')"],acceptance:['a.txt contains done']}],
    policy:{maxRounds:2,maxRetries:0,timeoutMs:10000,totalTimeoutMs:30000}};
  const {plan}=store.createGoal({title:'Input test',requirements:'Get the value',acceptance:['a.txt correct']});
  const snap=repositorySnapshot(root), draft=store.updatePlan(plan.id,0,proposal,snap.baseHead,snap.fingerprint);
  const approval={revision:1,contentHash:draft.contentHash,actor:'human',maxWorkers:1,maxReviewers:1,workers:[{workerRef:'W1',adapter:'codex',profile:'default'}],integration:'reviewed-local'};
  runtime=await startRuntime(root,command,{manager:command});
  await runtimeRequest(root,`plans/${plan.id}/approve`,approval);
  const waiting=await waitFor(store,plan.id,'waiting_input');
  const [{taskId}]=store.planLinks(plan.id), request=waiting.execution.tasks[taskId].input;
  assert.equal(store.show(taskId).status,'blocked');
  assert.equal(waiting.execution.tasks[taskId].rounds,1);
  assert.equal(waiting.execution.tasks[taskId].retries,0);
  assert.equal(waiting.execution.startedAt,undefined);
  assert.equal(store.show(taskId).reviews.length,0);
  const workspace=store.workspace(taskId);
  assert.equal(readFileSync(join(workspace.path,'a.txt'),'utf8'),'partial');
  assert.equal(git(root,'status','--porcelain'),'');
  await assert.rejects(runtimeRequest(root,`plans/${plan.id}/resume`,{}),/Answer pending/);
  await runtime.stop();runtime=undefined;store.close();store=new Store(root);
  assert.deepEqual(store.taskUsage(taskId).input,request);
  runtime=await startRuntime(root,command,{manager:command});
  const body={taskId,requestId:request.requestId,answer:'done'};
  for(const invalid of [{...body,taskId:'unknown'},{...body,requestId:'stale'},{...body,answer:' '},{...body,answer:'x'.repeat(12001)},{...body,permissions:'all'}])
    await assert.rejects(runtimeRequest(root,`plans/${plan.id}/answer`,invalid));
  await runtimeRequest(root,`plans/${plan.id}/answer`,body);
  await runtimeRequest(root,`plans/${plan.id}/answer`,body);
  await assert.rejects(runtimeRequest(root,`plans/${plan.id}/answer`,{...body,answer:'different'}),/already answered/);
  assert.equal(store.plan(plan.id).status,'waiting_input');
  // A response cannot bypass the repository gate.
  writeFileSync(join(root,'a.txt'),'drift');
  await assert.rejects(runtimeRequest(root,`plans/${plan.id}/resume`,{}),/Repository stale/);
  writeFileSync(join(root,'a.txt'),'base');
  await runtimeRequest(root,'scheduler',{action:'resume'});
  await runtimeRequest(root,`plans/${plan.id}/resume`,{});
  const finished=await waitFor(store,plan.id,'completed');
  assert.equal(finished.execution.tasks[taskId].rounds,2);
  assert.equal(finished.execution.tasks[taskId].input.answer,'done');
  assert.equal(finished.execution.verification.passed,true);
  assert.ok(store.workspace(taskId).integrated);
  assert.equal(readFileSync(join(root,'a.txt'),'utf8'),'done');
  assert.equal(git(root,'status','--porcelain'),'');
  await assert.rejects(runtimeRequest(root,`plans/${plan.id}/answer`,body),/Stale/);
});
