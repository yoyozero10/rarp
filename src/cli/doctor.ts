import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { loadProfiles, available, profileCommand } from '../runtime/planning.js';
import { codexCommand } from '../adapters/codex.js';

type Check = { name: string; status: 'pass' | 'warn' | 'fail'; detail: string; fix?: string };
export function doctor(project: string, options: { codex: string; agy: string; managerProfile?: string }) {
  const root=resolve(project), checks:Check[]=[];
  const add=(name:string,status:Check['status'],detail:string,fix?:string)=>checks.push({name,status,detail,...(status!=='pass' && fix?{fix}:{})});
  const probe=(file:string,args:string[])=>spawnSync(file,args,{cwd:root,encoding:'utf8',timeout:10000,maxBuffer:64*1024,windowsHide:true,shell:false});
  add('node',Number(process.versions.node.split('.')[0])>=24?'pass':'fail',process.versions.node,'Install Node.js >=24.');
  for(const path of ['dist/runtime/daemon.js','dist/runtime/worker-host.js','dist/ui/index.html','schemas/plan.json','schemas/review.json']) {
    const ok=existsSync(new URL('../../'+path,import.meta.url));add('package:'+path,ok?'pass':'fail',ok?'Installed asset present':'Installed asset missing',ok?undefined:'Reinstall the package, or run npm run build in the source checkout.');
  }
  const git=probe('git',['--version']);
  add('git',git.status===0?'pass':'fail',git.status===0?git.stdout.trim():'Git unavailable','Install Git and add it to PATH.');
  const repository=probe('git',['rev-parse','--show-toplevel']);
  if(repository.status!==0)add('repository','fail','Project is not an accessible Git repository','Select an existing repository with --project, or initialize one with git init.');
  else {
    const top=probe('git',['rev-parse','--show-prefix']);
    add('repository',top.status===0 && !top.stdout.trim()?'pass':'fail','Git repository detected','Use the Git repository root with --project.');
    const head=probe('git',['rev-parse','--verify','HEAD']);
    add('head',head.status===0?'pass':'warn',head.status===0?'Initial commit exists':'No initial commit','Create an initial commit before isolated workflows.');
    const status=probe('git',['status','--porcelain']);
    add('checkout',status.status===0 && !status.stdout.trim()?'pass':'warn',status.status===0 && !status.stdout.trim()?'Checkout clean':'Checkout dirty or unreadable','Commit or preserve pending changes before approving a plan.');
  }
  for(const [name,file,required] of [['codex',options.codex,true],['antigravity',options.agy,false]] as const) {
    const result=probe(file,['--version']),ok=result.status===0;
    add(name,ok?'pass':required?'fail':'warn',ok?'CLI responds to --version':'CLI unavailable or version probe failed',name==='codex'?'Install Codex CLI; select its executable with --codex.':'Optional: install Antigravity CLI; select its executable with --agy.');
    if(ok && name==='codex') {
      const auth=probe(file,[...(options.managerProfile?['--profile',options.managerProfile]:[]),'login','status']);
      add('codex-auth',auth.status===0?'pass':'warn',auth.status===0?'CLI reports authenticated':'Authentication could not be confirmed','Run codex login status with the same profile; configure its provider credentials if needed.');
    }
    if(ok && name==='antigravity')add('antigravity-permissions','warn','Headless authentication and tool permissions are not exercised','Check Antigravity login and command allow-rules before dispatch; doctor does not grant permissions.');
  }
  try {
    const profiles=loadProfiles(root);
    for(const [id,p] of Object.entries(profiles??{})) {
      const selected=profileCommand({profiles:profiles!},codexCommand(options.codex),p.adapter,id.slice(id.indexOf(':')+1));
      add('profile:'+id,available(selected.file)?'pass':'fail',available(selected.file)?'Configuration valid; executable found (authentication is declared, not verified)':'Executable missing','Review .rarp/profiles.json and the CLI login; no model request was sent.');
    }
    if(!profiles)add('profiles','warn','No project worker profiles configured','Optional: configure .rarp/profiles.json for explicit worker models.');
  }catch{add('profiles','fail','Invalid worker profile configuration','Review .rarp/profiles.json: adapter, executable, model and authenticated fields.');}
  const database=resolve(root,'.rarp','state.db');
  if(!existsSync(database))add('storage','warn','Project storage not initialized','Run rarp init in the project.');
  else {
    let db:DatabaseSync|undefined;
    try {
      db=new DatabaseSync(database,{readOnly:true});db.exec('PRAGMA busy_timeout=1000');
      const version=Number(db.prepare('PRAGMA user_version').get()?.['user_version']);
      const integrity=db.prepare('PRAGMA quick_check').all();
      const ok=integrity.length===1 && integrity[0]?.['quick_check']==='ok' && [1,2,3,4].includes(version);
      add('storage',ok?'pass':'fail',ok?'SQLite readable; integrity check passed; schema '+version:'Unsupported schema or integrity check failed','Back up .rarp before recovery; use a compatible Rarp version.');
      if(version>=2) {
        const active=Number(db.prepare("SELECT count(*) AS n FROM runs WHERE state='active'").get()?.['n']);
        if(active)add('runs','warn',active+' unfinished runs','Check rarp runtime status. If the old runtime is gone, inspect workspaces and run rarp runtime recover.');
      }
    }catch{add('storage','fail','SQLite cannot be inspected read-only','Check file access and back up .rarp before attempting repair.');}
    finally{db?.close();}
  }
  const lock=resolve(root,'.rarp','runtime.json');
  if(existsSync(lock)) {
    try {
      const meta=JSON.parse(readFileSync(lock,'utf8')) as {pid?:unknown};
      if(!Number.isInteger(meta.pid) || Number(meta.pid)<=0)throw new Error('Invalid PID');
      try{process.kill(Number(meta.pid),0);add('runtime','pass','Runtime lock owner process exists; identity and API health not verified');}
      catch{add('runtime','warn','Runtime lock owner unavailable or cannot be inspected','Check rarp runtime status; inspect stale processes and use rarp runtime recover.');}
    }catch{add('runtime','fail','Invalid runtime lock','Inspect .rarp/runtime.json and old processes before recovery.');}
  }else add('runtime','pass','No runtime lock');
  if(process.platform==='win32') {
    const kill=probe('taskkill',['/?']);add('process-cleanup',kill.status===0?'pass':'fail','Windows taskkill availability','Ensure taskkill is available on PATH.');
    add('containment','warn','Windows Job Object containment is not implemented','Supervise long-running work; detached descendants are not fully contained.');
  }
  return {ok:checks.every(c=>c.status!=='fail'),project:root,checks};
}
