/**
 * Calls a running AFTERCARE MCP endpoint with the official SDK client and
 * prints what it sees. Usage: npm run mcp:smoke [-- http://127.0.0.1:8787/mcp]
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const url = new URL(process.argv[2] ?? 'http://127.0.0.1:8787/mcp');
const token = process.env['AFTERCARE_ACCESS_TOKEN'];
const transport = new StreamableHTTPClientTransport(url, {
  ...(token ? { requestInit: { headers: { authorization: `Bearer ${token}` } } } : {}),
});
const client = new Client({ name: 'aftercare-smoke', version: '1.0.0' });
await client.connect(transport as never);
console.info(
  `Connected to ${url.href}; negotiated protocol ${transport.protocolVersion ?? 'unknown'}`,
);
const { tools } = await client.listTools();
console.info(`Tools (${tools.length}): ${tools.map((t) => t.name).join(', ')}`);
const result = await client.callTool({
  name: 'start_return_case',
  arguments: {
    customerRequest:
      'My wireless headphones keep disconnecting. I bought them recently. Can you help me return them?',
  },
});
const content = result.structuredContent as
  { caseId: string; state: string; speech: string } | undefined;
console.info(`start_return_case -> case ${content?.caseId}, state ${content?.state}`);
console.info(`speech: ${content?.speech}`);
await client.close();
