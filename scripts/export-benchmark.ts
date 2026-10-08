import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const directory = await mkdtemp(join(tmpdir(), 'autoum-export-benchmark-'));
process.env.AUTOUM_DATA_DIR = join(directory, 'agent');
process.env.AUTOUM_ARTIFACTS_DIR = join(directory, 'artifacts');
process.env.AUTOUM_DISABLE_ACCOUNT_DETECTION = '1'; process.env.AUTOUM_DISABLE_USAGE_NETWORK = '1';
const { AgentHost } = await import('../host/agent.ts');
const host = new AgentHost({ send() {} } as any);
try {
  await host.init(); const first = host.settings.chats[0];
  host.settings.chats = Array.from({ length: 10 }, (_, i) => ({ ...first, id: crypto.randomUUID(), title: `Export fixture ${i}`, messages: Array.from({ length: 24 }, (_, j) => ({ role: j % 2 ? 'assistant' : 'user', text: `Message ${j}: ` + 'Synthetic export history. '.repeat(800) })) }));
  const times: number[] = [], counts: number[] = []; let characters = 0, requests = 0;
  const stringify = JSON.stringify;
  for (let sample = 0; sample < 5; sample++) {
    let serializations = 0, offset: number | null = 0, exportId: string | undefined;
    const chunks: string[] = []; requests = 0;
    JSON.stringify = ((value: any, ...args: any[]) => {
      if (value && Array.isArray(value.chats) && Array.isArray(value.folders)) serializations++;
      return (stringify as any)(value, ...args);
    }) as typeof JSON.stringify;
    const start = performance.now();
    try {
      do {
        const chunk = await host.handle('export_data', { offset, exportId });
        chunks.push(chunk.text); offset = chunk.next; exportId = chunk.exportId; requests++;
        JSON.stringify({ reply: 'benchmark', data: chunk });
      } while (offset !== null);
    } finally { JSON.stringify = stringify; }
    times.push(performance.now() - start); counts.push(serializations);
    const text = chunks.join(''); characters = text.length;
    if (JSON.parse(text).chats.length !== 10) throw Error('Incomplete export benchmark.');
  }
  times.sort((a, b) => a - b);
  console.log(JSON.stringify({ fixture: '10 chats, 24 messages of 20,000 characters each; 5 complete exports', exportCharacters: characters, chunkRequests: requests, fullSerializationsPerExport: counts, medianMs: times[2], measurement: 'host export plus chunk JSON serialization; excludes disk, download, browser and provider latency' }));
} finally { await host.close(); await rm(directory, { recursive: true, force: true }); }
