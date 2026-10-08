import { brandBrowser } from './brand-browser.mjs';
import { spawn } from 'node:child_process';
import { mkdir, access, stat, lstat, readFile, writeFile } from 'node:fs/promises';
import { root, profileDir, extensionDir, browserPath, identity } from './paths.mjs';
import { join, relative, isAbsolute } from 'node:path';
import { install } from './install.mjs';
await identity(); await mkdir(profileDir, { recursive: true });
const installed = await access(join(profileDir, 'NativeMessagingHosts/rocks.autoum.agent.json')).then(() => true).catch(() => false);
if (!installed) await install();
// Apply the Linux frame default to older profiles only while the browser is closed.
// Keep any explicit user choice; a running browser owns its preference file.
if (process.platform === 'linux' && !await lstat(join(profileDir, 'SingletonLock')).then(() => true).catch(() => false)) {
  const preferencesPath = join(profileDir, 'Default/Preferences');
  const preferences = JSON.parse(await readFile(preferencesPath, 'utf8')); preferences.browser ||= {};
  if (preferences.browser.custom_chrome_frame === undefined) { preferences.browser.custom_chrome_frame = true; await writeFile(preferencesPath, JSON.stringify(preferences), { mode: 0o600 }); }
}
const executable = await browserPath();
const ownedPath = relative(join(root, 'browser'), executable);
if (!ownedPath.startsWith('..') && !isAbsolute(ownedPath) && !await access(join(root, 'browser/branding.json')).then(() => true).catch(() => false)) await brandBrowser(join(root, 'browser'));
const env = { ...process.env };
if (process.platform === 'linux' && !env.CHROME_DEVEL_SANDBOX) {
  for (const path of ['/usr/lib/chromium/chrome-sandbox', '/opt/google/chrome/chrome-sandbox']) {
    const metadata = await stat(path).catch(() => undefined);
    if (metadata?.uid === 0 && metadata.mode & 0o4000) { env.CHROME_DEVEL_SANDBOX = path; break; }
  }
}
const browser = spawn(executable, [`--user-data-dir=${profileDir}`, `--load-extension=${extensionDir}`, '--no-first-run', '--no-default-browser-check', ...(process.platform === 'linux' ? ['--class=Autoum', '--name=Autoum'] : []), ...process.argv.slice(2)], { stdio: 'inherit', env });
browser.on('error', e => { console.error(e.message); process.exitCode = 1; });
browser.on('exit', code => { process.exitCode = code || 0; });
