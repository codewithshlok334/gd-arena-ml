// Run with Node: node tests/test_voice.cjs (no dependencies, no real microphone).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../web/voice.js'), 'utf8');
const appSource = fs.readFileSync(path.join(__dirname, '../web/app.js'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
let checks = 0;

function fixture() {
  const log = {texts: [], ready: [], requests: [], statuses: [], stopped: 0};
  let now = 0, level = 0, frame = null;
  const stream = {getTracks: () => [{stop: () => log.stopped++}], getAudioTracks: () => []};
  class Recorder {
    static isTypeSupported() { return true; }
    constructor(stream, options) { this.state = 'inactive'; this.mimeType = options.mimeType; }
    start() { this.state = 'recording'; }
    stop() {
      this.state = 'inactive';
      this.ondataavailable?.({data: new Blob(['a'.repeat(1000)], {type: this.mimeType})});
      queueMicrotask(() => this.onstop?.());
    }
  }
  class AudioContext {
    state = 'running';
    resume() { return Promise.resolve(); }
    close() { return Promise.resolve(); }
    createAnalyser() { return {getFloatTimeDomainData: data => data.fill(level)}; }
    createMediaStreamSource() { return {connect() {}}; }
  }
  const scope = {
    window: {MediaRecorder: Recorder, AudioContext}, MediaRecorder: Recorder,
    navigator: {mediaDevices: {getUserMedia: async () => stream}}, Blob, AbortController,
    setTimeout, clearTimeout, setInterval, clearInterval, Date, Float32Array,
    performance: {now: () => now}, requestAnimationFrame: fn => { frame = fn; return 1; },
    cancelAnimationFrame: () => { frame = null; },
    fetch: async (url, options) => { log.requests.push({url, options}); return {ok: true, json: async () => ({text: 'Remote work saves commuting time.'})}; }
  };
  vm.runInNewContext(source, scope);
  const voice = new scope.window.LocalVoice({
    onPhase() {}, onLevel() {}, onHelp() {}, onStatus: text => log.statuses.push(text),
    onText: text => log.texts.push(text),
    onReady: (text, language, completion) => log.ready.push({text, language, completion, phase: voice.phase})
  });
  function audio(rms, duration) {
    level = rms;
    for (let t = 0; t < duration; t += 20) { now += 20; const next = frame; frame = null; next?.(); }
  }
  return {voice, log, scope, audio};
}

function shareFixture() {
  const state = {active: true, paused: false, busy: false, voiceBusy: false, sessionId: 7, voiceSessionId: 7, voiceDraftBefore: ''};
  const log = {submitted: 0, statuses: []};
  const scope = {state, listening: false, words: text => text.trim().split(/\s+/).length,
    openPanel: name => { log.panel = name; },
    voiceStatus: text => log.statuses.push(text), $: () => ({requestSubmit: () => log.submitted++})};
  const start = appSource.indexOf('function shareVoiceResult(');
  const end = appSource.indexOf('function configureVoice(', start);
  assert.ok(start >= 0 && end > start);
  vm.runInNewContext(appSource.slice(start, end), scope);
  return {state, log, share: scope.shareVoiceResult};
}

(async () => {
  let f = fixture();
  await f.voice.start('en-IN', '', {autoShare: true});
  f.audio(0, 5000); assert.equal(f.voice.phase, 'recording'); assert.equal(f.log.requests.length, 0);
  f.audio(0.05, 80); f.audio(0, 3000); assert.equal(f.voice.phase, 'recording'); checks++;
  f.audio(0.04, 1000); f.audio(0, 1200); assert.equal(f.voice.phase, 'recording');
  f.audio(0.04, 600); f.audio(0, 1980); assert.equal(f.voice.phase, 'recording'); checks++;
  f.audio(0, 40); await tick(); await tick();
  assert.equal(f.voice.phase, 'idle'); assert.equal(f.log.requests.length, 1);
  assert.equal(f.log.ready[0].completion.autoShare, true); assert.equal(f.log.ready[0].completion.reason, 'silence');
  assert.equal(f.log.ready[0].phase, 'idle'); assert.ok(f.log.stopped > 0);
  f.audio(0, 4000); assert.equal(f.log.requests.length, 1); checks++;

  f = fixture(); await f.voice.start('en-IN', '', {autoShare: false});
  f.audio(0.04, 1000); f.audio(0, 2020); await tick(); await tick();
  assert.equal(f.log.ready[0].completion.autoShare, false); checks++;
  f = fixture(); await f.voice.start('en-IN', '', {autoShare: true});
  f.voice.stop(); await tick(); await tick(); assert.equal(f.log.ready[0].completion.autoShare, false); checks++;

  f = fixture(); let finish;
  f.scope.fetch = () => new Promise(resolve => { finish = resolve; });
  await f.voice.start('en-IN', '', {autoShare: true}); f.audio(0.04, 1000); f.audio(0, 2020);
  await tick(); f.voice.cancel(); finish({ok: true, json: async () => ({text: 'Late words should never share.'})});
  await tick(); assert.equal(f.log.ready.length, 0); assert.equal(f.log.texts.length, 0); checks++;

  f = fixture(); f.scope.window.AudioContext = undefined;
  await f.voice.start('en-IN', '', {autoShare: true});
  assert.equal(f.voice.phase, 'recording'); assert.match(f.log.statuses.at(-1), /Automatic pause detection is unavailable/);
  f.voice.cancel(); checks++;

  let s = shareFixture(); s.share('Remote work saves commuting time.', 'en-IN', {autoShare: true});
  assert.equal(s.log.submitted, 1); checks++;
  for (const [text, language, completion, changes] of [
    ['Remote work saves time.', 'en-IN', {autoShare: false}, {}],
    ['Remote work saves time.', 'en-IN', {}, {}],
    ['Work saves time.', 'hi-IN', {autoShare: true}, {}],
    ['Yes.', 'en-IN', {autoShare: true}, {}],
    ['यह एक उदाहरण है', 'en-IN', {autoShare: true}, {}],
    ['Remote work saves time.', 'en-IN', {autoShare: true}, {voiceDraftBefore: 'Existing draft'}],
    ['Remote work saves time.', 'en-IN', {autoShare: true}, {paused: true}],
    ['Remote work saves time.', 'en-IN', {autoShare: true}, {active: false}],
    ['Remote work saves time.', 'en-IN', {autoShare: true}, {sessionId: 8}],
    ['Remote work saves time.', 'en-IN', {autoShare: true}, {busy: true}]
  ]) {
    s = shareFixture(); Object.assign(s.state, changes); s.share(text, language, completion);
    assert.equal(s.log.submitted, 0); checks++;
    if (!completion.autoShare || language==='hi-IN' || changes.voiceDraftBefore || text==='Yes.' || text.startsWith('यह')) assert.equal(s.log.panel, 'discussion');
  }
  console.log(JSON.stringify({passed: true, checks, physical_microphone_tested: false,
    coverage: ['Initial silence and brief noise ignored', 'Short pause and resumed speech do not stop',
      'Two-second silence stops once and releases mic', 'Auto-submit waits for idle', 'Review mode and manual stop',
      'Cancellation discards pending automatic turn', 'Manual fallback without AudioContext',
      'Auto-submit guards: upload, language review, existing draft, short text, pause, end, stale session, busy']}));
})().catch(error => { console.error(error); process.exit(1); });
