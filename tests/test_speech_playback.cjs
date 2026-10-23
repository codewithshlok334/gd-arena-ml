// Check actual speaker completion/cancellation without a physical audio device.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../web/app.js'), 'utf8');
const start = source.indexOf('function cancelPlayback(');
const end = source.indexOf('function startMic(', start);
assert.ok(start >= 0 && end > start);

function fixture(voices = [
  {name:'Remote English', lang:'en-US', localService:false},
  {name:'Installed English', lang:'en-IN', localService:true}
]) {
  const log = {spoken:[], cancelled:0, statuses:[]};
  const element = {hidden:true, classList:{add(){}, remove(){}}};
  const synth = {
    getVoices:()=>voices, resume(){},
    speak:utterance=>log.spoken.push(utterance),
    cancel:()=>log.cancelled++
  };
  class Utterance { constructor(text) { this.text=text; } }
  const scope = {
    window:{speechSynthesis:synth, SpeechSynthesisUtterance:Utterance},
    SpeechSynthesisUtterance:Utterance, speechGeneration:0, playbackDone:null,
    partnerFlow:null, document:{querySelectorAll:()=>[]}, $:()=>element,
    voiceStatus:text=>log.statuses.push(text), words:text=>text.split(/\s+/).length,
    setTimeout, clearTimeout
  };
  vm.runInNewContext(source.slice(start,end),scope);
  return {scope,log};
}

(async()=>{
  const replies=['aanya','kabir','riya'].map(id=>({id,name:id,text:'A useful discussion point.'}));
  let f=fixture();
  for(const reply of replies){
    const pending=f.scope.speakReply(reply);
    const utterance=f.log.spoken.at(-1);
    assert.equal(utterance.voice.localService,true);
    utterance.onstart();utterance.onend();assert.equal(await pending,true);
  }
  // Switching after onend must not cancel/restart the browser speech engine.
  assert.equal(f.log.cancelled,0);
  assert.equal(f.log.spoken.length,3);

  const active=f.scope.speakReply(replies[0]);
  const count=f.log.statuses.length;
  f.log.spoken[0].onerror(); // Late event from a completed, older speaker.
  assert.equal(f.log.statuses.length,count);
  f.scope.cancelSpeech();assert.equal(await active,false);
  assert.equal(f.log.cancelled,1);

  f=fixture([{name:'Remote only',lang:'en-US',localService:false}]);
  let pending=f.scope.speakReply(replies[0]);
  assert.equal(f.log.spoken[0].voice.name,'Remote only');
  f.log.spoken[0].onend();assert.equal(await pending,true);

  f=fixture([]);pending=f.scope.speakReply(replies[0]);
  assert.equal(f.log.spoken[0].voice,undefined);
  f.log.spoken[0].onerror();assert.equal(await pending,false);

  console.log(JSON.stringify({passed:true,checks:6,physical_audio_tested:false,
    coverage:'Installed voice preference, sequential playback without engine resets, stale events, cancellation, remote/default fallback and playback failure'}));
})().catch(error=>{console.error(error);process.exit(1);});
