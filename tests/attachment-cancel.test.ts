import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const directory = await mkdtemp(join(tmpdir(), 'autoum-attachment-cancel-'));
process.env.AUTOUM_DATA_DIR = join(directory, 'agent'); process.env.AUTOUM_ARTIFACTS_DIR = join(directory, 'artifacts');
const { Attachments, attachmentTool } = await import('../host/attachments.ts');
after(() => rm(directory, { recursive: true, force: true }));

for (const boundary of ['start', 'chunk', 'finish'] as const) test(`cancelled assistant attachment at ${boundary} never appears later, and separate retry works`, async () => {
  const chat = { id: crypto.randomUUID(), cwd: directory, attachments: [] as any[], messages: [] as any[] };
  let saves = 0, states = 0;
  const host: any = { record: (id: string) => { assert.equal(id, chat.id); return chat; }, save: async () => { saves++; }, state: () => { states++; } };
  host.attachments = new Attachments(host);
  const attachments = host.attachments as InstanceType<typeof Attachments>, original = attachments[boundary].bind(attachments);
  let markReady!: () => void, release!: () => void;
  const ready = new Promise<void>(yes => { markReady = yes; }), gate = new Promise<void>(yes => { release = yes; });
  attachments[boundary] = async (...args: any[]) => {
    if (boundary === 'finish') { markReady(); await gate; return (original as any)(...args); }
    const result = await (original as any)(...args); markReady(); await gate; return result;
  };
  const tool = attachmentTool(host, chat.id), signal = new AbortController(), source = resolve('extension/icons/16.png');
  const stopped = Error('Stopped private attachment fixture');
  try {
    const pending = tool.execute('cancelled-file', { path: source, caption: 'Should never appear' }, signal.signal, undefined, {} as any).then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
    await ready; signal.abort(stopped); release();
    assert.equal((await pending).error, stopped, 'Stop must reject the original tool instead of displaying its attachment later');
    assert.equal(chat.attachments.length, 0); assert.equal(chat.messages.length, 0); assert.equal(saves, 0); assert.equal(states, 0);
    assert.deepEqual(await readdir(join(process.env.AUTOUM_ARTIFACTS_DIR!, chat.id, 'attachments')), []);
    attachments[boundary] = original as any;
    await assert.rejects(tool.execute('already-cancelled', { path: source }, signal.signal, undefined, {} as any), error => error === stopped);
    await tool.execute('separate-retry', { path: source, caption: 'Separate retry' }, new AbortController().signal, undefined, {} as any);
    assert.equal(chat.attachments.length, 1); assert.equal(chat.messages.length, 1); assert.equal(chat.messages[0].text, 'Separate retry'); assert.equal(states, 1);
    assert.deepEqual(await readFile(chat.attachments[0].path), await readFile(source));
  } finally { release(); await attachments.close(); }
});
