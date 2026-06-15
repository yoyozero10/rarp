import {writeFileSync} from 'node:fs';
if (process.argv.includes('--antigravity')) {
  const input = process.argv.at(-1);
  const scope = JSON.parse(input.match(/FILE_SCOPE (\[[^\n]+\])/)[1]);
  writeFileSync(scope[0], 'done');
  console.log(JSON.stringify({event:'result',result:{status:'SUCCESS',response:'Done',denied_actions:[]}}));
  process.exit(0);
}
let input='';for await(const chunk of process.stdin)input+=chunk;
if(input.includes('read-only Rarp planner')) {
const step={key:'first',title:'Write a.txt',requirements:'Write done to a.txt',deliverable:'a.txt',dependencies:[],workerRef:'W1',scope:['a.txt'],check:[process.execPath,'-e',"require('node:assert').equal(require('node:fs').readFileSync('a.txt','utf8'),'done')"],acceptance:['a.txt contains done']};
const p={understood:'Write done to a.txt',assumptions:[],questions:[],rationale:'One task is sufficient',size:'small',confidence:'high',workers:[{workerRef:'W1',rationale:'One scoped task'}],maxWorkers:1,steps:[step],policy:{maxRounds:1,timeoutMs:10000,totalTimeoutMs:20000}};
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify(p)}}));
}else if(input.includes('reviewer') || input.includes('manager')) {
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify({decision:'accepted',feedback:'Verified scoped output',evidence:['a.txt contains done; verification passed']})}}));
}else{const scope=JSON.parse(input.match(/FILE_SCOPE (\[[^\n]+\])/)[1]);writeFileSync(scope[0],'done'); console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Done'}}));}
console.log(JSON.stringify({type:'turn.completed'}));
