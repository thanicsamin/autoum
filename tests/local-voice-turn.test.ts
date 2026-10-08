import test from 'node:test';
import assert from 'node:assert/strict';
import { localVoiceTurn } from '../extension/voice-turn.js';
function fixture() {
  const listeners = new Set<(packet: any) => void>();
  const port = { onMessage: { addListener: (fn: any) => listeners.add(fn), removeListener: (fn: any) => listeners.delete(fn) } } as unknown as chrome.runtime.Port;
  const broadcast = (state: any) => { for (const fn of [...listeners]) fn({ type: 'state', data: state }); };
  const state = (busy: boolean, text = 'old reply', error = '') => ({ chats: [{ id: 'chat', busy, error, messages: [{ role: 'assistant', text }] }] });
  return { listeners, port, broadcast, state };
}
test('Local conversation waits for the selected model to finish, using broadcasts without polling', async () => {
  const f = fixture(), calls: string[] = [], controller = new AbortController(); let complete = false;
  const reply = localVoiceTurn('chat', 'question', true, async type => { calls.push(type); return type === 'send' ? { started: true } : f.state(true); }, f.port, controller.signal).then(text => { complete = true; return text; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(complete, false);
  f.broadcast({ chats: [{ id: 'other', busy: false }, ...f.state(true).chats] }); assert.equal(complete, false);
  f.broadcast(f.state(false, 'fresh reply')); assert.equal(await reply, 'fresh reply');
  assert.deepEqual(calls, ['send', 'state']); assert.equal(f.listeners.size, 0);
});
test('End voice stops its pending model turn and removes the state listener', async () => {
  const f = fixture(), calls: string[] = [], controller = new AbortController();
  const reply = localVoiceTurn('chat', 'question', true, async type => { calls.push(type); return type === 'send' ? { started: true } : f.state(true); }, f.port, controller.signal);
  await new Promise(resolve => setImmediate(resolve)); controller.abort(); await assert.rejects(reply, { name: 'AbortError' });
  assert.deepEqual(calls, ['send', 'state', 'stop']); assert.equal(f.listeners.size, 0);
  f.broadcast(f.state(false, 'late reply'));
});
test('Ending before send acknowledges dispatch still cancels the owned task', async () => {
  const f = fixture(), controller = new AbortController(), calls: string[] = []; let acknowledge!: (value: any) => void;
  const reply = localVoiceTurn('chat', 'question', true, async type => { calls.push(type); return type === 'send' ? new Promise(resolve => { acknowledge = resolve; }) : undefined; }, f.port, controller.signal);
  controller.abort(); acknowledge({ started: true }); await assert.rejects(reply, { name: 'AbortError' });
  assert.deepEqual(calls, ['send', 'stop']); assert.equal(f.listeners.size, 0);
});
test('Failed model turns do not read a previous assistant answer aloud', async () => {
  const f = fixture(), controller = new AbortController();
  const reply = localVoiceTurn('chat', 'question', true, async type => type === 'send' ? { started: true } : f.state(false, 'old reply', 'Quota exhausted'), f.port, controller.signal);
  await assert.rejects(reply, /Quota exhausted/); assert.equal(f.listeners.size, 0);
});

test('Empty turns never replay prior replies, and paginated history retains the fresh answer', async () => {
  for (const [messages, start, expected] of [
    [[{ role: 'assistant', text: 'old answer' }, { role: 'user', text: 'new question' }], 99, undefined],
    [[{ role: 'user', text: 'new question' }, { role: 'assistant', text: 'fresh answer' }], 120, 'fresh answer'],
  ] as const) {
    const f = fixture(), controller = new AbortController();
    const reply = await localVoiceTurn('chat', 'question', true, async type => type === 'send' ? { started: true } : { chats: [{ id: 'chat', busy: false, messages, historyStart: start }] }, f.port, controller.signal, 100);
    assert.equal(reply, expected); assert.equal(f.listeners.size, 0);
  }
});
