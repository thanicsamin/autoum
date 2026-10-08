import assert from 'node:assert/strict';
import { mock } from 'node:test';
import * as fs from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const [mode, directory, root] = process.argv.slice(2);
let calls = 0;
let markOpen, releaseOpen;
const opening = new Promise(resolve => { markOpen = resolve; });
const released = new Promise(resolve => { releaseOpen = resolve; });
mock.module('node:fs/promises', { namedExports: { ...fs, open: async (path, flags, ...options) => {
  if (mode === 'cancel' && String(path).startsWith(directory + sep) && String(path).endsWith('.upload') && flags !== 'r') { markOpen(); await released; }
  const file = await fs.open(path, flags, ...options);
  if (String(path).startsWith(directory + sep) && String(path).endsWith('.upload') && flags !== 'r') {
    const write = file.write.bind(file);
    file.write = async (buffer, offset = 0, length = buffer.length - offset, position = null) => {
      calls++;
      if (mode === 'zero') return { bytesWritten: 0, buffer };
      if (mode === 'error' && calls > 1) throw Object.assign(Error('Private fixture disk failure'), { code: 'EIO' });
      return write(buffer, offset, ['short', 'error'].includes(mode) ? Math.min(16, length) : length, position);
    };
  }
  return file;
} } });
const { Attachments } = await import(pathToFileURL(resolve(root, 'host/attachments.ts')).href);
const chat = { id: 'fixture', attachments: [], messages: [] }; let saves = 0;
const uploads = new Attachments({ record: id => { assert.equal(id, chat.id); return chat; }, save: async () => { saves++; } });
const bytes = await fs.readFile(join(root, 'extension/icons/16.png'));
try {
  const { id } = await uploads.start(chat.id, { name: 'fixture.png', mimeType: 'image/png', size: bytes.length });
  const input = { id, offset: 0, data: bytes.toString('base64') };
  if (mode === 'cancel') {
    const pending = uploads.chunk(chat.id, input).then(result => ({ result }), error => ({ error }));
    await opening; await uploads.cancel(chat.id, id); releaseOpen();
    assert.match((await pending).error?.message || '', /expired|cancel|again/i);
    assert.equal(chat.attachments.length, 0); assert.equal(saves, 0);
  } else if (['zero', 'error'].includes(mode)) {
    await assert.rejects(uploads.chunk(chat.id, input), /saved|written|again/i);
    await assert.rejects(uploads.chunk(chat.id, input), /expired/i);
    assert.equal(chat.attachments.length, 0); assert.equal(saves, 0);
  } else {
    if (mode === 'short') {
      for (let offset = 0; offset < bytes.length; offset += 300) {
        const end = Math.min(offset + 300, bytes.length);
        assert.equal((await uploads.chunk(chat.id, { id, offset, data: bytes.subarray(offset, end).toString('base64') })).received, end);
      }
    } else assert.equal((await uploads.chunk(chat.id, input)).received, bytes.length);
    if (mode === 'truncated') {
      const folder = join(process.env.AUTOUM_ARTIFACTS_DIR, chat.id, 'attachments');
      const staged = (await fs.readdir(folder)).find(name => name.endsWith('.upload'));
      await fs.writeFile(join(folder, staged), bytes.subarray(0, 16));
      await assert.rejects(uploads.finish(chat.id, id), /incomplete|changed|again/i);
      assert.equal(chat.attachments.length, 0); assert.equal(saves, 0);
    } else {
      const item = await uploads.finish(chat.id, id), actual = await fs.readFile(item.path);
      assert.equal(actual.length, bytes.length, 'short writes must be completed before accepting an attachment');
      assert.deepEqual(actual, bytes); assert.equal(saves, 1); assert.ok(calls > 1);
    }
  }
  const folder = join(process.env.AUTOUM_ARTIFACTS_DIR, chat.id, 'attachments');
  assert.equal((await fs.readdir(folder)).filter(name => name.endsWith('.upload')).length, 0, 'failed uploads must not leave staging files');
  console.log(JSON.stringify({ mode, actualWriteCalls: calls, complete: true }));
} finally { await uploads.close(); }
