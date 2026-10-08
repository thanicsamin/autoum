import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadMessageText } from '../extension/message-text.ts';

const directory = await mkdtemp(join(tmpdir(), 'autoum-message-text-'));
process.env.AUTOUM_DATA_DIR = join(directory, 'agent');
process.env.AUTOUM_ARTIFACTS_DIR = join(directory, 'artifacts');
process.env.AUTOUM_DISABLE_ACCOUNT_DETECTION = '1';
process.env.AUTOUM_DISABLE_USAGE_NETWORK = '1';
const { AgentHost } = await import('../host/agent.ts');

test('long reply previews preserve the beginning and complete text crosses the bridge in bounded chunks', async () => {
  const packets: any[] = [], host = new AgentHost({ send(packet: any) { packets.push(packet); } } as any);
  try {
    await host.init(); const chat = host.settings.chats[0];
    const text = '# Beginning of the full reply\n\n```js\nconst answer = 42;\n```\n\nMath: $x^2$.\n\n' + '🙂 \\ " \n'.repeat(80000) + '\nEnd of the full reply.';
    chat.messages.push({ role: 'assistant', text }); await host.save();
    const preview = host.state().chats[0].messages[0];
    assert.ok(preview.text.startsWith('# Beginning of the full reply'), 'The beginning of an answer must not disappear');
    assert.ok(preview.text.length >= 17999 && preview.text.length <= 18000);
    assert.equal((preview as any).textLength, text.length);
    assert.ok(Buffer.byteLength(JSON.stringify(packets.at(-1))) < 1000000);
    let offset = 0; const chunks: string[] = [];
    while (offset < text.length) {
      const chunk = await host.handle('message_text', { chatId: chat.id, index: 0, offset });
      assert.equal(chunk.total, text.length); assert.ok(Buffer.byteLength(JSON.stringify({ reply: 'fixture', data: chunk })) < 1000000);
      assert.equal(chunk.text, text.slice(offset, offset + 60000)); chunks.push(chunk.text);
      if (chunk.next === null) break;
      assert.equal(chunk.next, offset + chunk.text.length); offset = chunk.next;
    }
    assert.equal(chunks.join(''), text);
    assert.equal(await loadMessageText(chat.id, 0, (type, data) => host.handle(type, data)), text);
    assert.equal(JSON.parse(await readFile(join(directory, 'agent/settings.json'), 'utf8')).chats[0].messages[0].text, text);
    for (const data of [{ index: -1 }, { index: 1 }, { index: 0.5 }, { index: 0, offset: -1 }, { index: 0, offset: 0.5 }, { index: 0, offset: text.length + 1 }]) {
      await assert.rejects(host.handle('message_text', { chatId: chat.id, ...data }), /message|offset/i);
    }
    await assert.rejects(host.handle('message_text', { chatId: 'missing', index: 0 }), /not found/i);
    chat.messages[0].text = 'a'.repeat(17999) + '🙂 ending';
    assert.equal(host.state().chats[0].messages[0].text, 'a'.repeat(17999), 'The preview never cuts a Unicode surrogate pair in half');
  } finally { await host.close(); await rm(directory, { recursive: true, force: true }); }
});

test('complete-message reads fail on partial, stalled or changing responses instead of copying incomplete text', async () => {
  for (const chunk of [{ text: 'a', total: 2, next: null }, { text: '', total: 2, next: 0 }, { text: 'a', total: 1, next: 1 }, { text: 'a', total: -1, next: null }, { text: 5, total: 1, next: null }]) {
    await assert.rejects(loadMessageText('fixture', 0, async () => chunk), /changed|completely/);
  }
  let reads = 0;
  await assert.rejects(loadMessageText('fixture', 0, async () => ++reads === 1 ? { text: 'a', total: 2, next: 1 } : { text: 'bb', total: 3, next: null }), /changed/);
  assert.equal(reads, 2);
  assert.equal(await loadMessageText('fixture', 0, async () => ({ text: '', total: 0, next: null })), '');
});
