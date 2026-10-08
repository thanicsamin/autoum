import { build } from 'esbuild';
import { extensionWorkerIdentity } from './extension-version.mjs';
import { mkdir, cp, readFile, writeFile, access, rm, readdir } from 'node:fs/promises';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
let key;
try { key = (await readFile(join(root, 'extension/key.txt'), 'utf8')).trim(); }
catch { key = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'der' }).toString('base64'); await writeFile(join(root, 'extension/key.txt'), key); }
const extensionId = [...createHash('sha256').update(Buffer.from(key, 'base64')).digest('hex').slice(0, 32)].map(c => String.fromCharCode(97 + parseInt(c, 16))).join('');
await mkdir(join(root, 'dist/extension'), { recursive: true });
await rm(join(root, 'dist/extension/voice-worker.js'), { force: true }); await rm(join(root, 'dist/extension/voice-worker.js.map'), { force: true });
await mkdir(join(root, 'dist/host'), { recursive: true });
await build({ entryPoints: ['extension/background.ts', 'extension/ui.tsx'], outdir: 'dist/extension', loader: { '.woff2': 'file', '.woff': 'file', '.ttf': 'file' }, assetNames: 'fonts/[name]-[hash]', bundle: true, format: 'iife', platform: 'browser', target: 'chrome138', jsx: 'automatic', sourcemap: true, define: { 'process.env.NODE_ENV': '"production"' } });
// Unpacked extension workers survive browser restarts in Chromium's script cache.
// A changed URL, rather than only a changed manifest version, loads the new worker.
const backgroundBytes = await readFile(join(root, 'dist/extension/background.js'));
const previousBuild = await readFile(join(root, 'dist/build.json'), 'utf8').then(JSON.parse).catch(error => { if (error.code === 'ENOENT') return {}; throw error; });
const workerIdentity = extensionWorkerIdentity(backgroundBytes, previousBuild);
const backgroundName = workerIdentity.extensionWorker;
for (const file of await readdir(join(root, 'dist/extension'))) if (/^background-[a-f0-9]{16}\.js$/.test(file) && file !== backgroundName) await rm(join(root, 'dist/extension', file));
await writeFile(join(root, 'dist/extension', backgroundName), backgroundBytes);
await build({ entryPoints: ['extension/local-voice-worker.ts'], loader: { '.txt': 'text' }, external: ['node:*'], outfile: 'dist/extension/local-voice-worker.js', bundle: true, format: 'esm', platform: 'browser', target: 'chrome138', sourcemap: true });
await cp(join(root, 'node_modules/onnxruntime-web/dist'), join(root, 'dist/extension/voice-runtime'), { recursive: true, filter: source => source.endsWith('/dist') || /ort-wasm.*\.(mjs|wasm)$/.test(source) });
await cp(join(root, '.cache/voice-models'), join(root, 'dist/extension/voice-models'), { recursive: true });
await build({ entryPoints: ['host/main.ts'], outfile: 'dist/host/main.mjs', bundle: true, platform: 'node', format: 'esm', packages: 'external', target: 'node24', sourcemap: true });
for (const name of ['index.html', 'welcome.html', 'welcome.css', 'welcome.js', 'newtab.html', 'newtab.css', 'newtab.js', 'logo.svg', 'icons', 'voice-permission.html', 'voice-permission.js', 'voice-capture.js', 'ONNX-LICENSE.txt', 'ONNX-THIRD-PARTY-NOTICES.txt', 'TRANSFORMERS-LICENSE.txt', 'HEADTTS-LICENSE.txt', 'HEADTTS-NOTICES.md']) await cp(join(root, 'extension', name), join(root, 'dist/extension', name), { recursive: true });
await cp(join(root, 'scripts/mcp-relay.mjs'), join(root, 'dist/mcp-relay.mjs'));
// Windows launcher ICO uses the same PNG assets as the browser UI.
const iconFrames = await Promise.all([16, 32, 48, 64, 128, 256].map(async size => ({ size, bytes: await readFile(join(root, 'extension/icons', size + '.png')) })));
const icoHeader = Buffer.alloc(6 + iconFrames.length * 16); icoHeader.writeUInt16LE(1, 2); icoHeader.writeUInt16LE(iconFrames.length, 4); let icoOffset = icoHeader.length;
for (const [index, frame] of iconFrames.entries()) { const entry = 6 + index * 16; icoHeader[entry] = icoHeader[entry + 1] = frame.size % 256; icoHeader.writeUInt16LE(1, entry + 4); icoHeader.writeUInt16LE(32, entry + 6); icoHeader.writeUInt32LE(frame.bytes.length, entry + 8); icoHeader.writeUInt32LE(icoOffset, entry + 12); icoOffset += frame.bytes.length; }
await writeFile(join(root, 'dist/extension/icons/Autoum.ico'), Buffer.concat([icoHeader, ...iconFrames.map(frame => frame.bytes)]));
await writeFile(join(root, 'dist/extension/manifest.json'), JSON.stringify({
  manifest_version: 3, name: 'Autoum', version: workerIdentity.extensionVersion, version_name: '0.1.0', key,
  description: 'Your AI accounts, real browser tabs, local files, and computer tools in one sidebar.',
  permissions: ['sidePanel', 'tabs', 'tabGroups', 'storage', 'nativeMessaging', 'debugger', 'downloads', 'fontSettings', 'search'],
  chrome_url_overrides: { newtab: 'newtab.html' },
  host_permissions: ['<all_urls>'], background: { service_worker: backgroundName },
  icons: { '16': 'icons/16.png', '32': 'icons/32.png', '48': 'icons/48.png', '128': 'icons/128.png' },
  action: { default_title: 'Open Autoum', default_icon: { '16': 'icons/16.png', '32': 'icons/32.png' } }, side_panel: { default_path: 'index.html' },
  commands: { 'toggle-sidebar': { suggested_key: { default: 'Ctrl+Shift+O', mac: 'Command+Shift+O' }, description: 'Open Autoum sidebar' } },
  content_security_policy: { extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'none'" },
}, null, 2));
await writeFile(join(root, 'dist/build.json'), JSON.stringify({ extensionId, version: '0.1.0', ...workerIdentity }, null, 2));
console.log(`Autoum built. Extension: ${extensionId}`);
