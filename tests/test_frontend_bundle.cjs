// An already-running older Python server only serves these original web URLs.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const web = path.join(__dirname,'../web');
const read = name => fs.readFileSync(path.join(web,name),'utf8').replace(/\r\n/g,'\n');
const html = read('index.html');
const oldRoutes = new Set(['app.js','voice.js','styles.css','favicon.svg']);
const assets = [...html.matchAll(/<(?:script|link)\b[^>]*(?:src|href)="([^"]+)"/g)].map(match=>match[1]);
assert.ok(assets.length >= 4);
for(const asset of assets) assert.ok(oldRoutes.has(asset), `Required asset unavailable on original server: ${asset}`);
const app = read('app.js');
const end = app.indexOf('// END BUNDLED CAMERA\n');
assert.ok(end > 0, 'Camera must load before the application initializes');
const bundle = app.slice(0,end);
assert.ok(bundle.includes(read('camera.js').trim()), 'Rebuild the bundle after camera edits');
const scope = {window:{}};
vm.runInNewContext(bundle,scope);
assert.equal(typeof scope.window.LocalCamera,'function');
const camera = new scope.window.LocalCamera({srcObject:null});
assert.equal(camera.phase,'off'); // No browser permission or device is needed to initialize.
assert.ok(read('styles.css').includes(read('meeting.css').trim()), 'Rebuild after meeting style edits');
new vm.Script(app);
console.log(JSON.stringify({passed:true,assets,legacy_server_compatible:true,camera_default:'off'}));
