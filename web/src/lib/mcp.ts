/**
 * The browser is an MCP client: every change to a case from the assistant
 * surface or the Lab's scripted customer is a real tools/call over
 * Streamable HTTP to AFTERCARE's MCP endpoint, using the official SDK.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { ToolCaseResult } from './types';
import { ensureAwake } from './wake';

/** After this long without contact the hosted demo may have gone to sleep. */
const IDLE_BEFORE_CHECK_MS = 5 * 60_000;
let lastContact = 0;

export class ToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface ToolCallRecord {
  tool: string;
  at: string;
  ok: boolean;
  summary: string;
}

let connection: Promise<{ client: Client; protocolVersion: string }> | null = null;
const listeners = new Set<(call: ToolCallRecord) => void>();

export function onToolCall(listener: (call: ToolCallRecord) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

async function connect() {
  await ensureAwake();
  const client = new Client({ name: 'aftercare-assistant-surface', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL('/mcp', window.location.origin));
  await client.connect(transport as never);
  lastContact = Date.now();
  return { client, protocolVersion: transport.protocolVersion ?? 'unknown' };
}

export function mcpConnection() {
  connection ??= connect().catch((error: unknown) => {
    connection = null;
    throw error;
  });
  return connection;
}

export async function callTool<T = ToolCaseResult>(
  tool: string,
  args: Record<string, unknown>,
): Promise<T> {
  const { client } = await mcpConnection();
  // A tool call is never repeated, so wake a sleeping server first with a harmless check.
  if (Date.now() - lastContact > IDLE_BEFORE_CHECK_MS) await ensureAwake();
  const result = await client.callTool({ name: tool, arguments: args });
  lastContact = Date.now();
  const at = new Date().toISOString();
  if (result.isError) {
    const text =
      (result.content as { type: string; text?: string }[] | undefined)?.find(
        (c) => c.type === 'text',
      )?.text ?? '';
    let code = 'tool_error';
    let message = text || 'The request was refused.';
    try {
      const parsed = JSON.parse(text) as { error?: { code?: string; message?: string } };
      code = parsed.error?.code ?? code;
      message = parsed.error?.message ?? message;
    } catch {
      // Validation errors from the SDK arrive as plain text.
    }
    listeners.forEach((l) => l({ tool, at, ok: false, summary: message }));
    throw new ToolError(code, message);
  }
  const content = result.structuredContent as T;
  listeners.forEach((l) =>
    l({ tool, at, ok: true, summary: (content as { stateLabel?: string }).stateLabel ?? 'ok' }),
  );
  return content;
}
