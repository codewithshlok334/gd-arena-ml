// BEGIN BUNDLED CAMERA
'use strict';
(() => {
'use strict';
// Optional, local preview only. Camera tracks never enter the voice recorder or server.
class LocalCamera {
  constructor(video, {onState = () => {}, onError = () => {}} = {}) {
    this.video = video;
    this.onState = onState;
    this.onError = onError;
    this.stream = null;
    this.generation = 0;
    this.phase = 'off';
  }
  setState(phase) { this.phase = phase; this.onState(phase); }
  stop() {
    this.generation++;
    const stream = this.stream;
    this.stream = null;
    stream?.getTracks().forEach(track => track.stop());
    this.video.srcObject = null;
    this.setState('off');
  }
  async start(deviceId = '') {
    this.stop();
    const generation = this.generation;
    if (!navigator.mediaDevices?.getUserMedia) {
      this.onError('Camera preview is unavailable here. You can continue with your avatar.');
      return;
    }
    this.setState('requesting');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {width: {ideal: 1280}, height: {ideal: 720}, ...(deviceId ? {deviceId: {exact: deviceId}} : {facingMode: 'user'})},
        audio: false
      });
      if (generation !== this.generation) { stream.getTracks().forEach(track => track.stop()); return; }
      this.stream = stream;
      const track = stream.getVideoTracks()[0];
      if (!track || track.readyState === 'ended') throw new Error('Camera disconnected.');
      track.addEventListener('ended', () => {
        if (generation !== this.generation) return;
        this.stop();
        this.onError('Camera disconnected. Your avatar is back; the discussion can continue.');
      });
      this.video.srcObject = stream;
      await this.video.play();
      if (generation !== this.generation) return;
      this.setState('on');
    } catch (cause) {
      if (generation !== this.generation) return;
      this.stop();
      const messages = {
        NotAllowedError: 'Camera permission was not allowed. Continue with your avatar, or allow Camera in your browser’s site settings and try again.',
        NotFoundError: 'No camera was found. Connect a webcam, then try again. You can continue with your avatar.',
        NotReadableError: 'The camera could not start. Close other apps using it, or choose another camera in Devices.',
        OverconstrainedError: 'That camera is no longer available. Choose another camera in Devices.',
        SecurityError: 'This browser blocked the camera. You can continue with your avatar.'
      };
      this.onError(messages[cause.name] || 'Camera preview could not start. You can continue with your avatar.');
    }
  }
}
window.LocalCamera = LocalCamera;
})();
// END BUNDLED CAMERA
'use strict';
// Session text stays in memory. Recorded speech is transcribed by the local Python server.
const $ = id => document.getElementById(id);
const categories = {ai_jobs:'Technology',remote_work:'Career',online_education:'Society',social_media:'Society',skills_degrees:'Career',ai_education:'Technology',digital_payments:'Technology',startups:'Career',ev_india:'Technology',environment:'Society'};
const shortNotes = {ai_jobs:'Automation, opportunity and the future of work.',remote_work:'Flexibility, teamwork and where we work best.',online_education:'Access, engagement and learning outcomes.',social_media:'Connection, community and digital well-being.',skills_degrees:'What really makes someone job-ready?',ai_education:'Learning support, originality and responsible use.',digital_payments:'Convenience, inclusion and everyday trust.',startups:'Stability, ownership and career growth.',ev_india:'Infrastructure, affordability and cleaner travel.',environment:'Balancing progress with a livable planet.'};
const state = {info:null,selected:'remote_work',filter:'All',active:false,paused:false,busy:false,sessionId:0,messages:[],turns:0,words:0,used:[],duration:600,remaining:600,deadline:0,controller:null,view:'setup',startedAt:null,language:'en-IN'};
const canRecord = !!(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);
let speechReady = false, speechPoll = null;
let listening = false, speechGeneration = 0, voice = null, partnerFlow = null, playbackDone = null;
const words = text => text.trim() ? text.trim().split(/\s+/).length : 0;
const timeText = seconds => `${Math.floor(seconds/60)}:${String(Math.floor(seconds%60)).padStart(2,'0')}`;
function node(tag,cls,text){const el=document.createElement(tag);if(cls)el.className=cls;if(text!==undefined)el.textContent=text;return el;}
function icon(name){const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');const use=document.createElementNS('http://www.w3.org/2000/svg','use');use.setAttribute('href',`#i-${name}`);svg.append(use);return svg;}
function topic(){return state.info.topics.find(t=>t.id===state.selected);}
function error(text=''){$('globalError').textContent=text;$('globalError').hidden=!text;}
function voiceStatus(text,isError=false){$('voiceStatus').textContent=text;$('voiceStatus').classList.toggle('error',isError);if(isError&&state.active)openPanel('devices',false);}
function showView(view){state.view=view;document.body.classList.toggle('meeting-mode',view==='room');for(const name of ['setup','room','summary'])$(name+'View').hidden=name!==view;$('pageLabel').textContent={setup:'Topic library',room:'Practice room',summary:'Session recap'}[view];for(const [id,name] of [['navTopics','setup'],['navRoom','room'],['navSummary','summary']])$(id).classList.toggle('active',view===name);error();window.scrollTo(0,0);}
function renderTopics(){const grid=$('topicGrid');grid.replaceChildren();state.info.topics.forEach((item,index)=>{if(state.filter!=='All'&&categories[item.id]!==state.filter)return;const card=node('button','topic-card'+(item.id===state.selected?' selected':''));card.type='button';card.dataset.topic=item.id;card.setAttribute('aria-pressed',String(item.id===state.selected));const top=node('div','topic-top');top.append(node('span','topic-number',String(index+1).padStart(2,'0')),node('span','topic-category',categories[item.id]));const check=node('span','topic-check');if(item.id===state.selected)check.append(icon('check'));top.append(check);card.append(top,node('h3','',item.title),node('p','',shortNotes[item.id]));card.addEventListener('click',()=>{state.selected=item.id;renderTopics();selectedPreview();});grid.append(card);});}
function selectedPreview(){$('selectedTitle').textContent=topic().title;$('selectedIntro').textContent=topic().target;}
function setLanguage(){const hinglish=$('language').value==='hi-IN';$('languageHint').textContent=hinglish?'Hindi / Hinglish speech → transcript → your reviewed English version. Replies stay in English.':'Speak or type. Model analysis and partner replies are in English.';$('hinglishBlock').hidden=!hinglish;$('reviewRow').hidden=!hinglish;$('argumentLabel').textContent=hinglish?'Your reviewed English version':'Your perspective';$('argument').placeholder=hinglish?'Write the English meaning here before sharing…':'I think… because… For example…';}
function syncControls(){const blocked=!state.active||state.paused||state.busy||state.voiceBusy||state.replying;$('argument').disabled=blocked;$('speechDraft').disabled=blocked;$('englishReviewed').disabled=blocked;$('sendBtn').disabled=blocked||listening;$('sendBtn').firstChild.textContent=state.busy?'Analyzing…':'Share your point';$('micDevice').disabled=blocked||listening;$('refreshMics').disabled=blocked||listening;$('autoShare').disabled=blocked||listening;$('micBtn').disabled=blocked||!canRecord||!speechReady;$('uploadAudioBtn').disabled=blocked||listening||!speechReady;$('pauseBtn').disabled=state.busy;$('pausedBanner').hidden=!state.paused;$('pauseBtn').setAttribute('aria-label',state.paused?'Resume session':'Pause session');$('pauseBtn').title=state.paused?'Resume session':'Pause session';$('pauseBtn').replaceChildren(state.paused?node('span','','▶'):icon('pause'));$('cancelVoiceBtn').hidden=!(listening||state.voiceBusy);$('argument').readOnly=listening&&state.language!=='hi-IN';$('speechDraft').readOnly=listening&&state.language==='hi-IN';$('micBtn').classList.toggle('listening',listening);$('micBtn').querySelector('span').textContent=listening?'Stop & transcribe':state.voiceBusy?'Please wait…':state.replying?'Partners…':'Speak';$('participant-you').classList.toggle('listening',listening);syncCameraControls();$('youStatus').textContent=listening?'Recording…':state.paused?'Paused':state.busy?'Reading your point…':'Ready to contribute';}
function addMessage(message){updateCaption(message);state.messages.push({...message,time:new Date().toISOString()});renderMessage(state.messages.at(-1));}
function renderMessage(message){const row=node('article','message '+(message.kind==='user'?'user':message.kind==='moderator'?'moderator':''));if(message.kind!=='moderator')row.append(node('span','avatar '+(message.kind==='user'?'you-avatar':message.partner),message.name[0]));const body=node('div','message-body');const header=node('div','message-heading');header.append(node('strong','',message.name),node('span','',message.kind==='partner'?'Prepared perspective':message.kind==='moderator'?'Session guide':'Your contribution'));const timestamp=node('time','',new Date(message.time).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}));timestamp.dateTime=message.time;header.append(timestamp);body.append(header,node('p','',message.text));if(message.stance)body.append(node('span','message-tag',`Model prediction: ${message.stance}`));row.append(body);$('transcript').append(row);$('transcript').scrollTop=$('transcript').scrollHeight;}
function updateTimer(){if(state.active&&!state.paused){state.remaining=Math.max(0,(state.deadline-Date.now())/1000);if(state.remaining<=0){finishSession();return;}}$('timer').textContent=timeText(Math.ceil(state.remaining));$('timer').parentElement.classList.toggle('urgent',state.remaining<60);}
function startSession(){camera?.stop();$('cameraStatus').hidden=true;closePanel(false);state.sessionId++;state.active=true;state.paused=false;state.busy=false;state.turns=0;state.words=0;state.used=[];state.messages=[];state.duration=Number($('duration').value);state.remaining=state.duration;state.deadline=Date.now()+state.duration*1000;state.startedAt=new Date().toISOString();state.sessionTopic={...topic()};state.language=$('language').value;$('transcript').replaceChildren();$('argument').value='';$('speechDraft').value='';$('englishReviewed').checked=false;$('wordCounter').textContent='0 words';$('roomTitle').textContent=topic().title;$('roomTarget').textContent=topic().target;$('turnCount').textContent='0';$('totalWords').textContent='0';$('messageCount').textContent='0 contributions';$('stanceLabel').textContent='Make your opening.';$('stanceDescription').textContent='Share a point to see how your model reads its stance toward the proposition.';$('stanceIcon').textContent='↗';$('scoreDetails').hidden=true;$('coachNote').textContent='Give your view, explain why, then make it concrete with an example.';$('navRoom').disabled=false;$('navSummary').disabled=true;setLanguage();voiceStatus(speechReady?(canRecord?'Press Speak and make your point. A 2-second quiet pause ends the recording.':'Recording is unavailable here. Use Upload audio, or open the local app in Chrome / Edge.'):state.info.speech.message);$('micHelp').hidden=true;showView('room');addMessage({kind:'moderator',name:'Moderator',text:`Welcome to your discussion on “${topic().title}”. The proposition is: ${topic().target}. Start with your view and a reason. Aanya, Kabir and Riya will take turns offering prepared perspectives.`});syncControls();syncSound();updateTimer();$('micBtn').focus();}
function stopMic(){voice?.stop();}
function abortMic(){voice?.cancel();listening=false;state.voiceBusy=false;syncControls();}
function cancelPlayback(){
  speechGeneration++;
  if(playbackDone)playbackDone(false);
  window.speechSynthesis?.cancel();
  $('stopVoiceBtn').hidden=true;
  document.querySelectorAll('.participant.speaking').forEach(el=>el.classList.remove('speaking'));
}
function cancelSpeech(){if(partnerFlow)partnerFlow.cancel();else cancelPlayback();}
function syncSound(){const enabled=$('voiceEnabled').checked;$('soundBtn').setAttribute('aria-pressed',String(enabled));$('soundBtn').querySelector('span').textContent=enabled?'Voice on':'Voice off';if(!enabled)cancelSpeech();}
function speakReply(reply){
  cancelPlayback();
  if(!window.speechSynthesis||!window.SpeechSynthesisUtterance){voiceStatus('Speech playback is unavailable. Read the reply and press Speak for your next point.',true);return Promise.resolve(false);}
  const generation=speechGeneration;
  return new Promise(resolve=>{
    const utterance=new SpeechSynthesisUtterance(reply.text);
    const voices=window.speechSynthesis.getVoices().filter(v=>v.lang.toLowerCase().startsWith('en'));
    const index={aanya:0,kabir:1,riya:2}[reply.id]||0;
    if(voices.length)utterance.voice=voices[index%voices.length];
    utterance.lang=utterance.voice?.lang||'en-IN';utterance.rate=.96;
    utterance.pitch={aanya:1.04,kabir:.94,riya:1}[reply.id]||1;
    let settled=false,timer;
    const finish=ok=>{
      if(settled)return;settled=true;clearTimeout(timer);
      if(playbackDone===finish)playbackDone=null;
      if(generation===speechGeneration){$('stopVoiceBtn').hidden=true;$('participant-'+reply.id)?.classList.remove('speaking');}
      resolve(ok);
    };
    playbackDone=finish;
    utterance.onstart=()=>{if(generation!==speechGeneration)return;$('stopVoiceBtn').hidden=false;$('participant-'+reply.id)?.classList.add('speaking');voiceStatus(reply.name+' is speaking. Your microphone is off.');};
    utterance.onend=()=>finish(true);
    utterance.onerror=()=>{finish(false);if(generation===speechGeneration)voiceStatus('Playback stopped. Press Speak when you want to continue.',true);};
    timer=setTimeout(()=>{finish(false);if(generation===speechGeneration){window.speechSynthesis.cancel();voiceStatus('Voice playback did not finish. Press Speak to continue.',true);}},Math.max(20000,words(reply.text)*1200+10000));
    try{window.speechSynthesis.resume?.();window.speechSynthesis.speak(utterance);}catch(_){finish(false);voiceStatus('Voice playback is unavailable. You can read the reply and press Speak.',true);}
  });
}
function startMic(){
  if(!state.active||state.paused||state.busy||state.replying||!speechReady)return;
  cancelSpeech();state.voiceSessionId=state.sessionId;state.voiceDraftBefore=$('argument').value.trim();
  voice.start(state.language,$('micDevice').value,{autoShare:$('autoShare').checked});
}
async function submitArgument(event){
  event.preventDefault();
  if(!state.active||state.paused||state.busy||state.replying||state.voiceBusy||listening)return;
  const text=$('argument').value.trim();error();
  if(words(text)<3){error('Write at least three words before sharing your point.');return;}
  if(/[\u0900-\u097f]/.test(text)){error('Write the English meaning of your transcript in the English argument field.');return;}
  if(state.language==='hi-IN'&&!$('englishReviewed').checked){error('Review the English meaning, then tick the review box before sharing.');return;}
  cancelSpeech();state.busy=true;syncControls();
  const sessionId=state.sessionId, autoRound=$('autoFlow').checked;
  const source=state.language==='hi-IN'?$('speechDraft').value.trim():'';
  const controller=new AbortController();state.controller=controller;
  const timeout=setTimeout(()=>controller.abort(),30000);
  try{
    const response=await fetch('api/turn',{method:'POST',headers:{'Content-Type':'application/json','X-GD-Arena':'1'},body:JSON.stringify({topic_id:state.selected,text,turn_number:state.turns,used_points:state.used,reply_count:autoRound?3:1}),signal:controller.signal});
    const data=await response.json();if(!response.ok)throw new Error(data.error||'The model could not process this point.');
    if(sessionId!==state.sessionId||!state.active||state.paused)return;
    clearTimeout(timeout);state.controller=null;state.busy=false;
    state.turns++;state.words+=data.word_count;
    addMessage({kind:'user',name:'You',text,original_transcript:source,stance:data.analysis.stance,decision_scores:data.analysis.decision_scores});
    $('turnCount').textContent=state.turns;$('totalWords').textContent=state.words;
    $('stanceLabel').textContent={support:'Leaning in favor.',oppose:'Taking the other side.',neutral:'Exploring the middle.'}[data.analysis.stance];
    $('stanceDescription').textContent=`The model predicts “${data.analysis.stance}” toward: ${data.analysis.target}`;
    $('stanceIcon').textContent={support:'↗',oppose:'↙',neutral:'↔'}[data.analysis.stance];$('scoreList').replaceChildren();
    Object.entries(data.analysis.decision_scores).forEach(([label,value])=>{const row=node('div');row.append(node('span','',label),node('strong','',Number(value).toFixed(3)));$('scoreList').append(row);});
    $('scoreDetails').hidden=false;$('coachNote').textContent=data.coach_note;
    $('argument').value='';$('speechDraft').value='';$('englishReviewed').checked=false;$('wordCounter').textContent='0 words';
    syncControls();
    await partnerFlow.run(data.replies||[data.reply],autoRound&&$('voiceEnabled').checked&&state.language!=='hi-IN');
  }catch(cause){if(sessionId===state.sessionId&&state.active)error(cause.name==='AbortError'?'The model took too long. Your draft is saved; try sharing again.':cause.message);}
  finally{clearTimeout(timeout);if(sessionId===state.sessionId){state.busy=false;state.controller=null;syncControls();}}
}
function pauseSession(){if(!state.active)return;if(!state.paused){state.remaining=Math.max(0,(state.deadline-Date.now())/1000);state.paused=true;abortMic();cancelSpeech();camera?.stop();}else{state.paused=false;state.deadline=Date.now()+state.remaining*1000;}syncControls();updateTimer();}
function finishSession(){if(!state.active)return;if(!state.paused)state.remaining=Math.max(0,(state.deadline-Date.now())/1000);state.active=false;state.busy=false;state.sessionId++;state.controller?.abort();state.controller=null;abortMic();cancelSpeech();camera?.stop();if($('leaveDialog').open)$('leaveDialog').close();$('navRoom').disabled=true;$('navSummary').disabled=false;$('summarySubtitle').textContent=topic().title;$('recapTurns').textContent=state.turns;$('recapWords').textContent=state.words;$('recapTime').textContent=timeText(Math.round(state.duration-state.remaining));const counts={support:0,oppose:0,neutral:0};state.messages.filter(m=>m.kind==='user').forEach(m=>counts[m.stance]++);$('stanceCounts').replaceChildren();Object.entries(counts).forEach(([label,count])=>{const box=node('div');box.append(node('strong','',count),node('span','',label));$('stanceCounts').append(box);});$('recapNote').textContent=state.turns?`You shared ${state.turns} point${state.turns===1?'':'s'} and explored ${state.messages.filter(m=>m.kind==='partner').length} prepared partner perspectives. Download your transcript to reflect on the discussion.`:'You ended before sharing a point. Start another round whenever you are ready.';showView('summary');}
function askEnd(){if(state.active)$('leaveDialog').showModal();}
function downloadTranscript(){const lines=['GD ARENA — SESSION TRANSCRIPT',`Topic: ${state.sessionTopic.title}`,`Proposition: ${state.sessionTopic.target}`,`Started: ${state.startedAt}`,`Active time: ${timeText(Math.round(state.duration-state.remaining))}`,`Your turns: ${state.turns} | Words: ${state.words}`,'','Model: trained Logistic Regression stance classifier. Experimental baseline.','Partner replies: prepared training examples, selected by topic and text relevance.','Raw model scores are not confidence percentages. No interview quality score.',''];state.messages.forEach(m=>{lines.push(`[${new Date(m.time).toLocaleTimeString()}] ${m.name}${m.kind==='partner'?' (prepared perspective)':''}`,m.text);if(m.original_transcript)lines.push('Original speech: '+m.original_transcript);if(m.stance)lines.push('Predicted stance: '+m.stance,'Raw decision scores: '+JSON.stringify(m.decision_scores));lines.push('');});const url=URL.createObjectURL(new Blob([lines.join('\n')],{type:'text/plain;charset=utf-8'}));const link=node('a');link.href=url;link.download=`GD_Arena_${state.selected}_${new Date().toISOString().slice(0,10)}.txt`;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);}
document.querySelectorAll('[data-filter]').forEach(button=>button.addEventListener('click',()=>{state.filter=button.dataset.filter;document.querySelectorAll('[data-filter]').forEach(b=>b.classList.toggle('active',b===button));renderTopics();}));
$('startBtn').addEventListener('click',startSession);$('language').addEventListener('change',setLanguage);$('argumentForm').addEventListener('submit',submitArgument);$('argument').addEventListener('input',()=>{$('wordCounter').textContent=`${words($('argument').value)} words`;$('englishReviewed').checked=false;});$('speechDraft').addEventListener('input',()=>{$('englishReviewed').checked=false;});$('argument').addEventListener('keydown',event=>{if((event.ctrlKey||event.metaKey)&&event.key==='Enter'){event.preventDefault();$('argumentForm').requestSubmit();}});$('micBtn').addEventListener('click',startMic);$('stopVoiceBtn').addEventListener('click',cancelSpeech);$('voiceEnabled').addEventListener('change',syncSound);$('soundBtn').addEventListener('click',()=>{$('voiceEnabled').checked=!$('voiceEnabled').checked;syncSound();});$('pauseBtn').addEventListener('click',pauseSession);$('endBtn').addEventListener('click',askEnd);$('keepPracticing').addEventListener('click',()=>$('leaveDialog').close());$('confirmEnd').addEventListener('click',finishSession);$('navTopics').addEventListener('click',()=>state.active?askEnd():showView('setup'));$('navRoom').addEventListener('click',()=>{if(state.active)showView('room');});$('navSummary').addEventListener('click',()=>showView('summary'));$('againBtn').addEventListener('click',()=>showView('setup'));$('downloadBtn').addEventListener('click',downloadTranscript);$('aboutBtn').addEventListener('click',()=>$('aboutDialog').showModal());document.querySelectorAll('.dialog-close,.dialog-done').forEach(button=>button.addEventListener('click',()=>$('aboutDialog').close()));document.addEventListener('visibilitychange',()=>{if(document.hidden){abortMic();cancelSpeech();camera?.stop();}});window.addEventListener('pagehide',()=>{abortMic();cancelSpeech();camera?.stop();});setInterval(updateTimer,500);


async function refreshMicrophones(){
  if(!navigator.mediaDevices?.enumerateDevices)return;
  try{
    const microphones=(await navigator.mediaDevices.enumerateDevices()).filter(device=>device.kind==='audioinput');
    let previous=$('micDevice').value;
    try{previous=localStorage.getItem('gd-arena-microphone')||previous;}catch(_){}
    const systemDefault=microphones.find(device=>device.deviceId==='default');
    $('micDevice').replaceChildren(new Option(systemDefault?.label||'System default microphone',''));
    microphones.filter(device=>device.deviceId&&device.deviceId!=='default').forEach((device,index)=>{
      $('micDevice').append(new Option(device.label||`Microphone ${index+1} (allow access to see its name)`,device.deviceId));
    });
    if(previous&&[...$('micDevice').options].some(option=>option.value===previous))$('micDevice').value=previous;
    else{
      const physical=microphones.filter(d=>!['','default','communications'].includes(d.deviceId)&&!/camo|virtual|stereo mix|loopback|cable/i.test(d.label));
      const preferred=physical.find(d=>/headset|usb/i.test(d.label))||physical.find(d=>/realtek|microphone array|built.in|internal/i.test(d.label));
      if(preferred)$('micDevice').value=preferred.deviceId;
    }
    if(!microphones.length)$('activeMic').textContent='No microphone is exposed by this browser. Check permissions, or open the app in Chrome / Edge.';
  }catch(_){$('activeMic').textContent='Could not list microphones. Check browser and Windows microphone permissions.';}
}
$('refreshMics').addEventListener('click',refreshMicrophones);
$('micDevice').addEventListener('change',()=>{try{localStorage.setItem('gd-arena-microphone',$('micDevice').value);}catch(_){}$('activeMic').textContent='Selected: '+$('micDevice').selectedOptions[0].textContent;});
navigator.mediaDevices?.addEventListener?.('devicechange',refreshMicrophones);

function shareVoiceResult(text, language, completion){
  if(!completion.autoShare || language==='hi-IN'){openPanel('discussion',false);return;}
  if(!state.active || state.paused || state.busy || state.voiceBusy || listening || state.voiceSessionId!==state.sessionId)return;
  if(state.voiceDraftBefore){openPanel('discussion',false);voiceStatus('Transcript added to your existing draft. Review it, then share your point.');return;}
  if(words(text)<3 || /[\u0900-\u097f]/.test(text)){
    openPanel('discussion',false);voiceStatus('Transcript ready. Review or add a few English words, then share your point.');return;
  }
  voiceStatus('Pause detected. Sharing your point…');
  $('argumentForm').requestSubmit();
}

function configureVoice(){
  refreshMicrophones();
  partnerFlow=new window.PartnerTurnFlow({
    cancelPlayback,
    canContinue:()=>state.active&&!state.paused&&!document.hidden,
    onActive:active=>{state.replying=active;syncControls();},
    onReply:reply=>{
      if(reply.point_id&&!state.used.includes(reply.point_id))state.used.push(reply.point_id);
      addMessage({kind:'partner',name:reply.name,partner:reply.id,text:reply.text,point_id:reply.point_id});
      $('messageCount').textContent=`${state.messages.filter(m=>m.kind!=='moderator').length} contributions`;
    },
    play:reply=>$('voiceEnabled').checked?speakReply(reply):Promise.resolve(true),
    listen:()=>{
      if(!$('autoFlow').checked||!$('autoShare').checked||!$('voiceEnabled').checked||!speechReady||state.language==='hi-IN')return;
      voiceStatus('Your turn. The microphone is starting again…');startMic();
    }
  });
  voice = new LocalVoice({
    onDevice: (label,id) => {$('activeMic').textContent='Recording input: '+label;if(id){try{localStorage.setItem('gd-arena-microphone',id);}catch(_){}if([...$('micDevice').options].some(o=>o.value===id))$('micDevice').value=id;}},
    onDevicesChanged: refreshMicrophones,
    onPhase: phase => {listening=phase==='recording';state.voiceBusy=['requesting','transcribing'].includes(phase);$('recordingMeter').hidden=!listening;syncControls();},
    onStatus: voiceStatus,
    onReady: shareVoiceResult,
    onHelp: visible => {$('micHelp').hidden=!visible;},
    onLevel: level => {$('audioLevel').value=level;},
    onText: (text,language) => {openPanel('discussion',false);$('captionSpeaker').textContent='Your words';$('captionText').textContent=text;const field=language==='hi-IN'?$('speechDraft'):$('argument');field.value=[field.value.trim(),text].filter(Boolean).join(' ').slice(0,5000);$('englishReviewed').checked=false;$('wordCounter').textContent=`${words($('argument').value)} words`;}
  });
  function applyStatus(info){state.info.speech=info;speechReady=info.ready;$('speechEngine').textContent=info.ready?'Local voice ready':info.message;syncControls();}
  applyStatus(state.info.speech);
  if(!speechReady&&state.info.speech.state==='loading'){
    let tries=0;
    speechPoll=setInterval(async()=>{try{const response=await fetch('api/speech');const info=await response.json();applyStatus(info);if(info.state!=='loading'||++tries>60)clearInterval(speechPoll);}catch(_){clearInterval(speechPoll);}},1500);
  }
}
$('uploadAudioBtn').addEventListener('click',()=>{$('audioFile').click();});
$('audioFile').addEventListener('change',()=>{const file=$('audioFile').files[0];$('audioFile').value='';if(!state.active||state.paused||state.busy||state.voiceBusy)return;cancelSpeech();voice?.upload(file,state.language);});
$('autoFlow').addEventListener('change',()=>{if($('autoFlow').checked){$('autoShare').checked=true;$('voiceEnabled').checked=true;syncSound();voiceStatus('Automatic turns on. Press Speak once: you → Aanya → Kabir → Riya → you.');}else{cancelSpeech();abortMic();voiceStatus('Automatic turns off. Press Speak whenever you are ready.');}});
$('cancelVoiceBtn').addEventListener('click',()=>{cancelSpeech();abortMic();voiceStatus('Recording or transcription cancelled. Your text is unchanged.');});

async function initialize(){try{const response=await fetch('api/topics');if(!response.ok)throw new Error('Could not connect to the model. Restart the Python app and reload this page.');state.info=await response.json();configureVoice();renderTopics();selectedPreview();setLanguage();$('startBtn').disabled=false;$('connection').replaceChildren(node('i'),document.createTextNode('Trained model connected'));$('modelAccuracy').textContent=(state.info.model.public_accuracy*100).toFixed(1)+'%';if(!window.speechSynthesis){$('voiceEnabled').checked=false;$('voiceEnabled').disabled=true;$('voiceEnabled').closest('label').querySelector('small').textContent='Playback is unavailable in this browser';}syncSound();}catch(cause){$('connection').classList.add('failed');$('connection').replaceChildren(node('i'),document.createTextNode('Model unavailable'));$('topicGrid').replaceChildren(node('p','muted','Start the Python app, then reload this page.'));error(cause.message);}}
let panel = null;
let camera = null;
function openPanel(name, focus = true) {
  panel = name;
  $('roomPanel').hidden = false;
  $('roomView').classList.add('panel-open');
  $('panelTitle').textContent = {discussion:'Discussion',insights:'Your feedback',devices:'Devices'}[name];
  for (const key of ['discussion','insights','devices']) {
    $(key+'Panel').hidden = key !== name;
    $(key+'Tab').setAttribute('aria-pressed',String(key===name));
    $(key+'Btn').setAttribute('aria-expanded',String(key===name));
  }
  if (focus) $('closePanel').focus();
  if (name === 'discussion') $('transcript').scrollTop = $('transcript').scrollHeight;
}
function closePanel(focus = true) {
  const previous = panel;
  panel = null;
  $('roomPanel').hidden = true;
  $('roomView').classList.remove('panel-open');
  for (const key of ['discussion','insights','devices']) $(key+'Btn').setAttribute('aria-expanded','false');
  if (focus && previous) $(previous+'Btn').focus();
}
function updateCaption(message) {
  $('captionSpeaker').textContent = message.kind==='moderator'?'Your opening':message.name+(message.kind==='partner'?' · prepared perspective':'');
  $('captionText').textContent = message.kind==='moderator'?'Share your view, give a reason, and let the conversation begin.':message.text;
  document.querySelectorAll('.participant.latest').forEach(tile=>tile.classList.remove('latest'));
  if (message.kind!=='moderator') $('participant-'+(message.partner||'you'))?.classList.add('latest');
}
function syncCameraControls() {
  const phase = camera?.phase || 'off';
  $('cameraBtn').disabled = !state.active || state.paused;
  $('cameraBtn').setAttribute('aria-pressed',String(phase==='on'));
  $('cameraBtn').querySelector('span').textContent = phase==='requesting'?'Cancel camera':phase==='on'?'Stop camera':'Start camera';
  $('cameraDevice').disabled = phase==='requesting';
  $('cameraBadge').textContent = phase==='requesting'?'Waiting for camera…':phase==='on'?'Local preview':'Camera off';
  $('localVideo').hidden = phase!=='on';
  $('participant-you').classList.toggle('camera-on',phase==='on');
}
async function refreshCameras() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  try {
    const previous = $('cameraDevice').value;
    const devices = (await navigator.mediaDevices.enumerateDevices()).filter(device=>device.kind==='videoinput');
    $('cameraDevice').replaceChildren(new Option('System default camera',''));
    devices.filter(device=>device.deviceId).forEach((device,index)=>$('cameraDevice').append(new Option(device.label||`Camera ${index+1}`,device.deviceId)));
    if ([...$('cameraDevice').options].some(option=>option.value===previous)) $('cameraDevice').value = previous;
  } catch (_) { /* Listing devices must never block the discussion. */ }
}
camera = new window.LocalCamera($('localVideo'), {
  onState: phase => {syncCameraControls();if(phase==='on')refreshCameras();},
  onError: message => {$('cameraStatus').textContent=message;$('cameraStatus').hidden=false;}
});
$('cameraBtn').addEventListener('click',()=>{
  if(!state.active||state.paused)return;
  $('cameraStatus').hidden=true;
  if(camera.phase!=='off')camera.stop();else camera.start($('cameraDevice').value);
});
$('cameraDevice').addEventListener('change',()=>{
  if(camera.phase==='on'&&state.active&&!state.paused)camera.start($('cameraDevice').value);
});
$('refreshCameras').addEventListener('click',refreshCameras);
navigator.mediaDevices?.addEventListener?.('devicechange',refreshCameras);
refreshCameras();
for(const name of ['discussion','insights','devices']) {
  $(name+'Btn').addEventListener('click',()=>panel===name?closePanel():openPanel(name));
  $(name+'Tab').addEventListener('click',()=>openPanel(name,false));
}
$('closePanel').addEventListener('click',()=>closePanel());
document.addEventListener('keydown',event=>{if(event.key==='Escape'&&panel&&!$('leaveDialog').open)closePanel();});
initialize();
