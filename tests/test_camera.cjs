// Node-only lifecycle tests; no real camera is opened.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../web/camera.js'), 'utf8');
function fixture() {
  const log = {requests: [], stopped: 0, states: [], errors: []};
  const track = {readyState: 'live', stop() { log.stopped++; }, addEventListener(name, fn) { this[name] = fn; }};
  const stream = {getTracks: () => [track], getVideoTracks: () => [track]};
  const video = {srcObject: null, play: async () => {}};
  const scope = {window: {}, navigator: {mediaDevices: {getUserMedia: async constraints => { log.requests.push(constraints); return stream; }}}};
  vm.runInNewContext(source, scope);
  const camera = new scope.window.LocalCamera(video, {onState: phase => log.states.push(phase), onError: text => log.errors.push(text)});
  return {log, track, stream, video, scope, camera};
}
(async () => {
  let checks = 0, f = fixture();
  assert.equal(f.camera.phase, 'off'); assert.equal(f.log.requests.length, 0); checks++;
  await f.camera.start('laptop-camera');
  assert.equal(f.camera.phase, 'on'); assert.equal(f.video.srcObject, f.stream);
  assert.equal(f.log.requests[0].audio, false); assert.equal(f.log.requests[0].video.deviceId.exact, 'laptop-camera'); checks++;
  f.camera.stop(); assert.equal(f.log.stopped, 1); assert.equal(f.video.srcObject, null); assert.equal(f.camera.phase, 'off'); checks++;
  f.camera.stop(); assert.equal(f.log.stopped, 1); checks++;
  for (const name of ['NotAllowedError','NotFoundError','NotReadableError','OverconstrainedError','SecurityError']) {
    f = fixture(); f.scope.navigator.mediaDevices.getUserMedia = async () => { throw Object.assign(new Error(), {name}); };
    await f.camera.start(); assert.equal(f.camera.phase, 'off'); assert.equal(f.video.srcObject, null); assert.equal(f.log.errors.length, 1); checks++;
  }
  f = fixture(); let grant;
  f.scope.navigator.mediaDevices.getUserMedia = () => new Promise(resolve => {grant = resolve;});
  const pending = f.camera.start(); assert.equal(f.camera.phase,'requesting');
  f.camera.stop(); grant(f.stream); await pending;
  assert.equal(f.log.stopped,1); assert.equal(f.video.srcObject,null); assert.equal(f.camera.phase,'off'); checks++;
  f = fixture(); await f.camera.start(); f.track.ended();
  assert.equal(f.camera.phase,'off'); assert.equal(f.video.srcObject,null); assert.equal(f.log.stopped,1); assert.match(f.log.errors[0],/disconnected/); checks++;
  f = fixture(); f.video.play = async () => {throw new Error('play failed');}; await f.camera.start();
  assert.equal(f.camera.phase,'off'); assert.equal(f.log.stopped,1); assert.equal(f.video.srcObject,null); checks++;
  f = fixture(); let play;
  f.video.play = () => new Promise(resolve=>{play=resolve;});
  const playing = f.camera.start(); await new Promise(resolve=>setImmediate(resolve));
  f.camera.stop(); play(); await playing;
  assert.equal(f.camera.phase,'off'); assert.equal(f.video.srcObject,null); assert.equal(f.log.stopped,1); checks++;
  f = fixture(); f.scope.navigator.mediaDevices = undefined; await f.camera.start();
  assert.equal(f.camera.phase,'off'); assert.equal(f.log.requests.length,0); assert.equal(f.log.errors.length,1); checks++;
  console.log(JSON.stringify({passed:true,checks,physical_camera_tested:false}));
})().catch(error=>{console.error(error);process.exit(1);});
