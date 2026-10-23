import { useEffect, useState } from 'react';
import { listTools, type ToolSummary } from '../lib/mcp';

interface Props {
  endpoint: string;
  protocolVersion: string;
}

const CLIENT_CONFIG = (endpoint: string) =>
  JSON.stringify({ mcpServers: { aftercare: { type: 'http', url: endpoint } } }, null, 2);

const CURL_LIST = (endpoint: string) =>
  `curl -s -X POST ${endpoint} \\
  -H 'content-type: application/json' \\
  -H 'accept: application/json, text/event-stream' \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`;

function CopyBlock({ label, text }: { label: string; text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => setCopied(false));
  };
  return (
    <div className="copy-block">
      <div className="copy-block-head">
        <span>{label}</span>
        <button type="button" className="btn btn-small" onClick={copy}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre tabIndex={0}>{text}</pre>
    </div>
  );
}

export function ConnectPanel({ endpoint, protocolVersion }: Props) {
  const [tools, setTools] = useState<ToolSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    listTools()
      .then((list) => live && setTools(list))
      .catch((e: unknown) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, []);

  return (
    <section className="panel" id="lab-connect" aria-label="Connect a client">
      <h2>Connect your own MCP client</h2>
      <p className="muted">
        The web client on this page talks to the same endpoint over Streamable HTTP, protocol{' '}
        {protocolVersion}. Any MCP client can do the same. The endpoint is stateless, so a client
        needs no session setup.
      </p>
      <CopyBlock label="Endpoint" text={endpoint} />
      <CopyBlock label="Client configuration" text={CLIENT_CONFIG(endpoint)} />
      <CopyBlock label="List the tools from a terminal" text={CURL_LIST(endpoint)} />
      <CopyBlock
        label="Run the scripted check from the repository"
        text={`npm run mcp:smoke -- ${endpoint}`}
      />
      <h3>Advertised tools{tools ? ` (${tools.length})` : ''}</h3>
      {error && (
        <p className="notice" role="alert">
          Could not read the tool list: {error}
        </p>
      )}
      {!tools && !error && <p className="muted">Reading the tool list from the server.</p>}
      {tools && (
        <ul className="tool-list">
          {tools.map((tool) => (
            <li key={tool.name}>
              <code>{tool.name}</code>
              <span>{tool.title}</span>
              <span className="tool-tag">{tool.readOnly ? 'read only' : 'changes state'}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
