import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { createContainer, type Container } from '../../src/container.js';
import { createHttpApp } from '../../src/interfaces/http/app.js';

let dir: string;
let container: Container;
let server: Server;
let base: string;
let port: number;

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = createServer().listen(0, '127.0.0.1', () => {
      const { port: p } = probe.address() as AddressInfo;
      probe.close(() => resolve(p));
    });
  });
}

async function listen(token?: string): Promise<{ server: Server; port: number }> {
  const p = await freePort();
  const config = loadConfig({
    PORT: String(p),
    HOST: '127.0.0.1',
    SERVE_WEB: 'false',
    ...(token ? { AFTERCARE_ACCESS_TOKEN: token } : {}),
  });
  return new Promise((resolve) => {
    const srv = createHttpApp(container, config).listen(p, '127.0.0.1', () =>
      resolve({ server: srv, port: p }),
    );
  });
}

async function connect(): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> {
  const client = new Client({ name: 'aftercare-test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`));
  await client.connect(transport as never);
  return { client, transport };
}

type Result = { structuredContent?: Record<string, unknown>; isError?: boolean; content?: unknown };

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'aftercare-mcp-'));
  container = createContainer({ databasePath: join(dir, 'mcp.db'), demoCustomer: 'cus_demo_maya' });
  ({ server, port } = await listen());
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  container.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('MCP over Streamable HTTP', () => {
  it('negotiates protocol 2025-11-25 and lists typed tools', async () => {
    const { client, transport } = await connect();
    expect(transport.protocolVersion).toBe('2025-11-25');
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        'approve_proposed_return',
        'check_return_outcome',
        'continue_case',
        'decline_proposed_return',
        'explain_decision',
        'get_case',
        'list_my_cases',
        'provide_item_serial',
        'start_return_case',
        'submit_approved_return',
      ].sort(),
    );
    for (const tool of tools) {
      expect(tool.inputSchema.type).toBe('object');
      expect(tool.outputSchema?.type).toBe('object');
    }
    expect(
      tools.find((t) => t.name === 'submit_approved_return')?.annotations?.destructiveHint,
    ).toBe(true);
    await client.close();
  });

  it('runs the whole Return Rescue flow through MCP tools', async () => {
    container.demo.reset();
    const { client } = await connect();
    const call = async (name: string, args: Record<string, unknown>) =>
      (await client.callTool({ name, arguments: args })) as Result;

    const opened = await call('start_return_case', {
      customerRequest:
        'My wireless headphones keep disconnecting. I bought them recently. Can you help me return them?',
    });
    expect(opened.isError).toBeFalsy();
    const caseId = opened.structuredContent?.['caseId'] as string;
    expect(opened.structuredContent).toMatchObject({
      state: 'needs_information',
      retailerIsSimulated: true,
    });
    expect((opened.structuredContent?.['needsFromCustomer'] as { id: string }[])[0]?.id).toBe(
      'item_serial',
    );

    const ready = await call('provide_item_serial', { caseId, serialNumber: 'HA-7Q2-4471' });
    const proposal = ready.structuredContent?.['proposal'] as {
      proposalId: string;
      proposalDigest: string;
    };
    expect(ready.structuredContent).toMatchObject({
      state: 'awaiting_approval',
      nextStep: { requiresApproval: true },
    });

    const premature = await call('submit_approved_return', {
      caseId,
      proposalId: proposal.proposalId,
    });
    expect(premature.isError).toBe(true);
    expect(JSON.stringify(premature.content)).toMatch(/approval_required/);

    const approved = await call('approve_proposed_return', {
      caseId,
      proposalId: proposal.proposalId,
      proposalDigest: proposal.proposalDigest,
      customerConfirmation: 'Yes, return them for the refund.',
    });
    expect(approved.structuredContent).toMatchObject({
      state: 'ready_to_submit',
      lifecycle: { stage: 'approved' },
    });

    const unknown = await call('submit_approved_return', {
      caseId,
      proposalId: proposal.proposalId,
    });
    expect(unknown.structuredContent).toMatchObject({
      state: 'needs_reconciliation',
      lifecycle: { stage: 'outcome_unknown' },
    });

    const reconciled = await call('check_return_outcome', { caseId });
    expect(reconciled.structuredContent).toMatchObject({ lifecycle: { stage: 'submitted' } });
    const confirmed = await call('check_return_outcome', { caseId });
    expect(confirmed.structuredContent).toMatchObject({
      state: 'resolved',
      lifecycle: { stage: 'confirmed' },
    });

    const trace = await call('explain_decision', { caseId });
    expect(trace.structuredContent?.['governingPolicy']).toBe('2026.1');

    const list = await call('list_my_cases', {});
    expect((list.structuredContent?.['cases'] as { caseId: string }[])[0]?.caseId).toBe(caseId);

    const view = container.service.getCase(caseId, 'cus_demo_maya');
    expect(view.events.filter((e) => e.type === 'mcp.tool_called')).toHaveLength(6);
    expect(view.events.find((e) => e.type === 'mcp.tool_refused')?.data).toMatchObject({
      tool: 'submit_approved_return',
      code: 'approval_required',
    });
    expect(container.sandbox.listReturns()).toHaveLength(1);
    await client.close();
  });

  it('rejects invalid tool input as a tool error', async () => {
    const { client } = await connect();
    const result = (await client.callTool({
      name: 'provide_item_serial',
      arguments: { caseId: 'x', serialNumber: '!' },
    })) as Result;
    expect(result.isError).toBe(true);
    await client.close();
  });

  it('does not reveal unknown cases', async () => {
    const { client } = await connect();
    const result = (await client.callTool({
      name: 'get_case',
      arguments: { caseId: 'case_nope' },
    })) as Result;
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/not_found/);
    await client.close();
  });
});

describe('transport and API guards', () => {
  const init = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'curl', version: '0' },
    },
  };
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  };

  it('answers initialize without issuing a session id (stateless)', async () => {
    const res = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify(init) });
    expect(res.status).toBe(200);
    expect(res.headers.get('mcp-session-id')).toBeNull();
    const body = (await res.json()) as { result: { protocolVersion: string } };
    expect(body.result.protocolVersion).toBe('2025-11-25');
  });

  it('rejects a foreign Origin with 403', async () => {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { ...headers, origin: 'https://evil.example' },
      body: JSON.stringify(init),
    });
    expect(res.status).toBe(403);
  });

  it('rejects GET on the MCP endpoint with 405', async () => {
    const res = await fetch(`${base}/mcp`, { headers: { accept: 'text/event-stream' } });
    expect(res.status).toBe(405);
  });

  it('rejects an unsupported protocol version header', async () => {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { ...headers, 'mcp-protocol-version': '1999-01-01' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    });
    expect(res.status).toBe(400);
  });

  it('serves case reads and maps domain errors to HTTP statuses', async () => {
    const list = await fetch(`${base}/api/cases`);
    expect(list.status).toBe(200);
    const missing = await fetch(`${base}/api/cases/case_nope`);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({
      error: { code: 'not_found', message: 'No such case for this customer.' },
    });
    const badScript = await fetch(`${base}/api/demo/script`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ outcome: 'explode' }),
    });
    expect(badScript.status).toBe(400);
  });

  it('requires the bearer token when one is configured', async () => {
    const secured = await listen('a-very-long-test-token');
    const url = `http://127.0.0.1:${secured.port}`;
    expect((await fetch(`${url}/api/cases`)).status).toBe(401);
    expect(
      (
        await fetch(`${url}/api/cases`, {
          headers: { authorization: 'Bearer a-very-long-test-token' },
        })
      ).status,
    ).toBe(200);
    await new Promise((resolve) => secured.server.close(resolve));
  });
});
