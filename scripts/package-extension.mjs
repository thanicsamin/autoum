// Build a standalone edition from its verified portable runtime.
import { mkdir, cp, readFile, writeFile, chmod, access, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { root } from './paths.mjs';
import { sha256 } from './download.mjs';
const platform = process.argv[2] || 'linux-x64';
if (!['linux-x64', 'win32-x64'].includes(platform)) throw Error('Choose linux-x64 or win32-x64.');
const windows = platform === 'win32-x64';
const source = join(root, 'releases/Autoum-0.1.0-' + platform);
const name = 'Autoum-Extension-0.1.0-' + platform, target = join(root, 'releases', name);
await access(join(source, 'runtime', windows ? 'node.exe' : 'node')); await mkdir(target, { recursive: true });
// These generated packages contain no user data; avoid stale SDK files on updates.
await rm(join(target, 'node_modules'), { recursive: true, force: true });
for (const path of ['runtime', 'node_modules', 'package.json', 'package-lock.json', 'dist', 'LICENSE', 'THIRD_PARTY_NOTICES.md']) await cp(join(source, path), join(target, path), { recursive: true });
for (const path of ['scripts', 'docs/INSTALL-EXTENSION.md', 'docs/RELEASE.md']) { await mkdir(join(target, path, '..'), { recursive: true }); await cp(join(root, path), join(target, path), { recursive: true }); }
const manifestPath = join(target, 'dist/extension/manifest.json'); const manifest = JSON.parse(await readFile(manifestPath, 'utf8')); delete manifest.chrome_url_overrides; await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
await writeFile(join(target, 'README.md'), await readFile(join(root, 'docs/INSTALL-EXTENSION.md')));
await writeFile(join(target, 'Setup-extension'), '#!/bin/sh\nbase=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexec "$base/runtime/node" "$base/scripts/install-extension.mjs" "$@"\n', { mode: 0o755 }); await chmod(join(target, 'Setup-extension'), 0o755);
if (windows) {
  await writeFile(join(target, 'Setup-extension.cmd'), '@echo off\r\n"%~dp0runtime\\node.exe" "%~dp0scripts\\install-extension.mjs" %*\r\npause\r\n');
  await cp(join(root, 'extension/windows-setup.html'), join(target, 'Extension-setup.html'));
}
const output = join(root, 'releases', name + (windows ? '.zip' : '.tar.gz'));
if (windows) execFileSync('python3', ['-c', 'import shutil,sys;shutil.make_archive(sys.argv[1],"zip",sys.argv[2],sys.argv[3])', output.slice(0, -4), join(root, 'releases'), name]);
else execFileSync('tar', ['-czf', output, '-C', join(root, 'releases'), name]);
await writeFile(output + '.sha256', `${await sha256(output)}  ${output.split('/').at(-1)}\n`);
console.log('Standalone extension ready: ' + output);
