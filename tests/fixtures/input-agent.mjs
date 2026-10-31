import { writeFileSync } from 'node:fs';
let prompt='';
for await (const chunk of process.stdin) prompt+=chunk;
const emit=text=>console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text}}));
if(prompt.includes('independent Rarp manager')) {
  emit(JSON.stringify({decision:'accepted',feedback:'Verified answer applied',evidence:['Scoped check passed']}));
} else {
  const input=JSON.parse(prompt.match(/^USER_INPUT (.*)$/m)[1]);
  if(!input?.answer) {
    writeFileSync('a.txt','partial');
    emit(JSON.stringify({rarp_input:{question:'What should a.txt contain?'}}));
  } else {
    if(input.question!=='What should a.txt contain?' || input.answer!=='done') throw new Error('Wrong input context');
    writeFileSync('a.txt',input.answer);
    emit('Done');
  }
}
console.log(JSON.stringify({type:'turn.completed'}));
