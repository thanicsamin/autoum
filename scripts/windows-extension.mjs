import { access, cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { extensionWorkerIdentity } from './extension-version.mjs';
import { copyBuild } from './copy-build.mjs';

const execute = promisify(execFile);
const exists = path => access(path).then(() => true).catch(() => false);
const browsers = { vivaldi: { name: 'Vivaldi', executable: 'vivaldi.exe', folder: 'Vivaldi/User Data', host: 'rocks.autoum.vivaldi' }, 'google-chrome': { name: 'Chrome', executable: 'chrome.exe', folder: 'Google/Chrome/User Data', host: 'rocks.autoum.chrome' } };
const absoluteWindowsPath = path => typeof path === 'string' && /^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+[\\/])/.test(path) && !/[\r\n]/.test(path);
export function windowsExtensionPlan({ browser = 'vivaldi', localAppData, destination, configRoot } = {}) {
  const choice = browsers[browser];
  if (!choice) throw Error('Choose vivaldi or google-chrome.');
  if (!localAppData || !absoluteWindowsPath(localAppData)) throw Error('Windows Local AppData must be an absolute folder.');
  const target = destination || win32.join(localAppData, 'Autoum-Extension', browser);
  const profile = configRoot || win32.join(localAppData, choice.folder);
  if (![target, profile].every(p => absoluteWindowsPath(p))) throw Error('Choose absolute Windows folders.');
  return { browser, ...choice, target, profile, data: win32.join(target, 'data'), extension: win32.join(target, 'extension'), companion: win32.join(target, 'companion'),
    helper: win32.join(target, 'autoum-agent.exe'), manifestPath: win32.join(target, choice.host + '.json'),
    registry: ['Google\\Chrome', 'Chromium'].flatMap(name => [32, 64].map(view => ({ key: 'HKCU\\Software\\' + name + '\\NativeMessagingHosts\\' + choice.host, view }))) };
}
export function windowsRegistryValue(output) { return output.match(/REG_(?:EXPAND_)?SZ\s+([^\r\n]+)/)?.[1]?.trim(); }
export function windowsWorker(bytes, host, previous = {}) {
  if (!Object.values(browsers).some(b => b.host === host)) throw Error('Unknown extension companion.');
  const text = bytes.toString('utf8');
  if (text.split('rocks.autoum.agent').length !== 2) throw Error('The compiled extension native host changed; rebuild this installer.');
  const patched = Buffer.from(text.replace('rocks.autoum.agent', host));
  return { bytes: patched, ...extensionWorkerIdentity(patched, previous) };
}
async function queryRegistry(entry) {
  try { return windowsRegistryValue((await execute('reg.exe', ['query', entry.key, '/ve', '/reg:' + entry.view], { windowsHide: true })).stdout); }
  catch (error) { if (error.code === 1) return undefined; throw error; }
}
const samePath = (a, b) => win32.normalize(a).toLowerCase() === win32.normalize(b).toLowerCase();
async function preflight(plan) {
  const tasks = await execute('tasklist.exe', ['/fo', 'csv', '/nh', '/fi', 'IMAGENAME eq ' + plan.executable], { windowsHide: true });
  if (tasks.stdout.toLowerCase().includes('"' + plan.executable + '"')) throw Error('Close ' + plan.name + ' before installing or updating Autoum.');
  for (const entry of plan.registry) {
    const old = await queryRegistry(entry);
    if (old && !samePath(old, plan.manifestPath)) throw Error('An existing ' + plan.name + ' Autoum companion uses a different folder. Uninstall that copy first.');
  }
}
export async function installWindowsExtension({ browser = 'vivaldi', destination, runtimeRoot, configRoot, importData } = {}) {
  if (process.platform !== 'win32') throw Error('Run the Windows extension installer on Windows.');
  const plan = windowsExtensionPlan({ browser, destination, configRoot, localAppData: process.env.LOCALAPPDATA || homedir() });
  const packaged = resolve(fileURLToPath(new URL('../', import.meta.url)));
  const root = runtimeRoot || (await exists(join(packaged, 'runtime/node.exe')) ? packaged : join(packaged, 'releases/Autoum-0.1.0-win32-x64'));
  for (const path of ['runtime/node.exe', 'dist/host/main.mjs', 'dist/mcp-relay.mjs', 'dist/extension/manifest.json', 'scripts/windows-host.cs']) await access(join(root, path));
  const compiler = join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
  await access(compiler);
  await preflight(plan);
  if (importData) throw Error('Windows extension setup keeps accounts separate. Connect your accounts in its Settings.');
  const old = await readFile(join(plan.target, 'extension-build.json'), 'utf8').then(JSON.parse).catch(error => { if (error.code === 'ENOENT') return {}; throw error; });
  const manifest = JSON.parse(await readFile(join(root, 'dist/extension/manifest.json'), 'utf8'));
  const worker = windowsWorker(await readFile(join(root, 'dist/extension', manifest.background.service_worker)), plan.host, old);
  const { extensionId } = JSON.parse(await readFile(join(root, 'dist/build.json'), 'utf8'));
  await mkdir(plan.target, { recursive: true }); await mkdir(plan.companion, { recursive: true });
  const temporaryHelper = plan.helper + '.new.exe';
  try {
    await execute(compiler, ['/nologo', '/target:exe', '/out:' + temporaryHelper, join(root, 'scripts/windows-host.cs')], { windowsHide: true });
    await rename(temporaryHelper, plan.helper);
  } catch { throw Error('Could not create the native companion. Windows .NET Framework 4.5 or newer is required.'); }
  finally { await rm(temporaryHelper, { force: true }); }
  const lock = await readFile(join(root, 'package-lock.json'));
  const oldLock = await readFile(join(plan.companion, 'package-lock.json')).catch(() => Buffer.alloc(0));
  if (!lock.equals(oldLock)) {
    await rm(join(plan.companion, 'node_modules'), { recursive: true, force: true });
    await cp(join(root, 'node_modules'), join(plan.companion, 'node_modules'), { recursive: true });
  }
  // No browser-owned Preferences or account data are edited by setup.
  for (const name of ['runtime', 'dist/host', 'dist/mcp-relay.mjs', 'dist/extension/logo.svg', 'package.json', 'package-lock.json']) await cp(join(root, name), join(plan.companion, name), { recursive: true });
  await copyBuild(join(root, 'dist/extension'), plan.extension, { standalone: true });
  await writeFile(join(plan.extension, worker.extensionWorker), worker.bytes);
  manifest.background.service_worker = worker.extensionWorker; manifest.version = worker.extensionVersion; delete manifest.chrome_url_overrides;
  await writeFile(join(plan.extension, 'manifest.json'), JSON.stringify(manifest, null, 2));
  await writeFile(join(plan.target, 'extension-build.json'), JSON.stringify({ version: '0.1.0', extensionWorker: worker.extensionWorker, workerRevision: worker.workerRevision }, null, 2));
  await mkdir(plan.data, { recursive: true });
  await writeFile(join(plan.target, 'launch.txt'), [join(plan.companion, 'runtime/node.exe'), join(plan.companion, 'dist/host/main.mjs'), plan.data, plan.profile].join('\r\n'));
  await writeFile(plan.manifestPath, JSON.stringify({ name: plan.host, description: 'Autoum ' + plan.name + ' companion', path: plan.helper, type: 'stdio', allowed_origins: ['chrome-extension://' + extensionId + '/'] }, null, 2));
  for (const entry of plan.registry) await execute('reg.exe', ['add', entry.key, '/ve', '/t', 'REG_SZ', '/d', plan.manifestPath, '/f', '/reg:' + entry.view], { windowsHide: true });
  await writeFile(join(plan.target, 'installation.json'), JSON.stringify({ ...plan, extensionId }, null, 2));
  return { browser, extensionId, extension: plan.extension, helper: plan.helper, data: plan.data, profile: plan.profile, host: plan.host };
}
export async function uninstallWindowsExtension({ browser = 'vivaldi', destination, configRoot } = {}) {
  if (process.platform !== 'win32') throw Error('Run the Windows extension uninstaller on Windows.');
  const plan = windowsExtensionPlan({ browser, destination, configRoot, localAppData: process.env.LOCALAPPDATA || homedir() });
  if (!await exists(join(plan.target, 'installation.json'))) return { browser, removed: false };
  await preflight(plan);
  for (const entry of plan.registry) {
    const value = await queryRegistry(entry);
    if (value && samePath(value, plan.manifestPath)) await execute('reg.exe', ['delete', entry.key, '/f', '/reg:' + entry.view], { windowsHide: true });
  }
  // Keep the independent accounts/chats/data so reinstalling can recover them.
  for (const name of ['companion', 'extension', 'autoum-agent.exe', 'launch.txt', plan.host + '.json', 'installation.json', 'extension-build.json']) await rm(join(plan.target, name), { force: true, recursive: true });
  return { browser, removed: true, dataPreserved: plan.data };
}
