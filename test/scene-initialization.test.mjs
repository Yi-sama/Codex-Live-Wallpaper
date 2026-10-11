import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { prepareCodexScenePage } from '../src/codex-skin.mjs';

function protocol(t, targets, complete = true) {
  const calls = [];
  const sockets = [];
  const original = globalThis.WebSocket;
  const window = {};
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify(targets)));
  globalThis.WebSocket = class extends EventTarget {
    static OPEN = 1;
    constructor(url) {
      super();
      this.url = url;
      this.readyState = 1;
      sockets.push(this);
      queueMicrotask(() => this.dispatchEvent(new Event('open')));
    }
    send(raw) {
      const request = JSON.parse(raw);
      calls.push(request);
      let result = {};
      if (request.method === 'Page.addScriptToEvaluateOnNewDocument') {
        runInNewContext(request.params.source, { window });
        result = { identifier: 'initializer' };
      }
      if (request.method === 'Runtime.evaluate') {
        result = { result: { value: runInNewContext(request.params.expression, {
          window, location: { href: 'app://-/index.html' },
          document: { readyState: complete ? 'complete' : 'loading' },
        }) } };
      }
      queueMicrotask(() => {
        this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ id: request.id, result }) }));
        if (request.method === 'Page.reload') {
          this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ method: 'Page.loadEventFired' }) }));
        }
      });
    }
    close() { this.readyState = 3; }
  };
  t.after(() => { globalThis.WebSocket = original; });
  return { calls, sockets };
}

const target = { id: 'codex', type: 'page', url: 'app://-/index.html', webSocketDebuggerUrl: 'ws://127.0.0.1:4321/devtools/page/codex' };

test('Scene initialization sets permission before one reload and verifies the new document', async t => {
  const { calls, sockets } = protocol(t, [target, { ...target, id: 'other', url: 'https://example.com' }]);
  const result = await prepareCodexScenePage(4321);
  assert.equal(result.targetCount, 1);
  assert.equal(sockets.length, 1);
  assert.equal(sockets[0].url, target.webSocketDebuggerUrl);
  assert.equal(sockets[0].readyState, 3);
  const methods = calls.map(call => call.method);
  assert.equal(methods.filter(method => method === 'Page.reload').length, 1);
  assert.ok(methods.indexOf('Page.setBypassCSP') < methods.indexOf('Page.reload'));
  assert.ok(methods.indexOf('Page.addScriptToEvaluateOnNewDocument') < methods.indexOf('Page.reload'));
  assert.ok(methods.indexOf('Page.removeScriptToEvaluateOnNewDocument') > methods.indexOf('Runtime.evaluate'));
});

test('Scene initialization rejects unrelated targets and invalid ports without reloading', async t => {
  const { calls } = protocol(t, [{ ...target, url: 'app://-/index.html?login=1' }]);
  await assert.rejects(prepareCodexScenePage(0), /actual loopback/);
  await assert.rejects(prepareCodexScenePage(4321), /exact Codex main page/);
  assert.deepEqual(calls, []);
});

test('Scene initialization does not report success for an incomplete document', async t => {
  const { sockets } = protocol(t, [target], false);
  await assert.rejects(prepareCodexScenePage(4321), /expected Scene initialization document/);
  assert.equal(sockets[0].readyState, 3);
});
