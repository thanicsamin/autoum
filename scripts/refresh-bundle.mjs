import { copyBuild } from './copy-build.mjs';
import { brandBrowser } from './brand-browser.mjs';
// Refresh existing bundles after a source/UI change without reinstalling unchanged dependencies.
import { root } from './paths.mjs';
import { sha256 } from './download.mjs';
import { cp, readFile, writeFile, access, rm, readdir, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
const target = process.argv[2];
if (!['linux-x64', 'win32-x64', 'darwin-x64', 'darwin-arm64'].includes(target)) throw Error('Choose a supported existing bundle.');
const name = 'Autoum-0.1.0-' + target, destination = join(root, 'releases', name);
await access(join(destination, 'runtime', target.startsWith('win32') ? 'node.exe' : 'node'));
const sourceLock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
const previousLock = JSON.parse(await readFile(join(destination, 'package-lock.json'), 'utf8'));
// Browser-only build dependencies ship as compiled assets. Refresh remains safe only
// when every installed production dependency and its integrity metadata is unchanged.
const production = lock => JSON.stringify({ dependencies: lock.packages[''].dependencies, packages: Object.fromEntries(Object.entries(lock.packages).filter(([key, value]) => key && !value.dev).sort(([a], [b]) => a.localeCompare(b))) });
const dependenciesChanged = production(sourceLock) !== production(previousLock);
if (dependenciesChanged && !process.argv.includes('--install-dependencies')) throw Error('Production dependencies changed. Use --install-dependencies to rebuild the bundle dependency tree, or the full package command.');
await copyBuild(join(root, 'dist'), join(destination, 'dist'));
for (const path of ['scripts', 'host/archive.ts', 'package.json', 'package-lock.json', 'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md'])
  await cp(join(root, path), join(destination, path), { recursive: true });
await rm(join(destination, 'docs'), { recursive: true, force: true });
await mkdir(join(destination, 'docs'), { recursive: true });
for (const file of ['DESIGN.md', 'INSTALL-EXTENSION.md', 'RELEASE.md']) await cp(join(root, 'docs', file), join(destination, 'docs', file));
if (dependenciesChanged) execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: destination, stdio: 'pipe', shell: process.platform === 'win32' });
await rm(join(destination, 'test-results'), { recursive: true, force: true });
await brandBrowser(join(destination, 'browser'), target);
const output = join(root, 'releases', name + (target.startsWith('win32') ? '.zip' : '.tar.gz'));
if (target.startsWith('win32')) execFileSync('python3', ['-c', 'import shutil,sys;shutil.make_archive(sys.argv[1],"zip",sys.argv[2],sys.argv[3])', output.slice(0, -4), join(root, 'releases'), name]);
else execFileSync('tar', ['-czf', output, '-C', join(root, 'releases'), name]);
await writeFile(output + '.sha256', `${await sha256(output)}  ${output.split('/').at(-1)}\n`);
console.log('Updated ' + output);
