// Chromium GRIT DataPack v4/v5. No executable or compressed-resource rewriting.
export function readPack(bytes) {
  const data = Buffer.from(bytes);
  if (data.length < 9) throw Error('Truncated DataPack');
  const version = data.readUInt32LE(0);
  if (![4, 5].includes(version)) throw Error('Unsupported DataPack version');
  if (version === 5 && data.length < 12) throw Error('Truncated DataPack');
  const encoding = data[version === 5 ? 4 : 8];
  if (encoding > 2) throw Error('Invalid DataPack encoding');
  const count = version === 5 ? data.readUInt16LE(8) : data.readUInt32LE(4);
  const aliases = version === 5 ? data.readUInt16LE(10) : 0;
  const header = version === 5 ? 12 : 9;
  const start = header + (count + 1) * 6 + aliases * 4;
  if (start > data.length) throw Error('Truncated DataPack index');
  const resources = new Map(); const ids = [];
  let previous = 0;
  for (let i = 0; i <= count; i++) {
    const at = header + i * 6, id = data.readUInt16LE(at), offset = data.readUInt32LE(at + 2);
    if (offset < start || offset > data.length || (i === 0 && offset !== start)) throw Error('Invalid DataPack offset');
    if (i === count) {
      if (id !== 0 || offset !== data.length) throw Error('Invalid DataPack sentinel');
      break;
    }
    const end = data.readUInt32LE(at + 8);
    if (id <= previous || end < offset || end > data.length) throw Error('Invalid DataPack resource');
    resources.set(id, data.subarray(offset, end)); ids.push(id); previous = id;
  }
  for (let i = 0; i < aliases; i++) {
    const at = header + (count + 1) * 6 + i * 4;
    const id = data.readUInt16LE(at), index = data.readUInt16LE(at + 2);
    if (!id || resources.has(id) || index >= count) throw Error('Invalid DataPack alias');
    resources.set(id, resources.get(ids[index]));
  }
  return { encoding, resources };
}

export function writePack({ encoding, resources }) {
  if (![0, 1, 2].includes(encoding)) throw Error('Invalid DataPack encoding');
  const entries = [...resources].sort((a, b) => a[0] - b[0]);
  const unique = [], aliases = [], seen = new Map();
  for (const [id, value] of entries) {
    if (!Number.isInteger(id) || id < 1 || id > 65535) throw Error('Invalid resource ID');
    const bytes = Buffer.from(value), key = bytes.toString('base64');
    if (seen.has(key)) aliases.push([id, seen.get(key)]);
    else { seen.set(key, unique.length); unique.push([id, bytes]); }
  }
  if (unique.length > 65535 || aliases.length > 65535) throw Error('DataPack too large');
  let offset = 12 + (unique.length + 1) * 6 + aliases.length * 4;
  const result = Buffer.alloc(offset + unique.reduce((n, [, b]) => n + b.length, 0));
  result.writeUInt32LE(5); result[4] = encoding;
  result.writeUInt16LE(unique.length, 8); result.writeUInt16LE(aliases.length, 10);
  unique.forEach(([id, bytes], index) => {
    const at = 12 + index * 6; result.writeUInt16LE(id, at); result.writeUInt32LE(offset, at + 2);
    bytes.copy(result, offset); offset += bytes.length;
  });
  result.writeUInt32LE(offset, 12 + unique.length * 6 + 2);
  aliases.forEach(([id, index], i) => {
    const at = 12 + (unique.length + 1) * 6 + i * 4;
    result.writeUInt16LE(id, at); result.writeUInt16LE(index, at + 2);
  });
  return result;
}
