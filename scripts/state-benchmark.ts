import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
const directory = await mkdtemp(join(tmpdir(), 'autoum-state-benchmark-'));
process.env.AUTOUM_DATA_DIR = join(directory, 'agent');
process.env.AUTOUM_ARTIFACTS_DIR = join(directory, 'artifacts');
process.env.AUTOUM_DISABLE_ACCOUNT_DETECTION = '1';
process.env.AUTOUM_DISABLE_USAGE_NETWORK = '1';
const { AgentHost } = await import('../host/agent.ts');
const host = new AgentHost({ send() {} } as any);
try {
  await host.init(); const first = host.settings.chats[0];
  host.settings.chats = Array.from({ length: 40 }, (_, index) => {
    const id = index ? crypto.randomUUID() : first.id;
    const attachments = Array.from({ length: 40 }, (_, n) => ({ id: crypto.randomUUID(), name: `diagram-${n}.png`, mimeType: 'image/png', size: 128000, path: join(directory, 'artifacts', id, 'attachments', crypto.randomUUID() + '-diagram.png') }));
    return { ...first, id, title: `Synthetic chat ${index}`, attachments, messages: Array.from({ length: 30 }, (_, n) => ({ role: n % 2 ? 'assistant' : 'user', text: 'Synthetic history paragraph. '.repeat(200), attachments: n < attachments.length ? [attachments[n]] : undefined })) };
  });
  const times: number[] = []; let bytes = 0;
  for (let n = 0; n < 30; n++) {
    const start = performance.now(), state = host.state();
    bytes = Buffer.byteLength(JSON.stringify({ type: 'state', data: state })); times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  console.log(JSON.stringify({ fixture: '40 chats, 30 long messages and 40 attachment records each', packetBytes: bytes, withinNativeLimit: bytes <= 1000000, medianMs: times[Math.floor(times.length / 2)], p95Ms: times[Math.floor(times.length * .95)], samples: times.length, measurement: 'host state construction plus native JSON serialization; excludes model/service/browser latency' }));
} finally { await host.close(); await rm(directory, { recursive: true, force: true }); }
