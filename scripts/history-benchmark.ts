import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

const directory = await mkdtemp(join(tmpdir(), 'autoum-history-benchmark-'));
process.env.AUTOUM_DATA_DIR = join(directory, 'agent');
process.env.AUTOUM_ARTIFACTS_DIR = join(directory, 'artifacts');
process.env.AUTOUM_DISABLE_ACCOUNT_DETECTION = '1';
process.env.AUTOUM_DISABLE_USAGE_NETWORK = '1';
const { AgentHost } = await import('../host/agent.ts');
const host = new AgentHost({ send(packet: any) { JSON.stringify(packet); } } as any);
try {
  await host.init(); const chat = host.settings.chats[0];
  chat.messages = Array.from({ length: 240 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: `Message ${i}: ` + 'Synthetic history. '.repeat(1000) }));
  host.settings.activeChatId = chat.id; await host.save(); host.state();
  const path = join(process.env.AUTOUM_DATA_DIR, 'settings.json'), initial = await stat(path);
  const save = host.save.bind(host); let saves = 0;
  host.save = () => { saves++; return save(); };
  const times: number[] = [];
  const operations = ['view_chat', 'history_more', 'history_newer', 'history_latest'];
  for (let i = 0; i < 24; i++) {
    const start = performance.now(); await host.handle(operations[i % operations.length], { chatId: chat.id }); times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  console.log(JSON.stringify({ fixture: '240 long saved messages, 24 navigation requests on the selected chat', settingsBytes: initial.size, saveRequests: saves, samples: times.length, medianMs: times[Math.floor(times.length / 2)], p95Ms: times[Math.floor(times.length * .95)], measurement: 'host navigation including state serialization and required persistence; excludes browser rendering and provider latency' }));
} finally { await host.close(); await rm(directory, { recursive: true, force: true }); }
