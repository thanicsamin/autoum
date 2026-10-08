import test from 'node:test';
import assert from 'node:assert/strict';
import { readPack, writePack } from '../scripts/data-pack.mjs';
import { brandText } from '../scripts/brand-browser.mjs';
test('DataPack round trips binary/text resources and aliases', () => {
  for (const encoding of [0, 1, 2]) {
    const resources = new Map([[3, Buffer.from('hello')], [9, Buffer.from([0, 255, 8])], [17, Buffer.from('hello')]]);
    const bytes = writePack({ encoding, resources }), restored = readPack(bytes);
    assert.equal(restored.encoding, encoding); assert.deepEqual(restored.resources, resources);
    assert.equal(bytes.readUInt16LE(10), 1); assert.deepEqual(writePack(restored), bytes);
    const damaged = Buffer.from(bytes); damaged.writeUInt32LE(1, 14);
    assert.throws(() => readPack(damaged), /offset/);
    assert.throws(() => readPack(bytes.subarray(0, bytes.length - 1)));
  }
});
test('DataPack reads v4 and rejects invalid alias targets', () => {
  const v4 = Buffer.alloc(24); v4.writeUInt32LE(4); v4.writeUInt32LE(1, 4); v4[8] = 1;
  v4.writeUInt16LE(7, 9); v4.writeUInt32LE(21, 11); v4.writeUInt32LE(24, 17); v4.write('abc', 21);
  assert.equal(readPack(v4).resources.get(7)?.toString(), 'abc');
  const v5 = writePack({ encoding: 1, resources: new Map([[1, Buffer.from('a')], [2, Buffer.from('a')]]) });
  v5.writeUInt16LE(9, 26); assert.throws(() => readPack(v5), /alias/);
});
test('Branding changes UI names without rewriting legal notices or upstream addresses', () => {
  assert.equal(brandText('About Thorium — THORIUM 设置Thorium'), 'About Autoum — AUTOUM 设置Autoum');
  for (const text of ['Copyright Thorium © Alex313031', 'Thorium license', 'https://thorium.rocks/Thorium', '/opt/Thorium/file', 'org.chromium.Thorium', 'Thorium.exe', 'Thorium-Installer']) assert.equal(brandText(text), text);
  assert.equal(brandText(brandText('About Thorium')), 'About Autoum');
});
