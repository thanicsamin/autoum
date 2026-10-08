import { mkdir, readFile, writeFile, rename, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
export const dataDir = process.env.AUTOUM_DATA_DIR || (process.platform === 'win32'
  ? join(process.env.LOCALAPPDATA || homedir(), 'Autoum')
  : process.platform === 'darwin' ? join(homedir(), 'Library', 'Application Support', 'Autoum')
  : join(process.env.XDG_DATA_HOME || join(homedir(), '.local/share'), 'autoum'));
export async function readJson<T>(path: string, fallback: T): Promise<T> {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (e: any) { if (e.code === 'ENOENT') return fallback; throw e; }
}
export async function saveJson(path: string, data: unknown) {
  const { dirname } = await import('node:path'); await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${crypto.randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(data, null, 2), { mode: 0o600 });
  await rename(temp, path); if (process.platform !== 'win32') await chmod(path, 0o600);
}
