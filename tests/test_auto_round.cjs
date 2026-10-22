const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const next = () => new Promise(resolve => setImmediate(resolve));
const scope = {window:{},setTimeout,clearTimeout};
vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../web/voice.js'),'utf8'),scope);
function fixture(){
  const log={spoken:[],listened:0};let resolvePlay;
  const flow=new scope.window.PartnerTurnFlow({
    cancelPlayback:()=>{resolvePlay?.(false);resolvePlay=null;},
    canContinue:()=>true,onActive:value=>{log.active=value;},
    onReply:reply=>log.spoken.push(reply.id),
    play:()=>new Promise(resolve=>{resolvePlay=resolve;}),listen:()=>log.listened++
  });
  return {flow,log,finish:(ok=true)=>resolvePlay(ok)};
}
(async()=>{
  const replies=['aanya','kabir','riya'].map(id=>({id}));
  let f=fixture();const pending=f.flow.run(replies,true);
  assert.deepEqual(f.log.spoken,['aanya']);
  f.finish();await next();assert.deepEqual(f.log.spoken,['aanya','kabir']);assert.equal(f.log.listened,0);
  f.finish();await next();assert.deepEqual(f.log.spoken,['aanya','kabir','riya']);assert.equal(f.log.listened,0);
  f.finish();await pending;await new Promise(r=>setTimeout(r,450));assert.equal(f.log.listened,1);
  f=fixture();const stopped=f.flow.run(replies,true);f.flow.cancel();await stopped;
  await new Promise(r=>setTimeout(r,450));assert.deepEqual(f.log.spoken,['aanya']);assert.equal(f.log.listened,0);
  f=fixture();const failed=f.flow.run(replies,true);f.finish(false);await failed;
  assert.deepEqual(f.log.spoken,['aanya']);assert.equal(f.log.listened,0);
  f=fixture();const manual=f.flow.run(replies,false);
  for(let i=0;i<3;i++){f.finish();await next();}await manual;
  await new Promise(r=>setTimeout(r,450));assert.equal(f.log.listened,0);
  f=fixture();const cancelledRestart=f.flow.run([replies[0]],true);f.finish();await cancelledRestart;f.flow.cancel();
  await new Promise(r=>setTimeout(r,450));assert.equal(f.log.listened,0);
  console.log(JSON.stringify({passed:true,checks:5,coverage:'Ordered partner playback, no microphone during replies, one restart after Riya, pause/stop cancellation, playback failure, manual mode'}));
})().catch(e=>{console.error(e);process.exit(1);});
