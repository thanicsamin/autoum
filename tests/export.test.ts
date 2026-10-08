import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ChatExports } from '../host/exports.ts';
import { loadChatExport } from '../extension/export.ts';

test('chat export remains one consistent snapshot when titles and messages change between chunks', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'autoum-export-'));
  process.env.AUTOUM_DATA_DIR = join(directory, 'agent'); process.env.AUTOUM_ARTIFACTS_DIR = join(directory, 'artifacts');
  process.env.AUTOUM_DISABLE_ACCOUNT_DETECTION = '1'; process.env.AUTOUM_DISABLE_USAGE_NETWORK = '1';
  const { AgentHost } = await import('../host/agent.ts');
  const host = new AgentHost({ send() {} } as any);
  try {
    await host.init(); const chat = host.settings.chats[0];
    chat.title = 'Original title'; chat.messages = [{ role: 'assistant', text: '🙂 \\ " \n'.repeat(70000) }];
    const first = await host.handle('export_data', { offset: 0 });
    chat.title = 'A much longer replacement title shifts every subsequent JSON character';
    chat.messages[0].text = 'REPLACED HISTORY';
    chat.messages.push({ role: 'user', text: 'Arrived during export' });
    const chunks = [first.text]; let offset = first.next;
    while (offset !== null) {
      const chunk = await host.handle('export_data', { offset, exportId: first.exportId });
      assert.ok(Buffer.byteLength(JSON.stringify({ reply: 'fixture', data: chunk })) < 1000000);
      chunks.push(chunk.text); offset = chunk.next;
    }
    const exported = JSON.parse(chunks.join(''));
    assert.equal(exported.chats[0].title, 'Original title');
    assert.equal(exported.chats[0].messages.length, 1);
    assert.equal(exported.chats[0].messages[0].text, '🙂 \\ " \n'.repeat(70000));
    const latest = JSON.parse(await loadChatExport((type, data) => host.handle(type, data)));
    assert.equal(latest.chats[0].title, chat.title); assert.equal(latest.chats[0].messages.length, 2);
    assert.doesNotMatch(JSON.stringify(host.state()), new RegExp(first.exportId), 'snapshot IDs and caches are private to the export request');
  } finally { await host.close(); await rm(directory, { recursive: true, force: true }); }
});

test('exports isolate concurrent readers, validate offsets and release on completion/cancel/shutdown', () => {
  const exports = new ChatExports();
  const payload = (title: string) => ({ folders: [], chats: [{ title, messages: [{ text: 'x'.repeat(250000) }] }] });
  try {
    const first = exports.read({}, () => payload('First')), second = exports.read({}, () => payload('Second'));
    assert.notEqual(first.exportId, second.exportId);
    assert.throws(() => exports.read({}, () => payload('Third')), /Finish/);
    for (const offset of [-1, 0.5, NaN, Infinity, '100000', first.total + 1]) assert.throws(() => exports.read({ offset, exportId: first.exportId } as any, () => { throw Error('Must not rebuild.'); }), /offset/);
    assert.throws(() => exports.read({ offset: 100000 }, () => payload('Invalid')), /Start/);
    assert.throws(() => exports.read({ exportId: 'missing' }, () => payload('Invalid')), /expired/);
    assert.equal(exports.cancel(second.exportId), true); assert.equal(exports.cancel(second.exportId), false);
    assert.throws(() => exports.read({ exportId: second.exportId }, () => payload('Invalid')), /expired/);
    const chunks = [first.text]; let offset = first.next;
    while (offset !== null) { const chunk = exports.read({ offset, exportId: first.exportId }, () => { throw Error('Must not rebuild.'); }); chunks.push(chunk.text); offset = chunk.next; }
    assert.deepEqual(JSON.parse(chunks.join('')), payload('First'));
    assert.throws(() => exports.read({ exportId: first.exportId }, () => payload('Invalid')), /expired/);
    assert.ok(exports.read({}, () => payload('Third')).next);
    exports.close(); exports.close(); assert.throws(() => exports.read({}, () => payload('Invalid')), /closed/);
  } finally { exports.close(); }
});

test('abandoned export snapshots expire, while active reads renew their inactivity timeout', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const exports = new ChatExports(100), payload = () => ({ folders: [], chats: [{ text: 'x'.repeat(250000) }] });
  try {
    const first = exports.read({}, payload); t.mock.timers.tick(99);
    const next = exports.read({ offset: first.next!, exportId: first.exportId }, payload); t.mock.timers.tick(99);
    const final = exports.read({ offset: next.next!, exportId: first.exportId }, payload); assert.equal(final.next, null);
    const abandoned = exports.read({}, payload); t.mock.timers.tick(100);
    assert.throws(() => exports.read({ exportId: abandoned.exportId }, payload), /expired/);
    assert.ok(exports.read({}, payload).next);
  } finally { exports.close(); }
});

test('export loader rejects stalled/truncated/changed chunks and cancels its snapshot instead of downloading broken JSON', async () => {
  for (const chunk of [
    { text: '', total: 2, next: 0 }, { text: '{}', total: 3, next: null }, { text: '{}', total: 2, next: 2 }, { text: '{!', total: 2, next: null }, { text: '{}', total: 2, next: null }, { text: 5, total: 2, next: null },
  ]) {
    const seen: any[] = [];
    await assert.rejects(loadChatExport(async (type, data) => { seen.push({ type, data }); return { exportId: 'private-fixture', ...chunk }; }));
    assert.equal(seen.length, 2); assert.equal(seen[1].type, 'export_cancel'); assert.equal(seen[1].data.exportId, 'private-fixture');
  }
  for (const replacement of [{ exportId: 'different', total: 2 }, { exportId: 'original', total: 3 }]) {
    let reads = 0, cancelled = '';
    await assert.rejects(loadChatExport(async (type, data) => {
      if (type === 'export_cancel') { cancelled = data.exportId; return {}; }
      return ++reads === 1 ? { exportId: 'original', text: '{', total: 2, next: 1 } : { ...replacement, text: '}', next: null };
    }), /changed/);
    assert.equal(reads, 2); assert.equal(cancelled, 'original');
  }
});
