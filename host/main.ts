import { NativeTransport } from './protocol.ts';
import { AgentHost, cleanError } from './agent.ts';
import { Antigravity } from './antigravity.ts';
// Pi or third-party extensions can log; reserve stdout for native message frames.
console.log = (...args) => console.error(...args);
console.info = console.log; console.debug = console.log;
const transport = new NativeTransport(process.stdin, process.stdout);
const host = new AgentHost(transport);
const ready = (async () => { await Antigravity.initialize(); await host.init(); })();
transport.on('message', async packet => {
  try { await ready; const data = await host.handle(packet.type!, packet.data); if (packet.id) transport.send({ reply: packet.id, data }); }
  catch (e) { if (packet.id) transport.send({ reply: packet.id, error: cleanError(e) }); }
});
transport.on('close', () => { host.close().finally(() => process.exit(0)); });
transport.on('error', () => { host.close().finally(() => process.exit(1)); });
ready.catch(e => { console.error(cleanError(e)); process.exitCode = 1; });
process.on('SIGTERM', () => { host.close().finally(() => process.exit(0)); });
