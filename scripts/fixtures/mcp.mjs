import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { appendFile, access } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema, ListResourcesRequestSchema, ListResourceTemplatesRequestSchema, ReadResourceRequestSchema, ListPromptsRequestSchema, GetPromptRequestSchema } from '@modelcontextprotocol/sdk/types.js';
const server = new Server({ name: 'autoum-fixture', version: '1.0.0' }, { capabilities: { tools: {}, resources: {}, prompts: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'greet', description: 'Fixture greeting', inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } }] }));
server.setRequestHandler(CallToolRequestSchema, async request => {
  if (process.env.AUTOUM_MCP_FIXTURE_TOOL_LOG) await appendFile(process.env.AUTOUM_MCP_FIXTURE_TOOL_LOG, 'executed\n');
  if (process.env.AUTOUM_MCP_FIXTURE_CALLS && request.params.arguments.name === 'ExitDuringCall') {
    await appendFile(process.env.AUTOUM_MCP_FIXTURE_CALLS, 'executed\n'); process.exit(0);
  }
  return { content: [{ type: 'text', text: 'Hello ' + request.params.arguments.name + ' from MCP' }] };
});
server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [{ name: 'Fixture note', uri: 'fixture://note', mimeType: 'text/plain' }] }));
server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({ resourceTemplates: [] }));
server.setRequestHandler(ReadResourceRequestSchema, async () => ({ contents: [{ uri: 'fixture://note', mimeType: 'text/plain', text: 'A real SDK resource fixture' }] }));
server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: [{ name: 'explain', description: 'Explain a fixture' }] }));
server.setRequestHandler(GetPromptRequestSchema, async () => ({ messages: [{ role: 'user', content: { type: 'text', text: 'Explain the fixture simply.' } }] }));
if (process.env.AUTOUM_MCP_FIXTURE_PIDS) await appendFile(process.env.AUTOUM_MCP_FIXTURE_PIDS, process.pid + '\n');
if (process.env.AUTOUM_MCP_FIXTURE_GATE) while (!await access(process.env.AUTOUM_MCP_FIXTURE_GATE).then(() => true, () => false)) await delay(10);
await server.connect(new StdioServerTransport());
