import { access, chmod, cp, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { shellQuote } from './paths.mjs';

export async function installVivaldiLauncher(extension, target, applications = join(homedir(), '.local/share/applications')) {
  const launcher = join(target, 'vivaldi-with-autoum');
  await writeFile(launcher, `#!/bin/sh\nexec /usr/bin/vivaldi-stable --load-extension=${shellQuote(extension)} "$@"\n`, { mode: 0o700 }); await chmod(launcher, 0o700);
  await mkdir(applications, { recursive: true });
  const desktop = join(applications, 'vivaldi-stable.desktop');
  let original;
  try { original = await readFile(desktop, 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; original = await readFile('/usr/share/applications/vivaldi-stable.desktop', 'utf8'); }
  if (original.includes(`Exec="${launcher}"`)) return;
  if (!/^Exec=\/usr\/bin\/vivaldi-stable(?:\s|$)/m.test(original)) throw Error('Custom Vivaldi launcher found; install the unpacked extension through Vivaldi instead.');
  try { await cp(desktop, join(target, `vivaldi-desktop-backup-${Date.now()}.desktop`)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const escaped = launcher.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('`', '\\`').replaceAll('$', '\\$');
  await writeFile(desktop, original.replace(/^Exec=\/usr\/bin\/vivaldi-stable(?=\s|$)/gm, `Exec="${escaped}"`), { mode: 0o644 });
}

// Standalone installation deliberately avoids install.mjs: that installer owns
// the bundled browser profile. Each ordinary browser gets its own agent store.
export async function installExtension({ browser = 'vivaldi', destination, runtimeRoot, configRoot, importData, desktop = true } = {}) {
  if (process.platform !== 'linux') throw Error('This standalone installer currently supports Linux.');
  if (!['vivaldi', 'google-chrome'].includes(browser)) throw Error('Choose vivaldi or google-chrome.');
  const packaged = resolve(fileURLToPath(new URL('../', import.meta.url)));
  const root = runtimeRoot || (await access(join(packaged, 'runtime/node')).then(() => true).catch(() => false) ? packaged : join(packaged, 'releases/Autoum-0.1.0-linux-x64'));
  const target = destination || join(homedir(), '.local/share', `autoum-${browser}`);
  const profile = join(configRoot || process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), browser);
  if (await lstat(join(profile, 'SingletonLock')).then(() => true).catch(() => false)) throw Error('Close the target browser before installing or updating Autoum.');
  const exists = path => access(path).then(() => true).catch(() => false);
  await access(join(root, 'dist/host/main.mjs'));
  await access(join(root, 'runtime/node'));
  await mkdir(target, { recursive: true, mode: 0o700 });
  const companion = join(target, 'companion');
  await mkdir(companion, { recursive: true, mode: 0o700 });
  for (const name of ['runtime', 'dist/host', 'dist/mcp-relay.mjs', 'dist/extension/logo.svg', 'node_modules', 'package.json']) {
    await cp(join(root, name), join(companion, name), { recursive: true });
  }
  const extension = join(target, 'extension');
  await cp(join(root, 'dist/extension'), extension, { recursive: true });
  const manifest = JSON.parse(await readFile(join(extension, 'manifest.json'), 'utf8'));
  delete manifest.chrome_url_overrides;
  await writeFile(join(extension, 'manifest.json'), JSON.stringify(manifest, null, 2));
  const { extensionId } = JSON.parse(await readFile(join(root, 'dist/build.json'), 'utf8'));
  const data = join(target, 'data'); await mkdir(data, { recursive: true, mode: 0o700 });
  if (importData && !await exists(join(data, 'settings.json'))) {
    // Copy account configuration privately; do not share a mutable agent store
    // with the running standalone browser or import pending chat work.
    const sourceSettings = join(importData, 'settings.json');
    if (await exists(sourceSettings)) {
      const settings = JSON.parse(await readFile(sourceSettings, 'utf8'));
      settings.chats = []; settings.folders = []; delete settings.activeChatId;
      await writeFile(join(data, 'settings.json'), JSON.stringify(settings), { mode: 0o600 });
    }
    for (const name of ['accounts.json', 'mcp.json', 'pi/auth.json', 'pi/models.json', 'memory']) {
      if (await exists(join(importData, name))) {
        await mkdir(join(data, name, '..'), { recursive: true, mode: 0o700 });
        await cp(join(importData, name), join(data, name), { recursive: true });
      }
    }
    const accounts = join(importData, 'accounts');
    for (const id of await readdir(accounts).catch(() => [])) {
      for (const name of ['auth.json', 'models.json', 'antigravity/models.json', 'antigravity/status.json', 'antigravity/antigravity-acp/acp_token.json', 'antigravity/antigravity-acp/settings.json']) {
        const source = join(accounts, id, name), dest = join(data, 'accounts', id, name);
        if (await exists(source)) { await mkdir(join(dest, '..'), { recursive: true, mode: 0o700 }); await cp(source, dest); await chmod(dest, 0o600); }
      }
    }
    for (const name of ['antigravity/status.json', 'antigravity/models.json', 'antigravity/antigravity-acp/acp_token.json', 'antigravity/antigravity-acp/settings.json']) {
      if (await exists(join(importData, name))) { await mkdir(join(data, name, '..'), { recursive: true, mode: 0o700 }); await cp(join(importData, name), join(data, name)); await chmod(join(data, name), 0o600); }
    }
    for (const name of ['runtimes/antigravity/agy_acp_server.par', 'runtimes/antigravity/localharness_external']) {
      if (await exists(join(importData, name))) { await mkdir(join(data, name, '..'), { recursive: true, mode: 0o700 }); await cp(join(importData, name), join(data, name)); }
    }
  }
  const helper = join(target, 'autoum-agent');
  await writeFile(helper, `#!/bin/sh\nexport AUTOUM_DATA_DIR=${shellQuote(data)}\nexport AUTOUM_PROFILE_DIR=${shellQuote(profile)}\nexec ${shellQuote(join(companion, 'runtime/node'))} ${shellQuote(join(companion, 'dist/host/main.mjs'))} "$@"\n`, { mode: 0o700 }); await chmod(helper, 0o700);
  const hosts = join(profile, 'NativeMessagingHosts'); await mkdir(hosts, { recursive: true, mode: 0o700 });
  const hostFile = join(hosts, 'rocks.autoum.agent.json');
  if (await exists(hostFile)) await cp(hostFile, join(target, `native-host-backup-${Date.now()}.json`));
  await writeFile(hostFile, JSON.stringify({ name: 'rocks.autoum.agent', description: 'Autoum browser assistant', path: helper, type: 'stdio', allowed_origins: [`chrome-extension://${extensionId}/`] }, null, 2), { mode: 0o600 });
  if (desktop && browser === 'vivaldi') await installVivaldiLauncher(extension, target);
  return { extensionId, extension, helper, data, profile };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const browser = process.argv.includes('--chrome') ? 'google-chrome' : 'vivaldi';
  const importData = process.argv.includes('--import-settings') ? join(homedir(), '.local/share/autoum') : undefined;
  console.log(JSON.stringify(await installExtension({ browser, importData }), null, 2));
}
