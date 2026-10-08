import { test } from 'node:test';
import assert from 'node:assert/strict';

for (const provider of ['openai', 'openai-codex', 'anthropic', 'opencode', 'opencode-go', 'openrouter', 'antigravity']) {
  test(`${provider}: Stop during attachment preparation never dispatches or mutates history`, async () => {
    const { AgentHost } = await import('../host/agent.ts');
    const host = new AgentHost({ send() {} } as any); host.save = async () => {}; host.state = (() => ({})) as any;
    const chat: any = { id: 'private-send', provider, model: 'fixture', mode: 'ask', messages: [], requests: [], title: 'Private cancellation fixture' }; host.settings.chats = [chat];
    let started = false, release!: () => void, dispatches = 0;
    const gate = new Promise<void>(yes => { release = yes; });
    host.attachments.context = async () => { started = true; await gate; return { items: [], images: [], text: 'Untrusted attachment context.' }; };
    host.session = (async () => ({ prompt: async () => { dispatches++; }, steer: async () => { dispatches++; } })) as any;
    host.current(chat.id).agy = { prompt: async () => { dispatches++; }, cancel: async () => {}, close() {} } as any;
    const pending = host.send(chat.id, 'Stopped attached input');
    assert.equal(started, true); await host.stop(chat.id); release();
    const result = await pending; await new Promise(yes => setImmediate(yes));
    assert.equal(dispatches, 0); assert.deepEqual(result, { cancelled: true });
    assert.deepEqual(chat.messages, []); assert.deepEqual(chat.requests, []); assert.equal(chat.mode, 'ask');
    assert.equal(host.current(chat.id).busy, false); assert.equal(host.current(chat.id).error, '');
    await host.close();
  });
}

test('Stop supersedes a delayed attachment read error, while an unstopped error is still reported', async () => {
  const { AgentHost } = await import('../host/agent.ts');
  const host = new AgentHost({ send() {} } as any); host.save = async () => {}; host.state = (() => ({})) as any;
  const chat: any = { id: 'private-error', provider: 'opencode', model: 'fixture', mode: 'ask', messages: [], requests: [], title: 'Private cancellation fixture' }; host.settings.chats = [chat];
  let release!: () => void; const gate = new Promise<void>(yes => { release = yes; });
  const fileError = Error('The attachment changed before it could be read.');
  host.attachments.context = async () => { await gate; throw fileError; };
  const cancelled = host.send(chat.id, 'Stopped file read').then(value => ({ value }), error => ({ error }));
  await host.stop(chat.id); release();
  assert.deepEqual(await cancelled, { value: { cancelled: true } });
  await assert.rejects(host.send(chat.id, 'Report a real read error'), error => error === fileError);
  assert.deepEqual(chat.messages, []); assert.deepEqual(chat.requests, []); assert.equal(host.current(chat.id).busy, false);
  await host.close();
});
