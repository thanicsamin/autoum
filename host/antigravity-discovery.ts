import { stat } from 'node:fs/promises';
import { join, dirname, delimiter } from 'node:path';
import { homedir } from 'node:os';
import { readJson, saveJson } from './storage.ts';

async function file(path: string) { return stat(path).then(s => s.isFile()).catch(() => false); }
export async function discoverAntigravity(ownRuntime: string, home = homedir(), environment = process.env, platform = process.platform) {
  const paths = (environment.PATH || '').split(delimiter).filter(Boolean);
  const binaryNames = platform === 'win32' ? ['agy-acp-server.exe', 'agy_acp_server.exe'] : ['agy-acp-server', 'agy_acp_server.par'];
  const candidates = [environment.AUTOUM_ANTIGRAVITY_BINARY, ...paths.flatMap(p => binaryNames.map(n => join(p, n))), ownRuntime].filter(Boolean) as string[];
  let runtime: string | undefined;
  for (const candidate of candidates) {
    const harness = join(dirname(candidate), platform === 'win32' ? 'localharness_external.exe' : 'localharness_external');
    if (await file(candidate) && await file(harness)) { runtime = candidate; break; }
  }
  const appPaths = platform === 'darwin' ? ['/Applications/Antigravity.app/Contents/MacOS/Antigravity', join(home, 'Applications/Antigravity.app/Contents/MacOS/Antigravity')]
    : platform === 'win32' ? [join(environment.LOCALAPPDATA || home, 'Programs/Antigravity/Antigravity.exe')] : ['/opt/Antigravity/antigravity', '/opt/antigravity/antigravity', '/opt/antigravity-ide/antigravity'];
  const ide = (await Promise.all([...appPaths, ...paths.flatMap(p => ['antigravity', 'antigravity-ide'].map(n => join(p, platform === 'win32' ? n + '.exe' : n)))].map(file))).some(Boolean);
  const cli = (await Promise.all([join(home, '.local/bin', platform === 'win32' ? 'agy.exe' : 'agy'), ...paths.map(p => join(p, platform === 'win32' ? 'agy.exe' : 'agy'))].map(file))).some(Boolean);
  return { runtime, ide, cli };
}

// Reuse only the official ACP credential format. The CLI's nested token format
// is a separate grant/store; an installed or signed-in IDE alone proves no ACP login.
export async function importAntigravityAccount(profile: string, home = homedir()) {
  const destination = join(profile, 'antigravity-acp/acp_token.json');
  const valid = (value: any) => value && ['client_id', 'client_secret', 'refresh_token'].every(k => typeof value[k] === 'string' && value[k].length > 0);
  if (valid(await readJson(destination, {}).catch(() => ({})))) return undefined;
  const account = await readJson(join(home, '.gemini/antigravity-acp/acp_token.json'), {}).catch(() => ({}));
  if (!valid(account)) return undefined;
  await saveJson(destination, account); return 'Antigravity ACP';
}
