// Replace icon resources in place in an explicitly pinned, unsigned Windows PE.
// Code, sections, imports and file layout are untouched; replacement images must fit.
export function peIcons(bytes) {
  const check = (offset, size) => { if (!Number.isSafeInteger(offset) || offset < 0 || offset + size > bytes.length) throw Error('Invalid PE resource bounds.'); };
  check(0, 64); if (bytes.toString('ascii', 0, 2) !== 'MZ') throw Error('Not a Windows executable.');
  const pe = bytes.readUInt32LE(60); check(pe, 24); if (bytes.readUInt32LE(pe) !== 0x4550) throw Error('Invalid PE signature.');
  const optional = pe + 24, optionalSize = bytes.readUInt16LE(pe + 20); check(optional, optionalSize);
  const magic = bytes.readUInt16LE(optional), directories = optional + (magic === 0x20b ? 112 : magic === 0x10b ? 96 : NaN);
  check(directories, 40); if (directories + 40 > optional + optionalSize) throw Error('Invalid PE optional header.');
  const signed = bytes.readUInt32LE(directories + 32) !== 0 || bytes.readUInt32LE(directories + 36) !== 0;
  const sections = [], count = bytes.readUInt16LE(pe + 6); if (count > 96) throw Error('Invalid PE sections.');
  for (let i = 0; i < count; i++) { const start = optional + optionalSize + i * 40; check(start, 40); sections.push({ rva: bytes.readUInt32LE(start + 12), size: bytes.readUInt32LE(start + 16), offset: bytes.readUInt32LE(start + 20) }); }
  const address = rva => { const section = sections.find(s => rva >= s.rva && rva < s.rva + s.size); if (!section) throw Error('Invalid PE resource address.'); return section.offset + rva - section.rva; };
  const resourceRva = bytes.readUInt32LE(directories + 16), resourceSize = bytes.readUInt32LE(directories + 20), base = address(resourceRva);
  const local = (offset, size) => { if (offset < 0 || offset + size > resourceSize) throw Error('Invalid PE resource directory.'); check(base + offset, size); return base + offset; };
  const icons = new Map(), groups = [];
  const walk = (offset, path = [], visited = new Set()) => {
    if (path.length > 3 || visited.has(offset)) throw Error('Invalid cyclic PE resource directory.'); visited = new Set([...visited, offset]);
    const start = local(offset, 16), count = bytes.readUInt16LE(start + 12) + bytes.readUInt16LE(start + 14); local(offset + 16, count * 8);
    for (let i = 0; i < count; i++) {
      const entry = start + 16 + i * 8, name = bytes.readUInt32LE(entry), pointer = bytes.readUInt32LE(entry + 4); let key = name;
      if (name & 0x80000000) { const text = local(name & 0x7fffffff, 2), length = bytes.readUInt16LE(text); local((name & 0x7fffffff) + 2, length * 2); key = bytes.toString('utf16le', text + 2, text + 2 + length * 2); }
      if (!path.length && ![3, 14].includes(key)) continue;
      if (pointer & 0x80000000) walk(pointer & 0x7fffffff, [...path, key], visited);
      else {
        const dataEntry = local(pointer, 16), offset = address(bytes.readUInt32LE(dataEntry)), size = bytes.readUInt32LE(dataEntry + 4); check(offset, size);
        const resource = { id: path[1], language: key, offset, size, sizeOffset: dataEntry + 4 };
        if (path[0] === 3) icons.set(`${resource.id}:${resource.language}`, resource);
        else if (path[0] === 14) groups.push(resource);
      }
    }
  };
  walk(0); return { signed, icons, groups, checksumOffset: optional + 64 };
}
export function replacePEIcons(bytes, replacements) {
  const parsed = peIcons(bytes); if (parsed.signed) throw Error('Signed executable icons must be changed during a signed build.');
  const output = Buffer.from(bytes); let changed = 0;
  for (const group of parsed.groups) {
    const sizes = replacements.get(group.id); if (!sizes) continue;
    if (group.size < 6 || bytes.readUInt16LE(group.offset) !== 0 || bytes.readUInt16LE(group.offset + 2) !== 1) throw Error('Invalid PE icon group.');
    const count = bytes.readUInt16LE(group.offset + 4); if (6 + count * 14 > group.size) throw Error('Truncated PE icon group.');
    for (let i = 0; i < count; i++) {
      const entry = group.offset + 6 + i * 14, size = bytes[entry] || 256, height = bytes[entry + 1] || 256;
      const icon = parsed.icons.get(`${bytes.readUInt16LE(entry + 12)}:${group.language}`), image = sizes.get(size);
      if (!icon || !image || size !== height || image.length < 24 || !image.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) || image.readUInt32BE(16) !== size || image.readUInt32BE(20) !== size) throw Error('Missing or invalid replacement icon.');
      if (image.length > icon.size) throw Error('Replacement icon does not fit its pinned resource.');
      if (bytes.subarray(icon.offset, icon.offset + icon.size).equals(image)) continue;
      output.fill(0, icon.offset, icon.offset + icon.size); image.copy(output, icon.offset); output.writeUInt32LE(image.length, icon.sizeOffset);
      output[entry + 2] = 0; output.writeUInt16LE(1, entry + 4); output.writeUInt16LE(32, entry + 6); output.writeUInt32LE(image.length, entry + 8); changed++;
    }
  }
  if (changed) {
    output.writeUInt32LE(0, parsed.checksumOffset); let checksum = 0;
    for (let i = 0; i < output.length; i += 2) { checksum += output[i] | (output[i + 1] || 0) << 8; checksum = (checksum & 0xffff) + (checksum >>> 16); }
    checksum = (checksum & 0xffff) + (checksum >>> 16); output.writeUInt32LE((checksum + output.length) >>> 0, parsed.checksumOffset);
  }
  peIcons(output); return { bytes: output, changed };
}
