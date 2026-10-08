import { mkdir, writeFile, readFile, chmod, lstat, access, cp } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { root, dataDir, profileDir, nodePath, identity, shellQuote } from './paths.mjs';
export async function install({ desktop = true } = {}) {
  if (await lstat(join(profileDir, 'SingletonLock')).then(() => true).catch(() => false)) throw Error('Close Autoum before running Setup.');
  if (process.platform === 'darwin' && await access(join(root, 'browser/Thorium.dmg')).then(() => true).catch(() => false)
      && !await access(join(root, 'browser/Thorium.app')).then(() => true).catch(() => false)) {
    const mount = join(dataDir, 'thorium-mount'); await mkdir(mount, { recursive: true });
    const attach = spawnSync('hdiutil', ['attach', join(root, 'browser/Thorium.dmg'), '-readonly', '-nobrowse', '-mountpoint', mount], { stdio: 'pipe' });
    if (attach.status !== 0) throw Error('Could not mount the bundled Thorium disk image.');
    try { await cp(join(mount, 'Thorium.app'), join(root, 'browser/Thorium.app'), { recursive: true }); }
    finally { spawnSync('hdiutil', ['detach', mount], { stdio: 'pipe' }); }
  }
  const { extensionId } = await identity(); await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await mkdir(join(profileDir, 'Default'), { recursive: true, mode: 0o700 });
  const hostDir = join(dataDir, 'native-host'); await mkdir(hostDir, { recursive: true, mode: 0o700 });
  let hostPath;
  if (process.platform === 'win32') {
    hostPath = join(hostDir, 'autoum-agent.exe');
    await writeFile(join(hostDir, 'launch.txt'), [nodePath, join(root, 'dist/host/main.mjs'), dataDir, profileDir].join('\r\n'));
    const source = join(root, 'scripts/windows-host.cs');
    // Use Windows' built-in .NET compiler; Chromium launches an executable, not a batch file.
    const compiler = join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
    const result = spawnSync(compiler, ['/nologo', '/target:exe', `/out:${hostPath}`, source], { windowsHide: true, stdio: 'pipe' });
    if (result.status !== 0) throw Error('Could not create the Windows native host. .NET Framework 4.5 or newer is required.');
  } else {
    hostPath = join(hostDir, 'autoum-agent');
    await writeFile(hostPath, `#!/bin/sh\nexport AUTOUM_DATA_DIR=${shellQuote(dataDir)}\nexport AUTOUM_PROFILE_DIR=${shellQuote(profileDir)}\nexec ${shellQuote(nodePath)} ${shellQuote(join(root, 'dist/host/main.mjs'))} "$@"\n`, { mode: 0o700 }); await chmod(hostPath, 0o700);
  }
  const manifest = { name: 'rocks.autoum.agent', description: 'Autoum local Pi browser agent', path: hostPath, type: 'stdio', allowed_origins: [`chrome-extension://${extensionId}/`] };
  const folders = [join(profileDir, 'NativeMessagingHosts')];
  if (process.env.AUTOUM_PROFILE_ONLY !== '1' && process.platform === 'linux') for (const name of ['thorium', 'chromium', 'google-chrome']) folders.push(join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), name, 'NativeMessagingHosts'));
  if (process.env.AUTOUM_PROFILE_ONLY !== '1' && process.platform === 'darwin') for (const name of ['Thorium', 'Chromium', 'Google/Chrome']) folders.push(join(homedir(), 'Library/Application Support', name, 'NativeMessagingHosts'));
  for (const folder of folders) { await mkdir(folder, { recursive: true, mode: 0o700 }); await writeFile(join(folder, 'rocks.autoum.agent.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 }); }
  if (process.platform === 'win32') {
    const manifestPath = join(hostDir, 'rocks.autoum.agent.json'); await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
    for (const name of ['Thorium', 'Chromium', 'Google\\Chrome']) {
      const result = spawnSync('reg.exe', ['add', `HKCU\\Software\\${name}\\NativeMessagingHosts\\rocks.autoum.agent`, '/ve', '/t', 'REG_SZ', '/d', manifestPath, '/f'], { windowsHide: true });
      if (result.status !== 0) throw Error('Native messaging registration failed.');
    }
  }
  // Only edit an inactive Autoum-owned profile. Browser-owned files must not be rewritten while running.
  const prefsPath = join(profileDir, 'Default/Preferences');
  let prefs = {}; try { prefs = JSON.parse(await readFile(prefsPath, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  prefs.extensions ||= {}; prefs.extensions.settings ||= {};
  prefs.extensions.settings[extensionId] ||= {}; prefs.extensions.settings[extensionId].allow_file_access = true;
  prefs.browser ||= {}; prefs.browser.check_default_browser = false;
  if (process.platform === 'linux' && prefs.browser.custom_chrome_frame === undefined) prefs.browser.custom_chrome_frame = true;
  prefs.session ||= {}; prefs.session.restore_on_startup = 1;
  prefs.download ||= {}; prefs.download.default_directory = join(homedir(), 'Downloads');
  await writeFile(prefsPath, JSON.stringify(prefs), { mode: 0o600 });
  if (desktop && process.platform === 'linux') {
    const applications = join(homedir(), '.local/share/applications'); await mkdir(applications, { recursive: true });
    const launcher = join(dataDir, 'autoum-browser');
    await writeFile(launcher, `#!/bin/sh\nexec ${shellQuote(nodePath)} ${shellQuote(join(root, 'scripts/launch.mjs'))} "$@"\n`, { mode: 0o755 });
    await writeFile(join(applications, 'autoum-browser.desktop'), `[Desktop Entry]\nName=Autoum Browser\nComment=Your personal AI browser\nExec="${launcher}" %U\nIcon=${join(root, 'dist/extension/icons/128.png')}\nTerminal=false\nType=Application\nStartupWMClass=Autoum\nCategories=Network;WebBrowser;\nMimeType=text/html;x-scheme-handler/http;x-scheme-handler/https;\n`);
  }
  if (desktop && process.platform === 'win32') {
    const quote = value => "'" + value.replaceAll("'", "''") + "'";
    const shortcut = `$shell=New-Object -ComObject WScript.Shell; $link=$shell.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Desktop')) 'Autoum.lnk')); $link.TargetPath=${quote(nodePath)}; $link.Arguments=${quote('"' + join(root, 'scripts/launch.mjs') + '"')}; $link.WorkingDirectory=${quote(root)}; $link.IconLocation=${quote(join(root, 'dist/extension/icons/Autoum.ico'))}; $link.Description='Your personal AI browser'; $link.Save()`;
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', shortcut], { windowsHide: true, stdio: 'pipe' });
    if (result.status !== 0) throw Error('Could not create the Autoum desktop shortcut.');
  }
  if (desktop && process.platform === 'darwin') {
    const app = join(homedir(), 'Applications/Autoum.app/Contents');
    await mkdir(join(app, 'MacOS'), { recursive: true });
    await mkdir(join(app, 'Resources'), { recursive: true });
    await cp(join(root, 'dist/extension/icons/Autoum.icns'), join(app, 'Resources/Autoum.icns'));
    await writeFile(join(app, 'Info.plist'), '<?xml version="1.0"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIconFile</key><string>Autoum.icns</string><key>CFBundleExecutable</key><string>Autoum</string><key>CFBundleIdentifier</key><string>rocks.autoum.browser</string><key>CFBundleName</key><string>Autoum</string></dict></plist>');
    await writeFile(join(app, 'MacOS/Autoum'), `#!/bin/sh\nexec ${shellQuote(nodePath)} ${shellQuote(join(root, 'scripts/launch.mjs'))} "$@"\n`, { mode: 0o755 });
  }
  console.log('Autoum installed for this user. Start it with npm start or its desktop launcher.');
  return { extensionId, profileDir };
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await install({ desktop: !process.argv.includes('--no-desktop') });
