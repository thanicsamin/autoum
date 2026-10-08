import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, access } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
export async function sha256(path) { const hash = createHash('sha256'); for await (const chunk of createReadStream(path)) hash.update(chunk); return hash.digest('hex'); }
export async function download(url, path, expected) {
  if (await access(path).then(() => true).catch(() => false) && await sha256(path) === expected) return path;
  await mkdir(dirname(path), { recursive: true });
  const response = await fetch(url, { signal: AbortSignal.timeout(600000) });
  if (!response.ok || !response.body) throw Error(`Download failed (${response.status}) for ${url}`);
  const temporary = path + '.partial';
  try {
    await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary));
    if (await sha256(temporary) !== expected) throw Error('Downloaded artifact did not match its pinned SHA-256.');
    await rename(temporary, path); return path;
  } finally { await rm(temporary, { force: true }); }
}
