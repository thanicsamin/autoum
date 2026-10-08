// Compatibility opt-in for Autoum's model renderer in the pinned Google ACP runtime.
// Original downloads stay intact. Only the local client-renderer allowlist changes;
// the server's account catalog, authentication and entitlement checks are retained.
import { open, stat, copyFile, rename, rm, chmod, readFile } from 'node:fs/promises';
import { createReadStream, constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { inflateRawSync, deflateRawSync, crc32 } from 'node:zlib';
import { saveJson } from './storage.ts';
import { dirname, join } from 'node:path';
import yauzl from 'yauzl';
const modulePath = 'google3/cloud/developer_experience/antigravity_extensions/acp_server/model_selection.py';
const gate = 'return client.is_jetbrains or client.is_zed or client.is_xcode';
const cache = new Map<string, { source: string; output: string; path: string }>();
const hash = async (path: string) => { const digest = createHash('sha256'); for await (const chunk of createReadStream(path)) digest.update(chunk); return digest.digest('hex'); };
const stamp = async (path: string) => { const s = await stat(path); return `${s.size}:${s.mtimeMs}`; };
const verified = new Map<string, string>();
export async function verifiedRuntimeHash(path: string, archiveHash: string, binary: string) {
  if (!/\.(par|exe)$/i.test(path)) return '';
  const archive = join(dirname(path), 'download.zip'), key = archive + ':' + archiveHash;
  if (verified.has(key)) return verified.get(key)!;
  if (await hash(archive).catch(() => '') !== archiveHash) return '';
  const digest = await new Promise<string>((yes, no) => yauzl.open(archive, { lazyEntries: true }, (error, zip) => {
    if (error || !zip) { no(error); return; }
    zip.on('error', no); zip.on('end', () => no(Error('Pinned connector archive has no runtime.')));
    zip.on('entry', entry => {
      if (entry.fileName.split('/').at(-1) !== binary) { zip.readEntry(); return; }
      zip.openReadStream(entry, (error, stream) => {
        if (error || !stream) { zip.close(); no(error); return; }
        const digest = createHash('sha256'); stream.on('data', chunk => digest.update(chunk)); stream.on('error', error => { zip.close(); no(error); }); stream.on('end', () => { zip.close(); yes(digest.digest('hex')); });
      });
    }); zip.readEntry();
  }));
  verified.set(key, digest); return digest;
}
export function optInAntigravity(source: string) {
  if (source.split(gate).length !== 2) throw Error('The Google connector model gate changed; update the compatibility adapter.');
  return source.replace(gate, '# Autoum modification: opt in this renderer; retain account availability checks.\n  return client.name.lower() == "autoum-browser" or client.is_jetbrains or client.is_zed or client.is_xcode');
}
export async function prepareAntigravityRuntime(path: string, expectedHash: string) {
  if (!expectedHash || !/\.(par|exe)$/i.test(path)) return path;
  const cacheKey = path + ':' + expectedHash;
  const sourceStamp = await stamp(path), cached = cache.get(cacheKey);
  if (cached?.source === sourceStamp && await stamp(cached.path).catch(() => '') === cached.output) return cached.path;
  // Never adapt arbitrary installed/new runtimes or modify their original files.
  if (await hash(path) !== expectedHash) { cache.set(cacheKey, { source: sourceStamp, output: sourceStamp, path }); return path; }
  const output = path.replace(/\.(par|exe)$/i, '.autoum.$1'), receiptPath = output + '.json';
  const receipt = await readFile(receiptPath, 'utf8').then(JSON.parse).catch(() => undefined);
  if (receipt?.version === 2 && receipt.inputHash === expectedHash && await hash(output).catch(() => '') === receipt.outputHash) {
    cache.set(cacheKey, { source: sourceStamp, output: await stamp(output), path: output }); return output;
  }
  const file = await open(path, 'r');
  const read = async (position: number, size: number) => {
    if (position < 0 || size < 0 || size > 4_000_000 || position + size > (await file.stat()).size) throw Error('Invalid connector archive bounds.');
    const bytes = Buffer.alloc(size); if ((await file.read(bytes, 0, size, position)).bytesRead !== size) throw Error('Truncated connector archive.'); return bytes;
  };
  let patches: { position: number; bytes: Buffer }[];
  try {
    const size = (await file.stat()).size, tailSize = Math.min(size, 65557), tail = await read(size - tailSize, tailSize), end = tail.lastIndexOf(Buffer.from('504b0506', 'hex'));
    if (end < 0 || end + 22 > tail.length || end + 22 + tail.readUInt16LE(end + 20) !== tail.length || tail.readUInt32LE(end + 4) !== 0) throw Error('Unsupported connector archive.');
    const count = tail.readUInt16LE(end + 10), centralSize = tail.readUInt32LE(end + 12), endPosition = size - tailSize + end;
    if (count === 65535 || count !== tail.readUInt16LE(end + 8)) throw Error('Unsupported connector archive entries.');
    const prefix = endPosition - centralSize - tail.readUInt32LE(end + 16), central = await read(endPosition - centralSize, centralSize), kept: Buffer[] = [];
    let at = 0, source: string | undefined, sourceEntry: Buffer | undefined, sourceHeader: Buffer | undefined, sourcePosition = 0, dataPosition = 0;
    for (let index = 0; index < count; index++) {
      if (at + 46 > central.length || central.readUInt32LE(at) !== 0x02014b50) throw Error('Invalid connector directory.');
      const length = 46 + central.readUInt16LE(at + 28) + central.readUInt16LE(at + 30) + central.readUInt16LE(at + 32), entry = Buffer.from(central.subarray(at, at + length));
      if (entry.length !== length) throw Error('Truncated connector directory.');
      const name = entry.toString('utf8', 46, 46 + entry.readUInt16LE(28)), offset = prefix + entry.readUInt32LE(42);
      if (name === modulePath) {
        if (source !== undefined) throw Error('Duplicate connector module.');
        const local = await read(offset, 30); if (local.readUInt32LE(0) !== 0x04034b50 || entry.readUInt16LE(8) & 1) throw Error('Unsupported connector module.');
        const compressed = await read(offset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28), entry.readUInt32LE(20));
        const bytes = entry.readUInt16LE(10) === 8 ? inflateRawSync(compressed, { maxOutputLength: 1_000_000 }) : entry.readUInt16LE(10) === 0 ? compressed : undefined;
        if (!bytes || bytes.length !== entry.readUInt32LE(24) || crc32(bytes) !== entry.readUInt32LE(16)) throw Error('Invalid connector module checksum.');
        source = bytes.toString('utf8'); sourceEntry = entry; sourceHeader = local; sourcePosition = offset; dataPosition = offset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
      } else if (!name.startsWith(modulePath.slice(0, -3) + '.pyc') && !name.includes('/__pycache__/model_selection.')) {
        kept.push(entry);
      }
      at += length;
    }
    if (at !== central.length || source === undefined) throw Error('Missing connector compatibility module.');
    if (!sourceEntry || !sourceHeader) throw Error('Missing connector module metadata.');
    const bytes = Buffer.from(optInAntigravity(source)), compressed = deflateRawSync(bytes, { level: 9 }), checksum = crc32(bytes);
    const allocation = sourceEntry.readUInt32LE(20);
    if (compressed.length > allocation) throw Error('Connector compatibility module exceeds its existing ZIP allocation.');
    // Keep the embedded ZIP section's file layout/size. The hermetic PAR loader
    // reads that section, not an appended ZIP at the end of the executable.
    sourceHeader.writeUInt16LE(sourceHeader.readUInt16LE(6) & ~8, 6); sourceHeader.writeUInt16LE(8, 8); sourceHeader.writeUInt32LE(checksum, 14); sourceHeader.writeUInt32LE(compressed.length, 18); sourceHeader.writeUInt32LE(bytes.length, 22);
    sourceEntry.writeUInt16LE(sourceEntry.readUInt16LE(8) & ~8, 8); sourceEntry.writeUInt16LE(8, 10); sourceEntry.writeUInt32LE(checksum, 16); sourceEntry.writeUInt32LE(compressed.length, 20); sourceEntry.writeUInt32LE(bytes.length, 24);
    kept.push(sourceEntry);
    const directory = Buffer.concat(kept), trailer = Buffer.from(tail.subarray(end)), directoryPosition = endPosition - directory.length;
    if (directory.length > centralSize || kept.length >= 65535) throw Error('Connector directory exceeds its original bounds.');
    trailer.writeUInt16LE(kept.length, 8); trailer.writeUInt16LE(kept.length, 10); trailer.writeUInt32LE(directory.length, 12); trailer.writeUInt32LE(directoryPosition - prefix, 16);
    const data = Buffer.alloc(allocation); compressed.copy(data);
    const directoryRegion = Buffer.alloc(centralSize); directory.copy(directoryRegion, centralSize - directory.length);
    patches = [{ position: sourcePosition, bytes: sourceHeader }, { position: dataPosition, bytes: data }, { position: endPosition - centralSize, bytes: directoryRegion }, { position: endPosition, bytes: trailer }];
  } finally { await file.close(); }
  const temporary = output + '.' + crypto.randomUUID() + '.tmp';
  try { await copyFile(path, temporary, constants.COPYFILE_FICLONE); const writer = await open(temporary, 'r+'); try { for (const patch of patches) await writer.write(patch.bytes, 0, patch.bytes.length, patch.position); } finally { await writer.close(); } if (process.platform !== 'win32') await chmod(temporary, 0o700); await rename(temporary, output); } finally { await rm(temporary, { force: true }); }
  await saveJson(receiptPath, { version: 2, modification: 'Autoum client renderer opt-in only', inputHash: expectedHash, outputHash: await hash(output) });
  cache.set(cacheKey, { source: sourceStamp, output: await stamp(output), path: output }); return output;
}
