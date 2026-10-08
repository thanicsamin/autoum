import { test } from 'node:test';
import assert from 'node:assert/strict';
import { peIcons, replacePEIcons } from '../scripts/pe-icons.mjs';
function png(size: number, length = 64) { const bytes = Buffer.alloc(length); Buffer.from('89504e470d0a1a0a', 'hex').copy(bytes); bytes.writeUInt32BE(size, 16); bytes.writeUInt32BE(size, 20); return bytes; }
function fixture() {
  const bytes = Buffer.alloc(2560); bytes.write('MZ'); bytes.writeUInt32LE(128, 60); bytes.writeUInt32LE(0x4550, 128); bytes.writeUInt16LE(1, 134); bytes.writeUInt16LE(224, 148);
  const optional = 152; bytes.writeUInt16LE(0x10b, optional); bytes.writeUInt32LE(16, optional + 92); bytes.writeUInt32LE(0x1000, optional + 112); bytes.writeUInt32LE(2048, optional + 116);
  const section = optional + 224; bytes.write('.rsrc', section); bytes.writeUInt32LE(2048, section + 8); bytes.writeUInt32LE(0x1000, section + 12); bytes.writeUInt32LE(2048, section + 16); bytes.writeUInt32LE(512, section + 20);
  let next = 0; const allocate = (length: number) => { const offset = next; next += length; return offset; };
  const node = (rows: [string | number, any][]): number => {
    const offset = allocate(16 + 8 * rows.length); bytes.writeUInt16LE(rows.filter(([id]) => typeof id === 'string').length, 512 + offset + 12); bytes.writeUInt16LE(rows.filter(([id]) => typeof id === 'number').length, 512 + offset + 14);
    rows.forEach(([id, value], i) => {
      const entry = 512 + offset + 16 + i * 8;
      if (typeof id === 'string') { const name = Buffer.from(id, 'utf16le'), where = allocate(2 + name.length); bytes.writeUInt16LE(id.length, 512 + where); name.copy(bytes, 514 + where); bytes.writeUInt32LE((0x80000000 | where) >>> 0, entry); } else bytes.writeUInt32LE(id, entry);
      if (Buffer.isBuffer(value)) { const dataEntry = allocate(16), data = allocate(value.length); value.copy(bytes, 512 + data); bytes.writeUInt32LE(0x1000 + data, 512 + dataEntry); bytes.writeUInt32LE(value.length, 516 + dataEntry); bytes.writeUInt32LE(dataEntry, entry + 4); }
      else bytes.writeUInt32LE((0x80000000 | node(value)) >>> 0, entry + 4);
    }); return offset;
  };
  const group = Buffer.alloc(20); group.writeUInt16LE(1, 2); group.writeUInt16LE(1, 4); group[6] = 16; group[7] = 16; group.writeUInt16LE(1, 10); group.writeUInt16LE(32, 12); group.writeUInt32LE(256, 14); group.writeUInt16LE(1, 18);
  node([[3, [[1, [[1033, png(16, 256)]]]]], [14, [['IDR_MAINFRAME', [[1033, group]]]]]]); return bytes;
}
test('unsigned PE icon replacement preserves layout, updates sizes/checksum and is idempotent', () => {
  const bytes = fixture(), image = png(16), replacements = new Map([['IDR_MAINFRAME', new Map([[16, image]])]]);
  const result = replacePEIcons(bytes, replacements); assert.equal(result.changed, 1); assert.equal(result.bytes.length, bytes.length); assert.equal(bytes.readUInt32LE(152 + 64), 0);
  const parsed = peIcons(result.bytes), icon = parsed.icons.get('1:1033'); assert.equal(icon.size, image.length); assert.deepEqual(result.bytes.subarray(icon.offset, icon.offset + icon.size), image); assert.ok(result.bytes.readUInt32LE(parsed.checksumOffset));
  assert.equal(replacePEIcons(result.bytes, replacements).changed, 0);
});
test('PE icon changes reject signatures, malformed resources, wrong sizes and oversized images', () => {
  const bytes = fixture(); const signed = Buffer.from(bytes); signed.writeUInt32LE(1024, 152 + 96 + 32);
  assert.throws(() => replacePEIcons(signed, new Map()), /Signed/);
  assert.throws(() => replacePEIcons(bytes, new Map([['IDR_MAINFRAME', new Map([[16, png(16, 257)]])]])), /does not fit/);
  assert.throws(() => replacePEIcons(bytes, new Map([['IDR_MAINFRAME', new Map([[16, png(32)]])]])), /invalid replacement/);
  const damaged = Buffer.from(bytes); damaged.writeUInt32LE(0xffffff, 60); assert.throws(() => peIcons(damaged), /bounds/);
  const cycle = Buffer.from(bytes); cycle.writeUInt32LE(0x80000000, 512 + 20); assert.throws(() => peIcons(cycle), /cyclic/);
});
