import {readFileSync,writeFileSync,existsSync} from 'node:fs';
const [mode,state]=process.argv.slice(2);
let prompt='';for await(const chunk of process.stdin)prompt+=chunk;
const message=text=>console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text}}));
if(prompt.includes('independent Rarp manager')) {
 const task=JSON.parse(prompt.match(/TASK (\{[^\n]+\})/)[1]);
 const good=['done','combined'].includes(readFileSync(task.title==='b'?'b.txt':'a.txt','utf8'));
 message(JSON.stringify({decision:good?'accepted':'changes_requested',feedback:good?'Verified':'Set a.txt to done',evidence:['Read a.txt']}));
}else{
 const n=existsSync(state)?Number(readFileSync(state,'utf8'))+1:1;writeFileSync(state,String(n));
 if(mode==='denied' || mode==='transient'&&n===1){console.log(JSON.stringify({type:'turn.failed',error:{message:mode==='denied'?'Permission denied; configure CLI permissions':'HTTP 429 temporary rate limit'}}));process.exit(1);}
 const scope=JSON.parse(prompt.match(/FILE_SCOPE (\[[^\n]+\])/)[1]);
 const content=mode==='stuck'||(['check-repair','review-repair'].includes(mode)&&n===1)?'bad':(mode==='final-repair'&&prompt.includes('Final verification failed:') || mode==='integration-repair'&&prompt.includes('Verification failed:'))?'combined':'done';
 if(mode==='hang'&&n===1)await new Promise(()=>setInterval(()=>{},1000));
 writeFileSync(scope[0],content);message('Changed '+scope[0]);
}
console.log(JSON.stringify({type:'turn.completed'}));
