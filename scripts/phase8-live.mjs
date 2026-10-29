import {mkdtempSync,writeFileSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import assert from 'node:assert/strict';
import {Store} from '../dist/storage/store.js';
import {startRuntime,runtimeRequest} from '../dist/runtime/server.js';
import {repositorySnapshot} from '../dist/runtime/planning.js';
import {git} from '../dist/runtime/workspace.js';
import {antigravityCommand} from '../dist/adapters/antigravity.js';
import {codexReviewCommand} from '../dist/adapters/codex.js';

const root=mkdtempSync(join(tmpdir(),'rarp-phase8-live-')),files=['backend.txt','frontend.txt'];
const skipAgPermissions=process.argv.includes('--ag-test-skip-permissions');
console.log(JSON.stringify({stage:'start',root,manager:'9router',workers:2,skipAgPermissions}));
git(root,'init');git(root,'config','core.autocrlf','false');git(root,'config','user.name','Rarp smoke');git(root,'config','user.email','smoke@localhost');
writeFileSync(join(root,'.gitignore'),'.rarp/\n');for(const file of files)writeFileSync(join(root,file),'before\n');git(root,'add','.');git(root,'commit','-m','Phase 8 fixture');
const store=new Store(root,true),{plan}=store.createGoal({title:'Phase 8 live',requirements:'Both files contain after followed by newline',acceptance:files.map(f=>f+' is after followed by newline'),maxWorkers:2});
const proposal={understood:'Two independent scoped file updates',assumptions:[],questions:[],rationale:'Verify two Antigravity workers with manager profile 9router',size:'small',confidence:'high',workers:files.map((f,i)=>({workerRef:'W'+i,rationale:f})),maxWorkers:2,steps:files.map((f,i)=>({key:'file'+i,title:'Update '+f,requirements:'Change '+f+' to exactly after followed by a newline. No other changes.',deliverable:f,dependencies:[],workerRef:'W'+i,scope:[f],check:[process.execPath,'-e',`require('node:assert/strict').deepEqual(require('node:fs').readFileSync('${f}'),Buffer.from([97,102,116,101,114,10]))`],acceptance:['File bytes are [97,102,116,101,114,10]']})),policy:{maxRounds:3,maxRetries:2,timeoutMs:120000,totalTimeoutMs:360000}};
const snap=repositorySnapshot(root),draft=store.updatePlan(plan.id,0,proposal,snap.baseHead,snap.fingerprint);store.close();
const ag=antigravityCommand();ag.args.splice(ag.args.indexOf('--print'),0,'--mode','auto');
if(skipAgPermissions)ag.args.splice(ag.args.indexOf('--print'),0,'--dangerously-skip-permissions');
let runtime;
try {
 runtime=await startRuntime(root,undefined,{manager:codexReviewCommand('codex','9router'),profiles:{'antigravity:live':{adapter:'antigravity',authenticated:true,model:'gemini-3.8-flash-medium',command:ag}}},{maxWorkers:2,maxReviewers:1});
 await runtimeRequest(root,`plans/${draft.id}/approve`,{revision:draft.revision,contentHash:draft.contentHash,actor:'human',maxWorkers:2,maxReviewers:1,workers:proposal.workers.map(w=>({workerRef:w.workerRef,adapter:'antigravity',profile:'live'})),integration:'reviewed-local',budget:proposal.policy});
 for(let i=0;i<1500;i++) {
  await new Promise(r=>setTimeout(r,250));const detail=await runtimeRequest(root,`plans/${draft.id}`);
  if(detail.status!=='executing') {
   const report={root,manager:'9router',workers:2,skipAgPermissions,status:detail.status,reason:detail.stopReason,note:detail.note,execution:detail.execution,tasks:detail.tasks,head:git(root,'rev-parse','HEAD')};
   writeFileSync(join(root,'.rarp','phase8-result.json'),JSON.stringify(report,null,2)+'\n');
   console.log(JSON.stringify({stage:'result',root,status:report.status,reason:report.reason,note:report.note}));
   assert.equal(detail.status,'completed',detail.note);assert.equal(detail.execution.verification.passed,true);
   for(const file of files)assert.equal(readFileSync(join(root,file),'utf8'),'after\n');assert.equal(git(root,'status','--porcelain'),'');break;
  }
  if(i===1499)throw new Error('Live smoke deadline');
 }
} finally {await runtime?.stop();console.log(JSON.stringify({stage:'stopped',root}));}
