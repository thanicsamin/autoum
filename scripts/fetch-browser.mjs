import { brandBrowser } from './brand-browser.mjs';
import { browserAssets } from './assets.mjs';
import { download } from './download.mjs';
import { unzip } from '../host/archive.ts';
import { root } from './paths.mjs';
import { join } from 'node:path';
import { mkdir, readdir, rename, rm, chmod, cp, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
export async function fetchBrowser(target, destination) {
  const asset = browserAssets[target]; if (!asset) throw Error('No pinned Thorium build for this platform. Use an installed Thorium via AUTOUM_BROWSER.');
  await mkdir(destination, { recursive: true });
  const mac = target.startsWith('darwin');
  const archive = await download(asset.url, join(root, '.cache', target + (mac ? '.dmg' : '.zip')), asset.sha256);
  if (mac) await cp(archive, join(destination, 'Thorium.dmg'));
  else {
    const extracted = join(destination, '.extract'); await rm(extracted, { recursive: true, force: true }); await unzip(archive, extracted);
    const filename = target.startsWith('win32') ? 'thorium.exe' : 'thorium';
    const locate = async (folder, depth = 0) => {
      const entries = await readdir(folder, { withFileTypes: true });
      if (entries.some(e => e.name.toLowerCase() === filename)) return folder;
      if (depth < 5) for (const entry of entries) if (entry.isDirectory()) { const found = await locate(join(folder, entry.name), depth + 1); if (found) return found; }
    };
    const folder = await locate(extracted); if (!folder) throw Error('Thorium executable missing from the verified archive.');
    for (const entry of await readdir(folder)) await rename(join(folder, entry), join(destination, entry));
    await rm(extracted, { recursive: true, force: true });
    if (!target.startsWith('win32')) for (const name of ['thorium', 'chrome-sandbox', 'chromedriver']) await chmod(join(destination, name), 0o755).catch(e => { if (e.code !== 'ENOENT') throw e; });
  }
  await writeFile(join(destination, 'upstream.json'), JSON.stringify({ ...asset, platform: target, retrieved: new Date().toISOString() }, null, 2));
  await brandBrowser(destination, target);
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await fetchBrowser(`${process.platform}-${process.arch}`, join(root, 'browser')); console.log('Verified Thorium downloaded.');
}
