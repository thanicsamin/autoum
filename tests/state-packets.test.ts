import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { NativeTransport } from '../host/protocol.ts';
const directory = await mkdtemp(join(tmpdir(), 'autoum-state-packets-'));
process.env.AUTOUM_DATA_DIR = join(directory, 'agent');
process.env.AUTOUM_ARTIFACTS_DIR = join(directory, 'artifacts');
process.env.AUTOUM_DISABLE_ACCOUNT_DETECTION = '1';
process.env.AUTOUM_DISABLE_USAGE_NETWORK = '1';
const { AgentHost } = await import('../host/agent.ts');

test('attachment-heavy histories cross the actual native bridge without duplicating private catalogs or losing stored history', async () => {
  const input = new PassThrough(), output = new PassThrough();
  const transport = new NativeTransport(input, output), host = new AgentHost(transport);
  try {
    await host.init(); output.read(); const original = host.settings.chats[0];
    host.settings.chats = Array.from({ length: 40 }, (_, index) => {
      const id = index ? crypto.randomUUID() : original.id;
      const attachments = Array.from({ length: 40 }, (_, n) => ({ id: crypto.randomUUID(), name: `diagram-${n}.png`, mimeType: 'image/png', size: 128000, path: join(directory, 'artifacts', id, 'attachments', crypto.randomUUID() + '-diagram.png') }));
      return { ...original, id, title: `Synthetic chat ${index}`, attachments, messages: Array.from({ length: 30 }, (_, n) => ({ role: n % 2 ? 'assistant' : 'user', text: 'λ🙂 untrusted "quoted" history. '.repeat(200), attachments: [attachments[n]] })) };
    });
    await host.save();
    const state = host.state(), wire = output.read();
    assert.ok(wire.readUInt32LE(0) < 1000000);
    const packet = JSON.parse(wire.subarray(4).toString('utf8')); assert.equal(packet.type, 'state');
    assert.ok(state.chats.every(c => c.attachments === undefined));
    assert.ok(state.chats[0].messages.length > 0);
    for (const visible of state.chats) {
      const saved = host.record(visible.id);
      assert.equal(saved.messages.length, 30); assert.equal(saved.attachments!.length, 40);
      assert.equal(visible.historyStart, saved.messages.length - visible.messages.length);
      assert.deepEqual(visible.messages, saved.messages.slice(visible.historyStart));
      for (const message of visible.messages) for (const attachment of message.attachments || []) assert.equal(host.attachments.get(saved.id, attachment.id), attachment);
    }
    const persisted = JSON.parse(await readFile(join(directory, 'agent/settings.json'), 'utf8'));
    assert.equal(persisted.chats.length, 40);
    assert.ok(persisted.chats.every((c: any) => c.messages.length === 30 && c.attachments.length === 40));
    const last = original.id;
    await host.handle('history_more', { chatId: last }); output.read();
    assert.ok(host.state().chats.find(c => c.id === last)!.messages.length > state.chats[0].messages.length);
  } finally {
    output.on('data', () => {}); await host.close(); transport.cancel(); input.destroy(); output.destroy(); await rm(directory, { recursive: true, force: true });
  }
});

test('history navigation avoids rewriting saved chats while actual chat switches remain persistent', async t => {
  const input = new PassThrough(), output = new PassThrough();
  const transport = new NativeTransport(input, output), host = new AgentHost(transport);
  try {
    await host.init(); output.read(); const first = host.settings.chats[0];
    first.messages = Array.from({ length: 60 }, (_, i) => ({ role: 'assistant', text: `Saved message ${i}` }));
    const second = host.newChat(); output.read(); await host.save();
    const save = t.mock.method(host, 'save');
    await host.handle('view_chat', { chatId: first.id }); output.read();
    assert.equal(save.mock.callCount(), 1, 'Changing chats persists the selected chat');
    const path = join(directory, 'agent/settings.json');
    const before = await stat(path), saved = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(saved.activeChatId, first.id);
    assert.deepEqual(saved.chats.find((c: any) => c.id === first.id).messages, first.messages);
    save.mock.resetCalls();
    for (const type of ['view_chat', 'history_more', 'history_newer', 'history_latest']) {
      await host.handle(type, { chatId: first.id }); output.read();
    }
    assert.equal(save.mock.callCount(), 0, 'A view-only request does not clone and save every chat');
    assert.equal((await stat(path)).mtimeMs, before.mtimeMs);
    assert.equal((await stat(path)).ino, before.ino, 'The saved file was not atomically replaced');
    await host.handle('view_chat', { chatId: second.id }); output.read();
    assert.equal(save.mock.callCount(), 1);
    assert.equal(JSON.parse(await readFile(path, 'utf8')).activeChatId, second.id);
    second.title = 'Queued title change'; const writing = host.save();
    save.mock.resetCalls(); await host.handle('view_chat', { chatId: second.id }); output.read();
    assert.equal(JSON.parse(await readFile(path, 'utf8')).chats.find((c: any) => c.id === second.id).title, second.title, 'A read still waits for an existing queued save');
    assert.equal(save.mock.callCount(), 0); await writing;
  } finally {
    output.on('data', () => {}); await host.close(); transport.cancel(); input.destroy(); output.destroy(); await rm(directory, { recursive: true, force: true });
  }
});

test('byte-limited history keeps paging backwards and can return to the latest replies', async () => {
  const input = new PassThrough(), output = new PassThrough();
  const transport = new NativeTransport(input, output), host = new AgentHost(transport);
  try {
    await host.init(); output.read(); const saved = host.settings.chats[0];
    for (const text of ['🙂'.repeat(8950), 'λ'.repeat(14000) + 'a'.repeat(1000), 'mixed']) {
      saved.messages = Array.from({ length: 120 }, (_, i) => ({ role: 'assistant', text: `Message ${i}: ` + (text === 'mixed' ? i < 70 ? 'Brief reply.' : '🙂'.repeat(8950) : text) }));
      await host.save();
      const initial = host.state().chats[0]; output.read();
      const older = (await host.handle('history_more', { chatId: saved.id })).chats[0]; output.read();
      assert.ok(older.historyStart < initial.historyStart, 'Load older must advance even when the initial window fills its byte budget');
      assert.ok(older.historyEnd < saved.messages.length, 'A capped older window announces that newer messages exist');
      assert.deepEqual(older.messages, saved.messages.slice(older.historyStart, older.historyEnd));
      let previous = older;
      while (previous.historyStart > 0) {
        const state = await host.handle('history_more', { chatId: saved.id });
        const wire = output.read(); assert.ok(wire.readUInt32LE(0) < 1000000);
        const current = state.chats[0];
        assert.ok(current.historyStart < previous.historyStart);
        assert.ok(current.historyEnd >= previous.historyStart, 'Older windows overlap or meet without skipping a message');
        assert.deepEqual(current.messages, saved.messages.slice(current.historyStart, current.historyEnd));
        previous = current;
      }
      const newer = (await host.handle('history_newer', { chatId: saved.id })).chats[0]; output.read();
      assert.ok(newer.historyEnd > previous.historyEnd);
      assert.ok(newer.historyStart <= previous.historyEnd, 'Newer windows never skip messages at the byte cap');
      saved.messages.push({ role: 'assistant', text: 'A new reply while reading history' });
      await host.save();
      const reading = host.state().chats[0]; output.read();
      assert.equal(reading.historyEnd, newer.historyEnd, 'New replies do not change a historical page');
      assert.equal(reading.historyTotal, 121);
      const latest = (await host.handle('history_latest', { chatId: saved.id })).chats[0]; output.read();
      assert.equal(latest.historyEnd, 121); assert.equal(latest.messages.at(-1)?.text, 'A new reply while reading history');
      assert.equal(saved.messages.length, 121, 'Paging preserves all saved messages');
      assert.deepEqual(JSON.parse(await readFile(join(directory, 'agent/settings.json'), 'utf8')).chats[0].messages, saved.messages);
      await host.handle('history_more', { chatId: saved.id }); output.read();
      let forward = host.state().chats[0]; output.read();
      while (forward.historyEnd < saved.messages.length) {
        const next = (await host.handle('history_newer', { chatId: saved.id })).chats[0]; output.read();
        assert.ok(next.historyEnd > forward.historyEnd);
        assert.ok(next.historyStart <= forward.historyEnd, 'Changing message sizes and the final page never leave a gap');
        forward = next;
      }
      await host.handle('history_latest', { chatId: saved.id }); output.read();
    }
  } finally {
    output.on('data', () => {}); await host.close(); transport.cancel(); input.destroy(); output.destroy(); await rm(directory, { recursive: true, force: true });
  }
});
