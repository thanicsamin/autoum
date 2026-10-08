import { brandBrowser } from './brand-browser.mjs';
import { root } from './paths.mjs';
import { nodeVersion, nodeHashes } from './assets.mjs';
import { download, sha256 } from './download.mjs';
import { fetchBrowser } from './fetch-browser.mjs';
import { unzip } from '../host/archive.ts';
import { mkdir, rm, cp, writeFile, chmod, access } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
const target = process.argv[2] || `${process.platform}-${process.arch}`;
if (!nodeHashes[target]) throw Error('Supported bundles: linux-x64, win32-x64, darwin-x64, darwin-arm64.');
const platform = target.split('-')[0], windows = platform === 'win32';
const bundleName = `Autoum-0.1.0-${target}`;
const destination = join(root, 'releases', bundleName);
await rm(destination, { recursive: true, force: true }); await mkdir(destination, { recursive: true });
for (const path of ['dist', 'scripts', 'host/archive.ts', 'package.json', 'package-lock.json', 'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md'])
  await cp(join(root, path), join(destination, path), { recursive: true });
await rm(join(destination, 'docs'), { recursive: true, force: true });
await mkdir(join(destination, 'docs'), { recursive: true });
for (const file of ['DESIGN.md', 'INSTALL-EXTENSION.md', 'RELEASE.md']) await cp(join(root, 'docs', file), join(destination, 'docs', file));
// Production dependencies are JS/WASM and Pi's published prebuilds cover each supported target.
execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: destination, stdio: 'pipe', shell: process.platform === 'win32' });
const nodeTarget = target.replace('win32', 'win');
const suffix = windows ? 'zip' : 'tar.gz';
const name = `node-v${nodeVersion}-${nodeTarget}`;
const archive = await download(`https://nodejs.org/dist/v${nodeVersion}/${name}.${suffix}`, join(root, '.cache', `${name}.${suffix}`), nodeHashes[target]);
const unpacked = join(destination, '.node'); await mkdir(unpacked);
if (windows) await unzip(archive, unpacked);
else execFileSync('tar', ['-xzf', archive, '-C', unpacked]);
await mkdir(join(destination, 'runtime')); await cp(join(unpacked, name, windows ? 'node.exe' : 'bin/node'), join(destination, 'runtime', windows ? 'node.exe' : 'node'));
await cp(join(unpacked, name, 'LICENSE'), join(destination, 'runtime/NODE-LICENSE')); await rm(unpacked, { recursive: true, force: true });
if (!windows) await chmod(join(destination, 'runtime/node'), 0o755);
const same = target === `${process.platform}-${process.arch}`;
if (same && await access(join(root, 'browser/upstream.json')).then(() => true).catch(() => false)) {
  await cp(join(root, 'browser'), join(destination, 'browser'), { recursive: true, filter: source => !source.endsWith('.zip') });
} else await fetchBrowser(target, join(destination, 'browser'));
await brandBrowser(join(destination, 'browser'), target);
const launch = windows ? '@echo off\r\n"%~dp0runtime\\node.exe" "%~dp0scripts\\launch.mjs" %*\r\n' : '#!/bin/sh\nbase=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexec "$base/runtime/node" "$base/scripts/launch.mjs" "$@"\n';
const setup = windows ? '@echo off\r\n"%~dp0runtime\\node.exe" "%~dp0scripts\\install.mjs"\r\npause\r\n' : '#!/bin/sh\nbase=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexec "$base/runtime/node" "$base/scripts/install.mjs"\n';
const launchName = windows ? 'Autoum.cmd' : platform === 'darwin' ? 'Autoum.command' : 'Autoum';
await writeFile(join(destination, launchName), launch, { mode: 0o755 });
await writeFile(join(destination, windows ? 'Setup.cmd' : platform === 'darwin' ? 'Setup.command' : 'Setup'), setup, { mode: 0o755 });
const output = join(root, 'releases', bundleName + (windows ? '.zip' : '.tar.gz'));
if (windows) {
  // ZIP is created on any packaging host through the bundled Python runtime or system zip.
  execFileSync('python3', ['-c', 'import shutil,sys;shutil.make_archive(sys.argv[1],"zip",sys.argv[2],sys.argv[3])', output.slice(0, -4), join(root, 'releases'), bundleName]);
} else execFileSync('tar', ['-czf', output, '-C', join(root, 'releases'), bundleName]);
await writeFile(output + '.sha256', `${await sha256(output)}  ${output.split('/').at(-1)}\n`);
console.log(`Bundle ready: ${output}`);
