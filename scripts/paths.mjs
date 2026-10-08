import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { access, readFile } from 'node:fs/promises';
export const root = fileURLToPath(new URL('../', import.meta.url));
export const dataDir = process.env.AUTOUM_DATA_DIR || (process.platform === 'win32' ? join(process.env.LOCALAPPDATA || homedir(), 'Autoum') : process.platform === 'darwin' ? join(homedir(), 'Library/Application Support/Autoum') : join(process.env.XDG_DATA_HOME || join(homedir(), '.local/share'), 'autoum'));
export const profileDir = process.env.AUTOUM_PROFILE_DIR || join(dataDir, 'browser-profile');
export const nodePath = await access(join(root, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node')).then(() => join(root, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node')).catch(() => process.execPath);
export const extensionDir = join(root, 'dist/extension');
export async function browserPath() {
  const windows = [process.env.LOCALAPPDATA, process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)']].filter(Boolean).flatMap(p => [join(p, 'Thorium/Application/thorium.exe'), join(p, 'Thorium/Application/chrome.exe')]);
  const candidates = [process.env.AUTOUM_BROWSER, join(root, 'browser/thorium'), join(root, 'browser/thorium.exe'), join(root, 'browser/chrome.exe'), join(root, 'browser/Thorium.app/Contents/MacOS/Thorium'),
    '/opt/thorium/thorium', '/opt/thorium-browser/thorium', '/usr/bin/thorium-browser', '/usr/bin/thorium',
    '/Applications/Thorium.app/Contents/MacOS/Thorium', ...windows].filter(Boolean);
  for (const candidate of candidates) if (await access(candidate).then(() => true).catch(() => false)) return candidate;
  throw Error('Thorium was not found. Run the browser download script, install Thorium, or set AUTOUM_BROWSER to its executable.');
}
export async function identity() { return JSON.parse(await readFile(join(root, 'dist/build.json'), 'utf8')); }
export function shellQuote(text) { return "'" + text.replaceAll("'", "'\\''") + "'"; }
