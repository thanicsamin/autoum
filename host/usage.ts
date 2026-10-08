import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { Account, Accounts } from './accounts.ts';
import { readJson } from './storage.ts';
export type UsageWindow = { label: string; usedPercent: number; resetsAt?: string; detail?: string };
export type AccountUsage = { status: 'ok' | 'unavailable' | 'stale'; windows: UsageWindow[]; checkedAt?: string; message?: string };
const percent = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.min(100, v) : undefined;
const reset = (v: unknown) => { const date = typeof v === 'number' ? new Date(v * 1000) : typeof v === 'string' ? new Date(v) : undefined; return date && Number.isFinite(date.getTime()) ? date.toISOString() : undefined; };
export function parseUsage(provider: string, payload: any): UsageWindow[] {
  const windows: UsageWindow[] = [];
  const add = (label: string, used: unknown, resetsAt?: unknown, detail?: string) => { const p = percent(used); if (p !== undefined) windows.push({ label, usedPercent: p, resetsAt: reset(resetsAt), detail }); };
  if (provider === 'openai' || provider === 'openai-codex') {
    const groups = payload?.rate_limit ? [['Codex', payload.rate_limit]] : Object.entries(payload?.rate_limits || {});
    for (const [name, limits] of groups as any[]) for (const [kind, window] of [['Current window', limits?.primary_window], ['Weekly', limits?.secondary_window]] as const) {
      if (!window) continue;
      const duration = window.limit_window_seconds; const label = duration === 604800 ? 'Weekly' : duration === 86400 ? 'Daily' : duration > 0 && duration < 86400 ? `${duration / 3600}h window` : kind;
      add(name === 'Codex' || name === 'codex' ? label : `${name} · ${label}`, window.used_percent, window.reset_at);
    }
  } else if (provider === 'anthropic') {
    for (const [key, label] of [['five_hour', '5h window'], ['seven_day', 'Weekly'], ['seven_day_sonnet', 'Sonnet · weekly'], ['seven_day_opus', 'Opus · weekly']]) add(label, payload?.[key]?.utilization, payload?.[key]?.resets_at);
  } else if (provider === 'opencode' || provider === 'opencode-go') {
    for (const [key, label] of [['rolling', 'Rolling window'], ['weekly', 'Weekly'], ['monthly', 'Monthly']]) add(label, payload?.usage?.[key]?.percent, payload?.usage?.[key]?.resetsAt);
  } else if (provider === 'openrouter') {
    const data = payload?.data;
    if (typeof data?.limit === 'number' && Number.isFinite(data.limit) && data.limit >= 0 && typeof data?.limit_remaining === 'number' && Number.isFinite(data.limit_remaining))
      add('API-key budget', data.limit > 0 ? (data.limit - data.limit_remaining) / data.limit * 100 : 100, undefined, `$${Math.max(0, data.limit_remaining).toFixed(2)} of $${data.limit.toFixed(2)} remaining`);
  }
  return windows;
}
export async function fetchUsage(account: Account, runtime: ModelRuntime | undefined, credential: any, conversationId: string): Promise<AccountUsage> {
  const unknown = (message: string): AccountUsage => ({ status: 'unavailable', windows: [], message, checkedAt: new Date().toISOString() });
  if (!account.configured) return unknown('Connect this account to see usage.');
  if (process.env.AUTOUM_DISABLE_USAGE_NETWORK === '1') return unknown('Usage unavailable in this test profile.');
  const provider = account.provider;
  const endpoints: Record<string, string> = { 'openai-codex': 'https://chatgpt.com/backend-api/wham/usage', openai: 'https://chatgpt.com/backend-api/wham/usage', anthropic: 'https://api.anthropic.com/api/oauth/usage',
    opencode: 'https://opencode.ai/zen/go/v1/usage', 'opencode-go': 'https://opencode.ai/zen/go/v1/usage', openrouter: 'https://openrouter.ai/api/v1/key' };
  if (!runtime || !endpoints[provider] || ['openai', 'openai-codex', 'anthropic'].includes(provider) && account.method !== 'oauth') return unknown('This provider does not expose account limits for this connection.');
  try {
    const auth = await runtime.getAuth(provider); if (!auth?.auth.apiKey) return unknown('Reconnect this account to see usage.');
    const headers: Record<string, string> = { Authorization: `Bearer ${auth.auth.apiKey}`, 'User-Agent': 'autoum-browser/0.1.0', Accept: 'application/json' };
    if (provider.startsWith('opencode')) headers['x-opencode-session'] = conversationId;
    if (provider === 'anthropic') headers['anthropic-beta'] = 'oauth-2025-04-20';
    if (provider === 'openai-codex' || provider === 'openai') {
      let accountId = credential?.accountId;
      try { accountId ||= JSON.parse(Buffer.from(auth.auth.apiKey.split('.')[1], 'base64url').toString())['https://api.openai.com/auth']?.chatgpt_account_id; } catch {}
      if (accountId) headers['ChatGPT-Account-Id'] = accountId;
    }
    const response = await fetch(endpoints[provider], { headers, signal: AbortSignal.timeout(8000) });
    if (!response.ok) return unknown(response.status === 429 ? 'Provider is limiting usage checks. Try again later.' : response.status === 401 ? 'Reconnect this account to see usage.' : 'Usage is unavailable for this connection.');
    const windows = parseUsage(provider, await response.json());
    return windows.length ? { status: 'ok', windows, checkedAt: new Date().toISOString() } : unknown('This connection does not report a measurable account limit.');
  } catch { return unknown('Could not reach the provider’s usage service.'); }
}
export class Usage {
  private cache = new Map<string, { result: AccountUsage; expires: number; attemptedAt: number }>();
  private pending = new Map<string, Promise<AccountUsage>>();
  constructor(private accounts: Accounts) {}
  invalidate(id: string) { this.cache.delete(id); }
  async get(id: string, conversationId: string, force = false): Promise<AccountUsage> {
    const previous = this.cache.get(id);
    if (previous && previous.expires > Date.now() && (!force || Date.now() - previous.attemptedAt < (previous.result.status === 'ok' ? 60000 : 300000))) return previous.result;
    if (this.pending.has(id)) return this.pending.get(id)!;
    const account = this.accounts.record(id);
    const task = (async () => {
      const credential = (await readJson<any>(this.accounts.authPath(id), {}).catch(() => ({})))[account.provider];
      const runtime = account.provider === 'antigravity' ? undefined : this.accounts.runtime(id, account.provider);
      let result = await fetchUsage(account, runtime, credential, conversationId);
      if (result.status === 'unavailable' && previous?.result.windows.length) result = { ...previous.result, status: 'stale', message: result.message };
      this.cache.set(id, { result, expires: Date.now() + 300000, attemptedAt: Date.now() }); return result;
    })();
    this.pending.set(id, task); try { return await task; } finally { this.pending.delete(id); }
  }
}
