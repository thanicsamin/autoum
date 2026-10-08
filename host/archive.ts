import yauzl from 'yauzl';
import { mkdir, lstat, chmod } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { resolve, dirname, relative, sep } from 'node:path';
export async function unzip(archive: string, directory: string) {
  const root = resolve(directory); await mkdir(root, { recursive: true });
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) => yauzl.open(archive, { lazyEntries: true, decodeStrings: true }, (error, result) => error ? reject(error) : resolve(result!)));
  await new Promise<void>((resolvePromise, reject) => {
    zip.on('error', reject); zip.on('end', resolvePromise);
    zip.on('entry', async (entry: yauzl.Entry) => {
      try {
        const dest = resolve(root, entry.fileName); const rel = relative(root, dest);
        if (!rel || rel.startsWith('..' + sep) || rel === '..' || rel.startsWith(sep) || entry.fileName.includes('\\')) throw Error('Unsafe archive path.');
        const mode = entry.externalFileAttributes >>> 16;
        if ((mode & 0o170000) === 0o120000) throw Error('Archive symlinks are not accepted.');
        let ancestor = dirname(dest);
        while (ancestor !== root) { const st = await lstat(ancestor).catch(() => undefined); if (st?.isSymbolicLink()) throw Error('Archive destination contains a symlink.'); ancestor = dirname(ancestor); }
        if (entry.fileName.endsWith('/')) await mkdir(dest, { recursive: true });
        else {
          await mkdir(dirname(dest), { recursive: true });
          if ((await lstat(dest).catch(() => undefined))?.isSymbolicLink()) throw Error('Archive destination is a symlink.');
          const stream = await new Promise<NodeJS.ReadableStream>((yes, no) => zip.openReadStream(entry, (e, s) => e ? no(e) : yes(s!)));
          await pipeline(stream, createWriteStream(dest));
          if (process.platform !== 'win32' && mode & 0o111) await chmod(dest, 0o755);
        }
        zip.readEntry();
      } catch (e) { zip.close(); reject(e); }
    });
    zip.readEntry();
  });
}
