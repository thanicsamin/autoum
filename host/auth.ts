import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { readJson, saveJson } from './storage.ts';
import type { NativeTransport } from './protocol.ts';
import { nativeVoiceModel } from './native-models.ts';
import { installDynamicCatalogs, catalogStatus } from './model-catalogs.ts';

export const providerLabels: Record<string, string> = {
  openai: 'ChatGPT / OpenAI', 'openai-codex': 'ChatGPT · Codex',
  anthropic: 'Claude', opencode: 'OpenCode Zen', 'opencode-go': 'OpenCode Go',
  antigravity: 'Antigravity', openrouter: 'OpenRouter', google: 'Gemini', typesafe: 'TypeSafe · Jev', 'vercel-ai-gateway': 'Vercel AI Gateway',
};
export const providerIds = Object.keys(providerLabels).filter(id => id !== 'antigravity');
const installationIds = new WeakMap<ModelRuntime, string>();
export function normalizeCredential(value: any): any | undefined {
  if (value?.type === 'api' && typeof value.key === 'string') return { type: 'api_key', key: value.key };
  if (value?.type === 'api_key' && typeof value.key === 'string') return { type: 'api_key', key: value.key };
  if (value?.type === 'oauth' && typeof value.access === 'string' && typeof value.refresh === 'string')
    return { ...value, expires: Number(value.expires) || 0 };
}
export async function detectCredentials(authPath: string, home = homedir(), excluded: string[] = []) {
  const own = await readJson<Record<string, any>>(authPath, {});
  const sources = [
    { path: join(home, '.pi/agent/auth.json'), name: 'Pi' },
    { path: join(home, '.local/share/opencode/auth.json'), name: 'OpenCode' },
    { path: join(home, 'Library/Application Support/opencode/auth.json'), name: 'OpenCode' },
    { path: join(home, '.local/share/phoenix/pi/auth.json'), name: 'Phoenix' },
  ];
  const detected: Record<string, string> = {};
  for (const source of sources) {
    const entries = await readJson<Record<string, any>>(source.path, {}).catch(() => ({}));
    for (let [id, value] of Object.entries(entries)) {
      // OpenCode's OpenAI subscription credentials use the Codex endpoint, not the SIWC grant.
      if (source.name === 'OpenCode' && id === 'openai' && value.type === 'oauth') id = 'openai-codex';
      const credential = normalizeCredential(value);
      if (!excluded.includes(id) && providerIds.includes(id) && credential && !own[id]) { own[id] = credential; detected[id] = source.name; }
    }
  }
  const codex = await readJson<any>(join(home, '.codex/auth.json'), {}).catch(() => ({}));
  if (!excluded.includes('openai-codex') && !own['openai-codex'] && codex.tokens?.access_token && codex.tokens?.refresh_token) {
    let expires = 0;
    try { expires = JSON.parse(Buffer.from(codex.tokens.access_token.split('.')[1], 'base64url').toString()).exp * 1000; } catch {}
    own['openai-codex'] = { type: 'oauth', access: codex.tokens.access_token, refresh: codex.tokens.refresh_token, expires, accountId: codex.tokens.account_id, id_token: codex.tokens.id_token };
    detected['openai-codex'] = 'Codex';
  }
  if (!excluded.includes('openai') && !own.openai && codex.OPENAI_API_KEY) { own.openai = { type: 'api_key', key: codex.OPENAI_API_KEY }; detected.openai = 'Codex API key'; }
  const claude = await readJson<any>(join(home, '.claude/.credentials.json'), {}).catch(() => ({}));
  if (!excluded.includes('anthropic') && !own.anthropic && claude.claudeAiOauth?.accessToken && claude.claudeAiOauth?.refreshToken) {
    const c = claude.claudeAiOauth;
    own.anthropic = { type: 'oauth', access: c.accessToken, refresh: c.refreshToken, expires: c.expiresAt || 0 };
    detected.anthropic = 'Claude Code';
  }
  await saveJson(authPath, own);
  return detected;
}
export async function makeModels(authPath: string, modelsPath: string, options: { catalogBaseUrl?: string } = {}) {
  const identityPath = join(dirname(authPath), 'installation.json');
  const identity = await readJson<{ deviceId?: string }>(identityPath, {});
  if (!identity.deviceId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(identity.deviceId)) {
    identity.deviceId = crypto.randomUUID(); await saveJson(identityPath, identity);
  }
  const testCatalog = process.env.AUTOUM_MODEL_CATALOG_TEST_URL;
  if (testCatalog && (process.env.AUTOUM_DISABLE_ACCOUNT_DETECTION !== '1' || !/^http:\/\/127\.0\.0\.1:\d+$/.test(testCatalog))) throw Error('Invalid private model catalog fixture.');
  const runtime = await ModelRuntime.create({ authPath, modelsPath, modelsStorePath: join(dirname(authPath), 'models-store.json'), ...(testCatalog ? { catalogBaseUrl: testCatalog } : {}), ...options });
  installationIds.set(runtime, identity.deviceId);
  await installDynamicCatalogs(runtime, dirname(authPath), providerIds);
  return runtime;
}
export function publicProviders(runtime: ModelRuntime, detected: Record<string, string>) {
  return providerIds.map(id => ({ id, name: providerLabels[id], configured: runtime.hasConfiguredAuth(id),
    detected: detected[id], catalog: catalogStatus(runtime, id), login: !!runtime.getProvider(id)?.auth?.oauth,
    apiKey: !!runtime.getProvider(id)?.auth?.apiKey,
    models: publicModels(runtime, id),
  }));
}
export function publicModels(runtime: ModelRuntime | undefined, id: string) {
  return (runtime?.getModels(id) || []).map(m => ({ id: m.id, name: m.name, vision: m.input.includes('image'), reasoning: m.reasoning, nativeVoice: nativeVoiceModel(id, m.id) }));
}
export async function login(runtime: ModelRuntime, transport: NativeTransport, provider: string, type: 'oauth' | 'api_key', key?: string, signal?: AbortSignal) {
  if (!providerIds.includes(provider)) throw Error('Unknown provider.');
  if (type === 'api_key' && (!key?.trim() || key.length > 8192)) throw Error('Enter a valid API key.');
  await runtime.login(provider, type, {
    signal,
    prompt: prompt => type === 'api_key' ? Promise.resolve(key!.trim()) : transport.request('auth_prompt', { provider, ...prompt, signal: undefined }, prompt.signal || signal, 600000),
    notify: event => {
      transport.send({ type: 'auth_event', data: { provider, ...event } });
      if (event.type === 'auth_url') transport.send({ type: 'open_url', data: { url: event.url } });
      if (event.type === 'device_code') transport.send({ type: 'open_url', data: { url: event.verificationUri } });
    },
  }, { getDeviceId: () => installationIds.get(runtime)! });
}
