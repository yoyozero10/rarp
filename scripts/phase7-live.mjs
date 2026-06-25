import {mkdtempSync,writeFileSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import assert from 'node:assert/strict';
import {Store} from '../dist/storage/store.js';
import {startRuntime,runtimeRequest} from '../dist/runtime/server.js';
import {git} from '../dist/runtime/workspace.js';
import {antigravityCommand} from '../dist/adapters/antigravity.js';
const mixed=process.argv.includes('--mixed');
const skipAgPermissions=process.argv.includes('--ag-test-skip-permissions');
assert.ok(!skipAgPermissions||mixed,'Temporary Antigravity permission override requires --mixed');
const root=mkdtempSync(join(tmpdir(),'rarp-phase7-live-'));
const files=mixed?['value.txt','other.txt']:['value.txt'];
const startedAt=new Date().toISOString();
console.log(JSON.stringify({stage:'start',root,mixed,skipAgPermissions}));
let runtime;
try {
 git(root,'init');git(root,'config','core.autocrlf','false');git(root,'config','user.name','Rarp smoke');git(root,'config','user.email','smoke@localhost');
 writeFileSync(join(root,'.gitignore'),'.rarp/\n');for(const file of files)writeFileSync(join(root,file),'before\n');git(root,'add','.');git(root,'commit','-m','smoke base');
 const store=new Store(root,true);store.close();
 const ag=antigravityCommand();
 ag.args.splice(ag.args.indexOf('--print'),0,'--mode','auto');
 if(skipAgPermissions)ag.args.splice(ag.args.indexOf('--print'),0,'--dangerously-skip-permissions');
 runtime=await startRuntime(root,undefined,mixed?{profiles:{'antigravity:live':{adapter:'antigravity',authenticated:true,model:'gemini-3.8-flash-medium',command:ag}}}:{});
 const {plan}=await runtimeRequest(root,'goals',{title:'Update scoped values',requirements:`Change ${files.join(' and ')} to exactly after followed by newline. No other files. ${mixed?'For this mixed CLI acceptance test, use exactly two independent tasks and two distinct workers, one file per worker, two concurrent slots.':'One task and one worker.'} Verification must use node -e and deepEqual the file Buffer against Buffer.from([97,102,116,101,114,10]); use numeric bytes to avoid newline escaping ambiguity.`,acceptance:files.map(f=>f+' is exactly after followed by newline'),maxWorkers:files.length});
 const analyzed=await runtimeRequest(root,'plans/'+plan.id+'/analyze',{});
 console.log(JSON.stringify({stage:'analyzed',status:analyzed.status,revision:analyzed.revision,proposal:analyzed.proposal}));
 assert.equal(analyzed.status,'awaiting_approval');
 assert.equal(analyzed.proposal.workers.length,files.length);
 const before=new Store(root);assert.equal(before.list().length,0);before.close();
 const workers=analyzed.proposal.workers.map((w,i)=>({workerRef:w.workerRef,adapter:mixed&&i===1?'antigravity':'codex',profile:mixed&&i===1?'live':'default'}));
 await runtimeRequest(root,'plans/'+plan.id+'/approve',{revision:analyzed.revision,contentHash:analyzed.contentHash,actor:'human',maxWorkers:files.length,maxReviewers:1,workers,integration:'reviewed-local'});
 for(let i=0;i<1200;i++){await new Promise(r=>setTimeout(r,250));const p=await runtimeRequest(root,'plans/'+plan.id);if(p.status!=='executing'){
  console.log(JSON.stringify({stage:'execution',status:p.status,note:p.note,tasks:p.tasks}));
  const report={startedAt,finishedAt:new Date().toISOString(),mixed,skipAgPermissions,root,workers,status:p.status,note:p.note,tasks:p.tasks,head:git(root,'rev-parse','HEAD')};
  writeFileSync(join(root,'.rarp','phase7-result.json'),JSON.stringify(report,null,2)+'\n');
  assert.equal(p.status,'completed');for(const file of files)assert.equal(readFileSync(join(root,file),'utf8'),'after\n');assert.equal(git(root,'status','--porcelain'),'');break;
 }if(i===1199)throw new Error('Live execution deadline');}
} finally {if(runtime) await runtime.stop();console.log(JSON.stringify({stage:'stopped',root}));}
