import { readFile, writeFile, readdir, rename, stat, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { replacePEIcons } from './pe-icons.mjs';
import { readPack, writePack } from './data-pack.mjs';
const project = fileURLToPath(new URL('../', import.meta.url));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export function brandText(text) {
  // Retain attribution, copyright, licenses and upstream identifiers/URLs.
  if (/copyright|©|Alex313031|Chromium Authors|Chromium project|source code|license|licence|credits/i.test(text)) return text;
  return text.replace(/(?<![A-Za-z0-9_./:@-])(?:Thorium|Chromium)(?![A-Za-z0-9_./:@-])/g, 'Autoum')
    .replace(/(?<![A-Za-z0-9_./:@-])(?:THORIUM|CHROMIUM)(?![A-Za-z0-9_./:@-])/g, 'AUTOUM');
}
async function atomicWrite(path, bytes) {
  const temporary = path + '.' + randomUUID() + '.tmp';
  try {
    const metadata = await stat(path).catch(() => undefined);
    await writeFile(temporary, bytes, { mode: metadata ? metadata.mode & 0o777 : 0o644 });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}
export async function brandBrowser(directory, target = `${process.platform}-${process.arch}`, assetsRoot = project) {
  // macOS resources are part of signed bundles; preserve those signatures.
  if (target.startsWith('darwin')) return { status: 'signed-engine-preserved', files: [] };
  const configuration = JSON.parse(await readFile(join(project, 'scripts/branding-resources.json'), 'utf8')), known = configuration.knownProductLogos;
  const receipt = await readFile(join(directory, 'branding.json'), 'utf8').then(JSON.parse).catch(e => { if (e.code === 'ENOENT') return { files: [] }; throw e; });
  const icons = new Map();
  for (const size of [16, 24, 32, 48, 64, 128, 256]) icons.set(size, await readFile(join(assetsRoot, 'dist/extension/icons', size + '.png')));
  const files = [], pending = [];
  const walk = async (folder, relative = '', depth = 0) => {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const name = join(relative, entry.name), path = join(directory, name);
      if (entry.isDirectory() && depth < 3 && !['.extract', 'swiftshader'].includes(entry.name)) { await walk(path, name, depth + 1); continue; }
      if (!entry.isFile()) continue;
      if (target === 'win32-x64' && entry.name === 'thorium.exe') {
        const original = await readFile(path), hash = digest(original);
        if (configuration.knownProductExecutables?.[hash] === target || receipt.files.some(file => file.path === name && file.after === hash && file.executableIcons)) {
          const document = new Map(); for (const size of [16, 32, 48, 256]) document.set(size, await readFile(join(assetsRoot, 'dist/extension/icons', `document-${size}.png`)));
          const patched = replacePEIcons(original, new Map([['IDR_MAINFRAME', icons], ['IDR_X006_HTML_DOC', document], ['IDR_X007_PDF_DOC', document]]));
          if (patched.changed) { pending.push({ path, bytes: patched.bytes }); files.push({ path: name, before: hash, after: digest(patched.bytes), imageCount: patched.changed, executableIcons: true }); }
        }
      } else if (entry.name.endsWith('.pak')) {
        const original = await readFile(path), pack = readPack(original);
        let textCount = 0, imageCount = 0;
        const locale = /(^|[\\/])locales[\\/]/i.test(name);
        for (const [id, bytes] of pack.resources) {
          const logo = known[digest(bytes)];
          if (logo && logo.width === logo.height && icons.has(logo.width)) { pack.resources.set(id, icons.get(logo.width)); imageCount++; }
          else if (locale && pack.encoding !== 0) {
            const decoder = new TextDecoder(pack.encoding === 2 ? 'utf-16le' : 'utf-8', { fatal: true, ignoreBOM: true });
            let text; try { text = decoder.decode(bytes); } catch { continue; }
            const branded = brandText(text);
            if (branded !== text) { pack.resources.set(id, Buffer.from(branded, pack.encoding === 2 ? 'utf16le' : 'utf8')); textCount++; }
          }
        }
        if (textCount || imageCount) {
          const output = writePack(pack); readPack(output); pending.push({ path, bytes: output });
          files.push({ path: name, before: digest(original), after: digest(output), textCount, imageCount });
        }
      } else if (/^product_logo_\d+\.png$/.test(entry.name)) {
        const original = await readFile(path), logo = known[digest(original)];
        if (logo && icons.has(logo.width)) {
          const output = icons.get(logo.width); pending.push({ path, bytes: output });
          files.push({ path: name, before: digest(original), after: digest(output), imageCount: 1 });
        }
      } else if (entry.name === 'thorium.svg') {
        const original = await readFile(path), output = await readFile(join(assetsRoot, 'dist/extension/logo.svg'));
        if (!original.equals(output)) { pending.push({ path, bytes: output }); files.push({ path: name, before: digest(original), after: digest(output), imageCount: 1 }); }
      }
    }
  };
  await walk(directory);
  for (const file of pending) await atomicWrite(file.path, file.bytes);
  if (files.length) {
    const path = join(directory, 'branding.json');
    const previous = await readFile(path, 'utf8').then(JSON.parse).catch(e => { if (e.code === 'ENOENT') return { files: [] }; throw e; });
    const merged = new Map(previous.files.map(file => [file.path, file]));
    for (const file of files) merged.set(file.path, { ...file, before: merged.get(file.path)?.before || file.before });
    await atomicWrite(path, JSON.stringify({ product: 'Autoum', target, updated: new Date().toISOString(), nativeExecutable: [...merged.values()].some(file => file.executableIcons) ? 'unsigned-icon-resources-only' : 'unmodified', files: [...merged.values()] }, null, 2));
  }
  return { status: 'resource-branded', files };
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const result = await brandBrowser(resolve(process.argv[2] || join(project, 'browser')), process.argv[3]);
  console.log(`${result.status}: ${result.files.length} resource files updated.`);
}
