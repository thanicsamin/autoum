// Private ACP fixture; tests prepend the current Node executable's shebang.
import { createInterface } from 'node:readline';
import { readFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
const raw = JSON.parse(await readFile(join(process.env.GEMINI_HOME, 'models.json'), 'utf8'));
let selected = raw.find(m => m.id.endsWith('-medium'))?.id || raw[0].id, relay, pending;
const config = () => [{ id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: selected, options: raw.map(m => ({ value: m.id, name: m.name })) }];
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const mcp = async (name, args) => {
  const reply = await fetch('http://127.0.0.1:' + relay.args[1], { method: 'POST', headers: { Authorization: 'Bearer ' + relay.args[2], 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method: 'tools/call', params: { name, arguments: args } }) }); return reply.json();
};
createInterface({ input: process.stdin }).on('line', async line => {
  const rpc = JSON.parse(line);
  // Record model and prompt metadata without the MCP relay capability token.
  await appendFile(process.env.AUTOUM_ACP_TEST_LOG, JSON.stringify({ profile: process.env.GEMINI_HOME, method: rpc.method, params: rpc.method === 'session/new' ? { cwd: rpc.params.cwd } : rpc.params }) + '\n');
  try {
    let result = {};
    if (rpc.method === 'initialize') result = { protocolVersion: 1, agentCapabilities: { loadSession: false }, authMethods: [{ id: 'oauth-personal', name: 'Google fixture' }] };
    else if (rpc.method === 'session/new') { relay = rpc.params.mcpServers[0]; result = { sessionId: 'fixture-session', configOptions: config() }; }
    else if (rpc.method === 'session/set_config_option') { if (!raw.some(m => m.id === rpc.params.value)) throw Error('Unknown fixture model'); selected = rpc.params.value; result = { configOptions: config() }; }
    else if (rpc.method === 'session/cancel') { pending?.(); pending = undefined; }
    else if (rpc.method === 'session/prompt') {
      const text = rpc.params.prompt[0].text; let response = 'ACP fixture used ' + selected;
      if (text.includes('ACP WAIT')) { await new Promise(resolve => { pending = resolve; }); result = { stopReason: 'cancelled' }; }
      else {
        if (text.includes('ACP MCP CLICK')) { const id = Number(/ACP MCP CLICK (\d+)/.exec(text)[1]); await mcp('browser', { action: 'click', tabId: id, selector: '#hello' }); response = 'ACP browser tool completed'; }
        if (text.includes('ACP MEMORY REPORT')) {
          const memory = await mcp('memory', { action: 'note', text: 'Google account prefers illustrated explanations fixture 881' }); if (memory.error) throw Error(memory.error.message);
          const report = await mcp('research_report', { reportId: '11111111-2222-4333-8444-555555555555', title: 'Google research brief', summary: 'Verified Google MCP integration. Inline math: \\(x^2 + y^2 = z^2\\). A product can cost $49 and another $79.', items: [{ title: 'Sample role', url: 'https://example.test/jobs/1', text: 'Matches the fixture resume.', detail: 'The role uses the candidate’s stated skills.' }, { title: 'Sample alternative', url: 'https://example.test/jobs/2', text: 'A second option.' }] }); if (report.error) throw Error(report.error.message); response = 'ACP memory and report saved';
        }
        send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: rpc.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: response } } } }); result = { stopReason: 'end_turn' };
      }
    }
    if (rpc.id !== undefined) send({ jsonrpc: '2.0', id: rpc.id, result });
  } catch (error) { if (rpc.id !== undefined) send({ jsonrpc: '2.0', id: rpc.id, error: { code: -32603, message: error.message } }); }
});
