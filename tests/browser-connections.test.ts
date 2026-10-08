import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BrowserConnections } from '../extension/browser-connections.ts';
const gate = () => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; };
function fixture() {
  const attached = new Set<number>(), calls: any[] = [];
  const api = {
    async attach(target: { tabId?: number }) { calls.push(['attach', target.tabId]); attached.add(target.tabId!); },
    async detach(target: { tabId?: number }) { calls.push(['detach', target.tabId]); attached.delete(target.tabId!); },
    async sendCommand(target: { tabId?: number }, method: string) { assert.ok(attached.has(target.tabId!)); calls.push([method, target.tabId]); return { value: method }; },
  };
  const connections = new BrowserConnections(api as any);
  return { api, connections, calls, attached };
}
test('chat cleanup preserves other and shared debugger owners, and disconnect cleans everything', async () => {
  const { connections: c, attached, calls } = fixture(); const a = c.scope('A'), b = c.scope('B');
  await c.attach(1, a); await c.attach(2, b); await c.attach(3, a); await c.attach(3, b);
  await c.release('A'); assert.deepEqual([...attached], [2, 3]);
  await assert.rejects(c.command(3, a, 'Runtime.evaluate'), /cancelled/);
  assert.equal((await c.command(3, b, 'Runtime.evaluate')).value, 'Runtime.evaluate');
  const retry = c.scope('A'); assert.notEqual(retry, a); await c.attach(1, retry);
  await c.release(); assert.equal(attached.size, 0); assert.equal(calls.filter(c => c[0] === 'detach').length, 4);
  await assert.rejects(c.attach(2, b), /cancelled/);
});
test('cleanup during real attach waits for that attachment then prevents its commands and permits an explicit retry', async () => {
  const { connections: c, api, attached, calls } = fixture(); const pending = gate(), entered = gate();
  const attach = api.attach.bind(api); api.attach = async target => { entered.release(); await pending.promise; await attach(target); };
  const scope = c.scope('A'), result = c.attach(1, scope).then(() => '', e => e.message);
  await entered.promise; const released = c.release('A'); const retry = c.scope('A');
  const next = c.attach(1, retry); pending.release();
  assert.match(await result, /cancelled/); await released; await next;
  assert.deepEqual(calls.map(c => c[0]), ['attach', 'detach', 'attach', 'Page.enable', 'Runtime.enable']);
  assert.ok(attached.has(1)); await c.release('A'); assert.equal(attached.size, 0);
});
test('a released owner cannot dispatch a follow-up after its shared-tab command returns', async () => {
  const { connections: c, api, attached } = fixture(); const a = c.scope('A'), b = c.scope('B');
  await c.attach(1, a); await c.attach(1, b); const pending = gate(), entered = gate(); const send = api.sendCommand.bind(api);
  api.sendCommand = async (target, method) => { if (method === 'Runtime.evaluate') { entered.release(); await pending.promise; } return send(target, method); };
  const result = c.command(1, a, 'Runtime.evaluate').then(() => '', e => e.message); await entered.promise;
  await c.release('A'); assert.ok(attached.has(1)); pending.release(); assert.match(await result, /cancelled/);
  assert.equal((await c.command(1, b, 'Runtime.evaluate')).value, 'Runtime.evaluate'); await c.release();
});
test('failed attach or initialization is not cached and retains no debugger attachment', async () => {
  const { connections: c, api, attached } = fixture(); const scope = c.scope('A'), send = api.sendCommand.bind(api);
  api.sendCommand = async (target, method) => { if (method === 'Page.enable') throw Error('Initialization failed'); return send(target, method); };
  await assert.rejects(c.attach(1, scope), /Initialization failed/); assert.equal(attached.size, 0);
  api.sendCommand = send; await c.attach(1, scope); assert.ok(attached.has(1));
  const attach = api.attach.bind(api); api.attach = async () => { throw Error('Debugger unavailable'); };
  await assert.rejects(c.attach(2, scope), /Debugger unavailable/); api.attach = attach; await c.attach(2, scope); await c.release(); assert.equal(attached.size, 0);
});
