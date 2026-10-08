import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Memory, memoryCover, memoryContext, memoryTool } from '../host/memory.ts';
async function fixture(t: any) { const directory = await mkdtemp(join(tmpdir(), 'autoum-memory-')); t.after(() => rm(directory, { recursive: true, force: true })); const memory = new Memory(directory); await memory.init(); return memory; }
async function compress(memory: Memory) { for (;;) { const pending = await memory.pending(); if (!pending) return; await memory.nap(pending.range, 'Verified preference summary ' + pending.range, pending.fingerprint); } }
test('OptMem cover targets the context budget with contiguous aligned age-biased ranges', () => {
  for (const count of [0, 1, 7, 31, 32, 33, 99, 1000, 1000000]) for (const budget of [1, 8, 32, 96]) {
    const ranges = memoryCover(count, budget); assert.equal(ranges.length, Math.min(count, Math.max(budget, count.toString(2).replace(/0/g, '').length)));
    let last = 0; for (const [a, b] of ranges) { assert.equal(a, last); assert.equal(a % (b - a), 0); assert.ok(Number.isInteger(Math.log2(b - a))); last = b; } assert.equal(last, count);
    if (ranges.length > 1) assert.ok(ranges[0][1] - ranges[0][0] >= ranges.at(-1)![1] - ranges.at(-1)![0]);
  }
});
test('memory persists UTF-8 fixed records, deduplicates, repairs trailing writes, and isolates credentials', async t => {
  const memory = await fixture(t); const note = await memory.note('Prefers 日本語 explanations 🧠'); assert.equal(note.entry.id, 0);
  assert.equal((await memory.note(note.entry.text)).duplicate, true);
  assert.equal((await stat(join(memory.directory, 'LOG.txt'))).size, 320);
  const restored = new Memory(memory.directory); assert.equal((await restored.entry(0)).text, note.entry.text);
  await writeFile(join(memory.directory, 'LOG.txt'), 'partial', { flag: 'a' }); await restored.note('Prefers concise explanations'); assert.equal((await stat(join(memory.directory, 'LOG.txt'))).size, 640);
  for (const text of ['two\nlines', 'x'.repeat(281), '🧠'.repeat(71), 'Bearer never-save-this', 'sk-fixturekey1234567890', '\u202ehidden']) await assert.rejects(memory.note(text));
  if (process.platform !== 'win32') assert.equal((await stat(join(memory.directory, 'LOG.txt'))).mode & 0o777, 0o600);
});
test('memory summaries are bounded, expandable and guarded against stale corrections/deletions', async t => {
  const memory = await fixture(t); for (let i = 0; i < 40; i++) await memory.note('User preference ' + i);
  assert.equal((await memory.wake(8)).complete, false); const pending = (await memory.pending())!;
  await assert.rejects(memory.nap(pending.range, 'Summary', 'wrong'), /changed/); await compress(memory);
  const wake = await memory.wake(8); assert.equal(wake.complete, true); assert.equal(wake.lines.length, 8); assert.ok((await memory.zoom('0-3')).lines.every(Boolean));
  await memory.deleteEntry(0); assert.equal((await memory.list('preference 0')).matches, 0); assert.equal((await memory.list()).count, 39);
  assert.ok(!(await readFile(join(memory.directory, 'LOG.txt'), 'utf8')).includes('User preference 0'));
  assert.equal((await memory.wake(8)).complete, false); await compress(memory);
  const edited = await memory.editEntry(1, 'Prefers clear diagrams'); assert.equal(edited.entry.id, 40); assert.equal((await memory.entry(1)).text, '[deleted]');
  assert.equal((await memory.list('clear diagrams')).matches, 1); await memory.forgetSummary('0-3'); assert.ok(await memory.pending());
  await assert.rejects(memory.zoom('100-103'), /beyond/); await memory.clear(); assert.equal((await memory.wake()).count, 0); assert.equal((await memory.list()).count, 0);
});
test('parallel stores serialize writes and stopped tools do not save memory', async t => {
  const memory = await fixture(t), other = new Memory(memory.directory);
  await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? memory : other).note('Preference ' + i))); assert.equal((await memory.list()).count, 20);
  const controller = new AbortController(); controller.abort(); const host: any = { memory, settings: {} };
  await assert.rejects(memoryTool(host).execute('test', { action: 'note', text: 'Cancelled preference' }, controller.signal, undefined, {} as any)); assert.equal((await memory.list('Cancelled')).matches, 0);
  assert.ok((await memoryContext(host)).includes('Preference')); host.settings.memoryEnabled = false; assert.equal(await memoryContext(host), '');
  await assert.rejects(memoryTool(host).execute('test', { action: 'note', text: 'Disabled preference' }, undefined, undefined, {} as any), /disabled/);
});
