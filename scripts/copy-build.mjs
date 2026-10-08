// Replace changed generated files atomically, retaining unchanged voice weights.
import { readdir, mkdir, readFile, writeFile, rename, rm, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
async function digest(path) { const hash = createHash('sha256'); for await (const chunk of createReadStream(path)) hash.update(chunk); return hash.digest('hex'); }
export async function copyBuild(source, destination, { standalone = false } = {}) {
  await mkdir(destination, { recursive: true }); let changed = 0;
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = join(source, entry.name), to = join(destination, entry.name);
    if (entry.isDirectory()) { changed += await copyBuild(from, to, { standalone }); continue; }
    if (!entry.isFile()) throw Error('Generated build must not contain symbolic links.');
    let bytes;
    if (standalone && entry.name === 'manifest.json') { const manifest = JSON.parse(await readFile(from, 'utf8')); delete manifest.chrome_url_overrides; bytes = Buffer.from(JSON.stringify(manifest, null, 2)); }
    const matches = await (async () => {
      if (bytes) return bytes.equals(await readFile(to));
      if ((await stat(from)).size !== (await stat(to)).size) return false;
      return await digest(from) === await digest(to);
    })().catch(() => false);
    if (matches) continue;
    const temporary = to + '.' + randomUUID() + '.tmp';
    try { await writeFile(temporary, bytes || await readFile(from), { mode: (await stat(from)).mode & 0o777 }); await rename(temporary, to); changed++; }
    finally { await rm(temporary, { force: true }); }
  }
  return changed;
}
