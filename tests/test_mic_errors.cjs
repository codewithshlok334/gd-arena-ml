// Regression: only permission/security failures show the permission-help box.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../web/voice.js'), 'utf8');
function fixture() {
  const log = {help: false, texts: [], status: ''};
  const scope = {window: {MediaRecorder: class {}},
    navigator: {mediaDevices: {getUserMedia: async () => { throw Object.assign(new Error('blocked'), {name: 'NotAllowedError'}); }}},
    Blob, AbortController, TypeError, setTimeout, clearTimeout, clearInterval,
    fetch: async () => ({ok: true, json: async () => ({text: 'A usable English contribution.'})})};
  vm.runInNewContext(source, scope);
  const voice = new scope.window.LocalVoice({onPhase() {}, onLevel() {},
    onHelp: value => {log.help = value;}, onStatus: text => {log.status = text;}, onText: text => log.texts.push(text)});
  return {voice, log, scope};
}
(async () => {
  let checks = 0;
  for (const [name, expected] of [['NotAllowedError', true], ['SecurityError', true],
    ['NotFoundError', false], ['NotReadableError', false], ['OverconstrainedError', false]]) {
    const f = fixture(); f.scope.navigator.mediaDevices.getUserMedia = async () => {throw Object.assign(new Error(name), {name});};
    await f.voice.start('en-IN'); assert.equal(f.log.help, expected, name); assert.equal(f.voice.phase, 'idle'); checks++;
  }
  const clip = new Blob(['x'.repeat(1000)]);
  let f = fixture(); f.scope.fetch = async () => ({ok: false, json: async () => ({error: 'No microphone signal was captured.'})});
  await f.voice.upload(clip, 'en-IN'); assert.equal(f.log.help, false); assert.match(f.log.status, /No microphone signal/); checks++;
  f = fixture(); f.scope.fetch = async () => {throw new TypeError('Failed to fetch');};
  await f.voice.upload(clip, 'en-IN'); assert.equal(f.log.help, false); assert.match(f.log.status, /Could not reach the Python app/); checks++;
  f = fixture(); await f.voice.start('en-IN'); assert.equal(f.log.help, true);
  await f.voice.upload(clip, 'en-IN'); assert.equal(f.log.help, false); assert.equal(f.log.texts.length, 1); checks++;
  console.log(JSON.stringify({passed: true, checks, coverage: 'Permission, missing/busy/stale device, silent input, server connection and recovery'}));
})().catch(error => {console.error(error); process.exit(1);});
