import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { runInNewContext } from 'node:vm';
import { webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';

class Event {
  listeners = new Set<(...args: any[]) => any>();
  addListener = (listener: (...args: any[]) => any) => { this.listeners.add(listener); };
  removeListener = (listener: (...args: any[]) => any) => { this.listeners.delete(listener); };
  emit(...args: any[]) { return Promise.all([...this.listeners].map(listener => listener(...args))); }
}
class Port {
  name = 'autoum-ui'; sender = { id: 'fixture-extension', url: 'chrome-extension://fixture-extension/index.html' };
  onMessage = new Event(); onDisconnect = new Event(); packets: any[] = []; closed = false; failSend = false;
  postMessage(packet: any) { if (this.closed || this.failSend) throw Error('Port is disconnected'); this.packets.push(packet); }
}
const background = (await build({ entryPoints: ['extension/background.ts'], bundle: true, write: false, format: 'iife', platform: 'browser' })).outputFiles[0].text;
async function fixture() {
  const native = new Port(), ui = new Port(), onConnect = new Event(), timers = new Map<number, () => void>(); let nextTimer = 0;
  const chrome = { runtime: { id: 'fixture-extension', getURL: (path: string) => 'chrome-extension://fixture-extension/' + path, connectNative: () => native, onConnect, onInstalled: new Event() },
    debugger: { onDetach: new Event(), onEvent: new Event() }, tabs: { onCreated: new Event() },
    sidePanel: { setPanelBehavior: async () => {} }, commands: { onCommand: new Event() } };
  runInNewContext(background, { chrome, crypto: webcrypto, URL, setTimeout: (fn: () => void) => { timers.set(++nextTimer, fn); return nextTimer; }, clearTimeout: (id: number) => timers.delete(id) });
  await onConnect.emit(ui);
  await native.onMessage.emit({ reply: native.packets.at(-1).id, data: { chats: [] } });
  await Promise.resolve(); assert.equal(timers.size, 0);
  return { native, ui, timers };
}
test('extension native send failures release their pending timeout immediately', async () => {
  const { native, ui, timers } = await fixture(); native.failSend = true;
  await ui.onMessage.emit({ id: 'failed-send', type: 'state' });
  assert.equal(ui.packets.at(-1).reply, 'failed-send'); assert.match(ui.packets.at(-1).error, /disconnected/);
  assert.equal(timers.size, 0, 'A synchronous send failure must not leave a ten-minute timer or pending request');
});
test('a native reply arriving after the sidebar closes cannot reject the background event handler', async () => {
  const { native, ui, timers } = await fixture();
  const request = ui.onMessage.emit({ id: 'late-reply', type: 'state' });
  const sent = native.packets.at(-1); ui.closed = true; await ui.onDisconnect.emit();
  await native.onMessage.emit({ reply: sent.id, data: { chats: [] } });
  await assert.doesNotReject(request, 'Closed views should discard replies without an unhandled rejection');
  assert.equal(timers.size, 0);
});
test('sidebar calls reject when their extension port disconnects instead of remaining pending', async () => {
  const source = await readFile('extension/ui.tsx', 'utf8');
  const client = source.slice(source.indexOf('type Packet ='), source.indexOf('DOMPurify.addHook'));
  const helperImport = source.match(/^import .*PortRpc.*;$/m)?.[0] || '';
  const compiled = (await build({ stdin: { contents: helperImport + '\n' + client + '\nglobalThis.fixtureCall = call;', resolveDir: process.cwd() + '/extension', loader: 'ts' }, bundle: true, write: false, format: 'iife', platform: 'browser' })).outputFiles[0].text;
  const port = new Port(), timers = new Map<number, () => void>(); let nextTimer = 0;
  const context: any = { chrome: { runtime: { connect: () => port } }, crypto: webcrypto, setTimeout: (fn: () => void) => { timers.set(++nextTimer, fn); return nextTimer; }, clearTimeout: (id: number) => timers.delete(id) };
  runInNewContext(compiled, context);
  let settled = false; const request = context.fixtureCall('state').catch((error: Error) => { settled = true; assert.match(error.message, /disconnect/i); });
  port.closed = true; await port.onDisconnect.emit(); await Promise.resolve();
  assert.equal(settled, true, 'A disconnected worker must not leave Send, settings or uploads permanently awaiting a reply');
  await request; assert.equal(timers.size, 0);
});
