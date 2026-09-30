'use strict';
const { PROJECT_ROOT } = require("../src/paths");


const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(PROJECT_ROOT, "src/candidate-main.js"), 'utf8');

function extractFunction(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `missing ${name}`);
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    else if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`unterminated ${name}`);
}

const context = vm.createContext({
  shutdownStarted: false,
  win: null,
  rendererEntryUrl: 'file:///trusted/index.html',
  sameRendererLocation: (actual, expected) => actual === expected,
});
const helperSource = [
  extractFunction('isDestroyed'),
  extractFunction('getLiveMainWebContents'),
  extractFunction('sendToLiveRenderer'),
  extractFunction('assertTrustedRenderer'),
  'this.helpers = { getLiveMainWebContents, sendToLiveRenderer, assertTrustedRenderer };',
].join('\n');
vm.runInContext(helperSource, context);

const sent = [];
const normalSender = {
  isDestroyed: () => false,
  send: (...args) => sent.push(args),
};
assert.equal(context.helpers.sendToLiveRenderer(normalSender, 'progress', { completed: 1 }), true);
assert.deepEqual(sent, [['progress', { completed: 1 }]], 'normal renderer must receive progress');

let destroyedSendCalled = false;
const destroyedSender = {
  isDestroyed: () => true,
  send: () => { destroyedSendCalled = true; },
};
assert.equal(context.helpers.sendToLiveRenderer(destroyedSender, 'progress', {}), false);
assert.equal(destroyedSendCalled, false, 'destroyed renderer must not receive progress');

context.shutdownStarted = true;
let closingSendCalled = false;
assert.equal(context.helpers.sendToLiveRenderer({
  isDestroyed: () => false,
  send: () => { closingSendCalled = true; },
}, 'progress', {}), false);
assert.equal(closingSendCalled, false, 'closing application must ignore late progress');

context.shutdownStarted = false;
let checks = 0;
const racedSender = {
  isDestroyed: () => { checks += 1; return checks > 1; },
  send: () => { throw new Error('Object has been destroyed'); },
};
assert.equal(context.helpers.sendToLiveRenderer(racedSender, 'progress', {}), false, 'destroy/send race must be harmless');

let destroyedWindowContentsRead = false;
context.win = {
  isDestroyed: () => true,
  get webContents() {
    destroyedWindowContentsRead = true;
    throw new Error('Object has been destroyed');
  },
};
assert.equal(context.helpers.getLiveMainWebContents(), null);
assert.equal(destroyedWindowContentsRead, false, 'destroyed window must not expose webContents');
assert.throws(
  () => context.helpers.assertTrustedRenderer({}),
  (error) => /IPC/.test(error.message) && !/Object has been destroyed/.test(error.message),
  'IPC from a destroyed window must end with a controlled error',
);

const frame = { url: context.rendererEntryUrl };
const contents = { isDestroyed: () => false, mainFrame: frame };
context.win = { isDestroyed: () => false, webContents: contents };
assert.doesNotThrow(() => context.helpers.assertTrustedRenderer({ sender: contents, senderFrame: frame }));

assert.match(source, /stopServers\(\)\.then\(\(result\) => \{[\s\S]*?result\.action\.timed_out[\s\S]*?app\.exit\(1\)/,
  'startup failure must refuse parent exit while the action guardian is still stopping, then exit 1');
assert.match(source, /stopChild\(actionChild, 15_000, \{ forceKill: false \}\)/,
  'desktop shutdown must never timeout-kill the action-server recording guardian');
assert.match(source, /function beginGracefulShutdown\(\)[\s\S]*?stopServers\(\)\.then\(\(result\) => \{[\s\S]*?app\.exit\(result && result\.ok === false \? 1 : 0\)/,
  'normal shutdown must await an explicit action-server safety result');
assert.match(source, /sendToLiveRenderer\(event\.sender, 'assessment:import-progress', progress\)/);

console.log('check-pilot-opt-001 ok');
