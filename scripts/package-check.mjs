// Install the actual tarball outside the checkout; no model requests or credentials.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {pathToFileURL} from 'node:url';

const npm=process.env.npm_execpath;
assert.ok(npm,'Run with npm run test:package');
const scratch=mkdtempSync(join(tmpdir(),'rarp-package-')),source=resolve(import.meta.dirname,'..');
const version=JSON.parse(readFileSync(join(source,'package.json'),'utf8')).version;
const run=(file,args,cwd=source)=>execFileSync(file,args,{cwd,encoding:'utf8',windowsHide:true,timeout:120000,maxBuffer:4*1024*1024});
const npmRun=(args,cwd=source)=>run(process.execPath,[npm,...args],cwd);
let runtime;
try{
 const [pack]=JSON.parse(npmRun(['pack','--ignore-scripts','--json','--pack-destination',scratch]));
 assert.ok(pack.files.some(f=>f.path==='dist/ui/index.html'));
 for(const f of pack.files)assert.ok(['package.json','README.md'].includes(f.path)||/^dist\/.*\.js$/.test(f.path)||/^dist\/ui\//.test(f.path)||/^schemas\/[^/]+\.json$/.test(f.path)||/^docs\/[^/]+\.md$/.test(f.path),'Unexpected packaged file: '+f.path);
 const install=join(scratch,'install');mkdirSync(install);
 npmRun(['install','--prefix',install,'--omit=dev','--ignore-scripts','--no-audit','--no-fund','--package-lock=false',join(scratch,pack.filename)]);
 assert.equal(npmRun(['exec','--offline','--','rarp','--version'],install).trim(),version);
 const installed=join(install,'node_modules','rarp');
 assert.equal(readdirSync(join(install,'node_modules')).includes('typescript'),false);
 const load=path=>import(pathToFileURL(join(installed,path)).href);
 const {startRuntime,runtimeRequest}=await load('dist/runtime/server.js');
 const {git}=await load('dist/runtime/workspace.js');
 const {codexReviewCommand}=await load('dist/adapters/codex.js');
 const schema=codexReviewCommand().args;assert.equal(JSON.parse(readFileSync(schema[schema.indexOf('--output-schema')+1],'utf8')).type,'object');
 const project=join(scratch,'project');mkdirSync(project);git(project,'init');git(project,'config','user.name','Package test');git(project,'config','user.email','test@localhost');
 writeFileSync(join(project,'.gitignore'),'.rarp/\n');writeFileSync(join(project,'a.txt'),'base');git(project,'add','.');git(project,'commit','-m','Fixture');
 const cli=join(installed,'dist','cli','index.js');run(process.execPath,[cli,'--project',project,'init']);
 const report=JSON.parse(run(process.execPath,[cli,'--project',project,'--json','doctor','--codex',process.execPath,'--agy','rarp-missing-agy-executable']));assert.equal(report.ok,true);
 const command={file:process.execPath,args:[join(source,'tests','fixtures','phase7-agent.mjs')]};
 runtime=await startRuntime(project,command,{planner:command,manager:command});
 const meta=JSON.parse(readFileSync(join(project,'.rarp','runtime.json'),'utf8')),base='http://127.0.0.1:'+meta.port;
 const response=await fetch(base+'/ui/');assert.equal(response.status,200);const html=await response.text();
 const assets=[...html.matchAll(/(?:src|href)="(\/ui\/assets\/[^" ]+)"/g)];assert.ok(assets.length>0,'Dashboard must reference built assets');
 for(const path of assets)assert.equal((await fetch(base+path[1])).status,200);
 const {plan}=await runtimeRequest(project,'goals',{title:'Installed package',requirements:'Write done to a.txt',acceptance:['File is done']});
 const draft=await runtimeRequest(project,`plans/${plan.id}/analyze`,{});
 await runtimeRequest(project,`plans/${plan.id}/approve`,{revision:draft.revision,contentHash:draft.contentHash,actor:'human',maxWorkers:1,maxReviewers:1,workers:[{workerRef:'W1',adapter:'codex',profile:'default'}],integration:'reviewed-local'});
 let detail;
 for(let i=0;i<400;i++){detail=await runtimeRequest(project,`plans/${plan.id}`);if(detail.status!=='executing')break;await new Promise(r=>setTimeout(r,50));}
 assert.equal(detail.status,'completed',detail.note);assert.equal(readFileSync(join(project,'a.txt'),'utf8'),'done');assert.equal(git(project,'status','--porcelain'),'');
 console.log('Package check passed: tarball allowlist, installed bin, production dependencies, doctor, dashboard assets, planner, worker, review, integration.');
}finally{
 await runtime?.stop();
 // Delete only the uniquely created temporary directory, after stopping its runtime.
 assert.ok(resolve(scratch).startsWith(resolve(tmpdir())+sep));rmSync(scratch,{recursive:true,force:true,maxRetries:20,retryDelay:100});
}
