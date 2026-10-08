// Build the standalone Linux edition from the verified portable runtime.
import { mkdir, cp, readFile, writeFile, chmod, access } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { root } from './paths.mjs';
import { sha256 } from './download.mjs';
const source = join(root, 'releases/Autoum-0.1.0-linux-x64');
const name = 'Autoum-Extension-0.1.0-linux-x64', target = join(root, 'releases', name);
await access(join(source, 'runtime/node')); await mkdir(target, { recursive: true });
for (const path of ['runtime', 'node_modules', 'package.json', 'package-lock.json', 'dist', 'LICENSE', 'THIRD_PARTY_NOTICES.md']) await cp(join(source, path), join(target, path), { recursive: true });
for (const path of ['scripts', 'docs/INSTALL-EXTENSION.md', 'docs/RELEASE.md']) { await mkdir(join(target, path, '..'), { recursive: true }); await cp(join(root, path), join(target, path), { recursive: true }); }
const manifestPath = join(target, 'dist/extension/manifest.json'); const manifest = JSON.parse(await readFile(manifestPath, 'utf8')); delete manifest.chrome_url_overrides; await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
await writeFile(join(target, 'README.md'), await readFile(join(root, 'docs/INSTALL-EXTENSION.md')));
await writeFile(join(target, 'Setup-extension'), '#!/bin/sh\nbase=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexec "$base/runtime/node" "$base/scripts/install-extension.mjs" "$@"\n', { mode: 0o755 }); await chmod(join(target, 'Setup-extension'), 0o755);
const output = join(root, 'releases', name + '.tar.gz');
execFileSync('tar', ['-czf', output, '-C', join(root, 'releases'), name]);
await writeFile(output + '.sha256', `${await sha256(output)}  ${name}.tar.gz\n`);
console.log('Standalone extension ready: ' + output);
