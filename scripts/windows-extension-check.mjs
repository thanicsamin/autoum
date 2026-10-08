// Run only on a disposable Windows runner; exercise the actual shipped setup.
import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { windowsExtensionPlan, windowsRegistryValue, installWindowsExtension } from './windows-extension.mjs';
const execute = promisify(execFile);
if (process.platform !== 'win32' || process.env.GITHUB_ACTIONS !== 'true') throw Error('Use a disposable GitHub Windows runner.');
const installer = process.argv[2];
await access(installer);
const temporary = await mkdtemp(join(tmpdir(), 'Autoum extension test '));
const program = join(temporary, 'Installed App');
const home = join(temporary, 'Synthetic User'); await mkdir(home);
const plans = ['google-chrome', 'vivaldi'].map(browser => windowsExtensionPlan({ browser, localAppData: process.env.LOCALAPPDATA }));
async function registry(entry) {
  return execute('reg.exe', ['query', entry.key, '/ve', '/reg:' + entry.view]).then(r => windowsRegistryValue(r.stdout)).catch(e => { if (e.code === 1) return undefined; throw e; });
}
async function native(helper, request, args = [], extraEnv = {}) {
  const child = spawn(helper, args, { windowsHide: true, env: { ...process.env, HOME: home, USERPROFILE: home, AUTOUM_DISABLE_ACCOUNT_DETECTION: '1', AUTOUM_DISABLE_MODEL_NETWORK: '1', AUTOUM_DISABLE_USAGE_NETWORK: '1', ...extraEnv } });
  let buffer = Buffer.alloc(0), errors = '', receivedBytes = 0;
  child.stderr.on('data', bytes => { errors += bytes; });
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill(); reject(Error('Native reply timed out: receivedBytes=' + receivedBytes + ', receivedReply=' + Boolean(reply) + ', stderr=' + errors)); }, 60000);
    let reply;
    child.on('error', reject);
    child.stdout.on('data', bytes => {
      receivedBytes += bytes.length; buffer = Buffer.concat([buffer, bytes]);
      while (buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32LE()) {
        const size = buffer.readUInt32LE(); const packet = JSON.parse(buffer.subarray(4, 4 + size).toString()); buffer = buffer.subarray(4 + size);
        if (packet.reply === request.id) { reply = packet; child.stdin.end(); }
      }
    });
    child.on('close', code => { clearTimeout(timeout); if (code !== 0 || !reply || reply.error) reject(Error('Native companion failed: ' + JSON.stringify(reply) + errors)); else resolve(reply.data); });
    const bytes = Buffer.from(JSON.stringify(request)), size = Buffer.alloc(4); size.writeUInt32LE(bytes.length); child.stdin.write(Buffer.concat([size, bytes]));
  });
}
async function setup() {
  try { await execute(installer, ['/S', '/D=' + program], { timeout: 600000 }); }
  catch (error) { console.error(await readFile(join(program, 'setup-last.log'), 'utf8').catch(() => 'No installer log')); throw error; }
}
const fullBrowser = plans[0].registry.map(entry => ({ ...entry, key: entry.key.replace(plans[0].host, 'rocks.autoum.agent') }));
const fullBrowserBefore = await Promise.all(fullBrowser.map(registry));
const start = performance.now();
await setup();
const checks = [];
for (const plan of plans) {
  const manifest = JSON.parse(await readFile(join(plan.extension, 'manifest.json')));
  assert(!manifest.chrome_url_overrides, 'Existing browser new-tab page must be preserved');
  const worker = await readFile(join(plan.extension, manifest.background.service_worker), 'utf8');
  assert(worker.includes(plan.host)); assert(!worker.includes('rocks.autoum.agent'));
  const host = JSON.parse(await readFile(plan.manifestPath)); assert.equal(host.path, plan.helper); assert.equal(host.name, plan.host); assert.equal(host.allowed_origins.length, 1);
  for (const entry of plan.registry) assert.equal(await registry(entry), plan.manifestPath);
  const direct = await native(join(plan.companion, 'runtime/node.exe'), { id: 'direct-state', type: 'state', data: {} }, [join(plan.companion, 'dist/host/main.mjs')], { AUTOUM_DATA_DIR: plan.data, AUTOUM_PROFILE_DIR: plan.profile });
  assert(Array.isArray(direct.chats)); console.log(plan.browser + ': direct bundled Node host replied');
  const state = await native(plan.helper, { id: 'state-test', type: 'state', data: {} });
  assert(Array.isArray(state.chats)); assert.equal(state.accounts.length, 0);
  await native(plan.helper, { id: 'permission-test', type: 'defaults', data: { mode: 'auto-review' } });
  await writeFile(join(plan.data, 'preserve.txt'), 'synthetic chat/account data');
  checks.push({ browser: plan.browser, host: plan.host, nativeReply: true, registryViews: [32, 64], extensionVersion: manifest.version });
}
const installMs = performance.now() - start;
const savedVersions = await Promise.all(plans.map(p => readFile(join(p.extension, 'manifest.json'))));
const updateStart = performance.now();
await setup();
for (let i = 0; i < plans.length; i++) {
  const plan = plans[i];
  assert.equal(await readFile(join(plan.data, 'preserve.txt'), 'utf8'), 'synthetic chat/account data');
  assert.deepEqual(await readFile(join(plan.extension, 'manifest.json')), savedVersions[i]);
  assert.equal(JSON.parse(await readFile(join(plan.data, 'settings.json'))).lastMode, 'auto-review');
}
// Foreign registrations cannot be overwritten, and the full-browser helper stays untouched.
const plan = plans[0], entry = plan.registry[0];
const foreign = join(temporary, 'Existing Companion.json');
await execute('reg.exe', ['add', entry.key, '/ve', '/t', 'REG_SZ', '/d', foreign, '/f', '/reg:' + entry.view]);
await assert.rejects(installWindowsExtension({ browser: plan.browser, runtimeRoot: program }), /different folder/);
assert.equal(await registry(entry), foreign);
await execute('reg.exe', ['add', entry.key, '/ve', '/t', 'REG_SZ', '/d', plan.manifestPath, '/f', '/reg:' + entry.view]);
const updateMs = performance.now() - updateStart;
await execute(join(program, 'Uninstall.exe'), ['/S', '_?=' + program], { timeout: 600000 });
for (const plan of plans) {
  for (const entry of plan.registry) assert.equal(await registry(entry), undefined);
  await assert.rejects(access(plan.helper)); await assert.rejects(access(plan.extension));
  assert.equal(await readFile(join(plan.data, 'preserve.txt'), 'utf8'), 'synthetic chat/account data');
  assert.equal(JSON.parse(await readFile(join(plan.data, 'settings.json'))).lastMode, 'auto-review');
}
assert.deepEqual(await Promise.all(fullBrowser.map(registry)), fullBrowserBefore);
const result = { fullBrowserRegistrationPreserved: true, ok: true, checks, installMs, updateMs, upgradePreservesData: true, uninstallPreservesData: true, collisionProtected: true, installerBytes: (await stat(installer)).size };
await writeFile(join(temporary, 'result.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
