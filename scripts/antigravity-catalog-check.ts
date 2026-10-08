// Opt-in live catalog check: copies only the authorized ACP credential into a
// disposable profile, queries model metadata, and never sends a model prompt.
import { mkdtemp, mkdir, copyFile, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
const source = process.env.AUTOUM_TEST_ANTIGRAVITY_PROFILE;
if (!source || !process.env.AUTOUM_ANTIGRAVITY_BINARY) throw Error('Specify an authorized ACP profile and connector binary.');
const directory = await mkdtemp(join(tmpdir(), 'autoum-catalog-'));
process.env.AUTOUM_DATA_DIR = directory; process.env.AUTOUM_DISABLE_ACCOUNT_DETECTION = '1';
const { Antigravity } = await import('../host/antigravity.ts');
const { saveJson } = await import('../host/storage.ts');
const { googleModels } = await import('../host/antigravity-models.ts');
const profile = join(directory, 'antigravity');
await mkdir(join(profile, 'antigravity-acp'), { recursive: true, mode: 0o700 });
await copyFile(join(source, 'antigravity-acp/acp_token.json'), join(profile, 'antigravity-acp/acp_token.json'));
const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 120000);
try {
  const chat = { id: crypto.randomUUID(), cwd: directory, accountId: 'default:antigravity' };
  const host: any = { record: () => chat, current: () => ({}), settings: { chats: [chat] }, accounts: { googleProfile: () => profile }, transport: { send: (packet: any) => { if (packet.type === 'open_url') controller.abort(); } }, state: () => {} };
  const selections = await Antigravity.refreshModels(host, chat.accountId, controller.signal, process.env.AUTOUM_TEST_MODEL_SELECTIONS === '1');
  const raw = JSON.parse(await readFile(join(profile, 'models.json'), 'utf8'));
  const result = { date: new Date().toISOString(), noModelPrompt: true, selectedModels: selections, rawModels: raw, models: googleModels(raw) };
  await mkdir('test-results', { recursive: true }); await writeFile('test-results/antigravity-live-catalog.json', JSON.stringify(result, null, 2));
  if (process.env.AUTOUM_TEST_UPDATE_CATALOG === '1') await saveJson(join(resolve(source), 'models.json'), raw);
  console.log('Live account catalog: ' + result.models.map((m: any) => m.name).join(', '));
} finally { clearTimeout(timer); await rm(directory, { recursive: true, force: true }); }
