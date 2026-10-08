// Prepare a reviewed source snapshot without staging the owner's working tree.
import { mkdir, readdir, lstat, readFile, writeFile, cp } from 'node:fs/promises';
import { join, resolve, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { root } from './paths.mjs';
const destination = resolve(process.argv[2] || join(root, '.cache', 'github-export-' + Date.now()));
if (destination === resolve(root) || !destination.startsWith(join(root, '.cache') + '/')) throw Error('Use a new snapshot folder under .cache.');
await mkdir(destination, { recursive: false });
const selected = ['.github', '.gitignore', 'LICENSE', 'README.md', 'THIRD_PARTY_NOTICES.md', 'browser/upstream.json', 'extension', 'host', 'package.json', 'package-lock.json', 'scripts', 'tests', 'tsconfig.json', 'docs/DESIGN.md', 'docs/INSTALL-EXTENSION.md', 'docs/RELEASE.md'];
const files = [];
async function walk(path) {
  const info = await lstat(join(root, path));
  if (info.isSymbolicLink()) throw Error('Source snapshot cannot include symbolic links: ' + path);
  if (info.isDirectory()) { for (const name of await readdir(join(root, path))) await walk(join(path, name)); return; }
  const bytes = await readFile(join(root, path));
  if (info.size < 8 * 1024 * 1024 && !/\.(?:png|ico|icns|wav|woff2?)$/.test(path)) {
    const text = bytes.toString('utf8');
    if (/^-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----\s*$/m.test(text) || [...text.matchAll(/\bsk-(?:proj-|ant-|or-v1-)?[A-Za-z0-9_-]{24,}\b/g)].some(([key]) => !(path === 'scripts/provider-e2e.ts' && (key === ['sk', 'ant', 'oat03', 'fixture', 'personal'].join('-') || key === 'sk-' + 'fixtureleakcredential12345')))) throw Error('Potential credential in ' + path);
    const privateKey = await readFile('/tmp/phoenix-local-data/opencode-key', 'utf8').catch(() => '');
    if (privateKey.trim().length > 15 && text.includes(privateKey.trim())) throw Error('Private provider key found in ' + path);
  }
  files.push({ path, bytes: info.size, sha256: createHash('sha256').update(bytes).digest('hex') });
  const target = join(destination, path); await mkdir(join(target, '..'), { recursive: true }); await cp(join(root, path), target);
}
for (const path of selected) await walk(path);
const receipt = { destination: relative(root, destination), files, excluded: ['browser binaries', 'credentials', 'profiles', 'memory', 'chats', 'test results', 'overnight work logs', 'dependencies', 'release binaries', 'caches'], createdAt: new Date().toISOString() };
await writeFile(destination + '.json', JSON.stringify(receipt, null, 2));
console.log(JSON.stringify({ destination, files: files.length, bytes: files.reduce((sum, file) => sum + file.bytes, 0) }));
