import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { crc32 } from 'node:zlib';
import { optInAntigravity, prepareAntigravityRuntime } from '../host/antigravity-compat.ts';
import yauzl from 'yauzl';
function archive(entries: Record<string, string>) {
  const prefix = Buffer.from('Native executable prefix preserved\n');
  const locals: Buffer[] = [], directory: Buffer[] = []; let offset = prefix.length;
  for (const [name, text] of Object.entries(entries)) {
    const data = Buffer.from(text), filename = Buffer.from(name), local = Buffer.alloc(30), central = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50); local.writeUInt32LE(crc32(data), 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(filename.length, 26);
    central.writeUInt32LE(0x02014b50); central.writeUInt32LE(crc32(data), 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(filename.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, filename, data); directory.push(central, filename); offset += local.length + filename.length + data.length;
  }
  const central = Buffer.concat(directory), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(Object.keys(entries).length, 8); end.writeUInt16LE(Object.keys(entries).length, 10); end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([prefix, ...locals, central, end]);
}
const modulePath = 'google3/cloud/developer_experience/antigravity_extensions/acp_server/model_selection.py';
const source = 'def supports_third_party_models(client):\n  return client.is_jetbrains or client.is_zed or client.is_xcode\n\ndef account_entitlement():\n  return account_models\n' + '# Untouched documentation for model availability\n'.repeat(20);
const entries = async (bytes: Buffer) => new Promise<Record<string, string>>((yes, no) => yauzl.fromBuffer(bytes, { lazyEntries: true }, (error, zip) => {
  if (error || !zip) { no(error); return; } const output: Record<string, string> = {}; zip.on('error', no); zip.on('end', () => yes(output));
  zip.on('entry', entry => zip.openReadStream(entry, (error, stream) => { if (error || !stream) { no(error); return; } const chunks: Buffer[] = []; stream.on('data', c => chunks.push(c)); stream.on('error', no); stream.on('end', () => { output[entry.fileName] = Buffer.concat(chunks).toString(); zip.readEntry(); }); })); zip.readEntry();
}));
test('ACP compatibility adds only Autoum to the renderer opt-in, preserves original native bytes and removes stale bytecode', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'autoum-acp-adapter-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'connector.par'), original = archive({ [modulePath]: source, [modulePath + 'c']: 'stale bytecode', [modulePath.replace('model_selection.py', '__pycache__/model_selection.cpython-314.pyc')]: 'stale bytecode', 'other.py': 'untouched' });
  await writeFile(path, original); const expected = createHash('sha256').update(original).digest('hex');
  const output = await prepareAntigravityRuntime(path, expected), bytes = await readFile(output), files = await entries(bytes);
  assert.notEqual(output, path); assert.deepEqual(await readFile(path), original); assert.equal(bytes.length, original.length); assert.deepEqual(bytes.subarray(0, 34), original.subarray(0, 34));
  assert.equal(files['other.py'], 'untouched'); assert.equal(Object.keys(files).length, 2); assert.ok(files[modulePath].includes('client.name.lower() == "autoum-browser"')); assert.ok(files[modulePath].includes('return account_models'));
  assert.equal(await prepareAntigravityRuntime(path, expected), output); assert.deepEqual(await readFile(output), bytes);
  assert.equal(await prepareAntigravityRuntime(path, 'unrecognized-hash'), path);
});
test('ACP compatibility fails on a changed/duplicated renderer gate instead of broadening account access', () => {
  assert.throws(() => optInAntigravity('unexpected source'), /gate changed/); assert.throws(() => optInAntigravity(source + source), /gate changed/);
});
