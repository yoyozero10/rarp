import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,existsSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {doctor} from '../dist/cli/doctor.js';
import {Store} from '../dist/storage/store.js';
import {git} from '../dist/runtime/workspace.js';

function fixture(t){const root=mkdtempSync(join(tmpdir(),'rarp-doctor-'));git(root,'init');t.after(()=>rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100}));return root;}
const options={codex:process.execPath,agy:'rarp-missing-agy-executable'};
test('doctor inspects fresh repositories without initializing storage or requiring optional CLI',t=>{
 const root=fixture(t),report=doctor(root,options);
 assert.equal(report.ok,true);assert.equal(existsSync(join(root,'.rarp')),false);
 assert.equal(report.checks.find(c=>c.name==='antigravity').status,'warn');
 assert.equal(report.checks.find(c=>c.name==='storage').status,'warn');
 assert.equal(report.checks.filter(c=>c.name.startsWith('package:')).every(c=>c.status==='pass'),true);
});
test('doctor reports required CLI and invalid repository with nonzero CLI exit',t=>{
 const root=mkdtempSync(join(tmpdir(),'rarp-doctor-no-git-'));t.after(()=>rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100}));
 const run=spawnSync(process.execPath,[resolve('dist/cli/index.js'),'--project',root,'--json','doctor','--codex','rarp-missing-codex-executable','--agy',options.agy],{encoding:'utf8'});
 assert.equal(run.status,1);const report=JSON.parse(run.stdout);
 assert.equal(report.checks.find(c=>c.name==='repository').status,'fail');assert.equal(report.checks.find(c=>c.name==='codex').status,'fail');
 assert.equal(existsSync(join(root,'.rarp')),false);
});
test('doctor reads persisted state without migrations or exposing runtime credentials',t=>{
 const root=fixture(t),store=new Store(root,true);store.close();
 const file=join(root,'.rarp','state.db'),before=readFileSync(file);
 writeFileSync(join(root,'.rarp','runtime.json'),JSON.stringify({pid:process.pid,token:'secret-do-not-print',port:1234}));
 const report=doctor(root,options);assert.equal(report.ok,true);assert.equal(JSON.stringify(report).includes('secret-do-not-print'),false);
 assert.deepEqual(readFileSync(file),before);
 const db=new DatabaseSync(file);db.exec('PRAGMA user_version=999');db.close();
 const invalid=doctor(root,options);assert.equal(invalid.ok,false);const reopened=new DatabaseSync(file,{readOnly:true});assert.equal(reopened.prepare('PRAGMA user_version').get().user_version,999);reopened.close();
});
test('doctor rejects malformed profiles without printing configuration contents',t=>{
 const root=fixture(t),store=new Store(root,true);store.close();writeFileSync(join(root,'.rarp','profiles.json'),'secret-invalid-json');
 const report=doctor(root,options);assert.equal(report.ok,false);assert.equal(report.checks.find(c=>c.name==='profiles').status,'fail');assert.equal(JSON.stringify(report).includes('secret-invalid-json'),false);
});
