import { createInterface } from 'node:readline';
const [port, token] = process.argv.slice(2);
if (!/^\d+$/.test(port) || !/^[a-f0-9]{64}$/.test(token)) process.exit(1);
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  try {
    const packet = JSON.parse(line);
    if (packet.id === undefined) continue;
    const response = await fetch(`http://127.0.0.1:${port}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: line });
    process.stdout.write(await response.text() + '\n');
  } catch { process.stderr.write('Browser tool connection failed.\n'); }
}
