# Product feedback (draft for the submission form)

The rules require feedback on every tool, API or SDK used. This draft records what actually happened while building AFTERCARE. **The submitter should review and edit it before pasting it into the form.**

## Model Context Protocol TypeScript SDK (`@modelcontextprotocol/sdk` 1.32.1)

**Used for:** the AFTERCARE MCP server (10 tools, stateless Streamable HTTP, protocol 2025-11-25); the in-browser MCP client in the web app; the smoke-test CLI; and transport tests.

**What worked well**

- `McpServer.registerTool` with zod `inputSchema`/`outputSchema` gave typed handlers, and validation errors were returned as tool errors (`isError`), which matches the 2025-11-25 guidance.
- Stateless mode (no `sessionIdGenerator`) was simple: a fresh server and transport per request.
- The same client package worked in Node tests and bundled cleanly for the browser with Vite.

**What needs work**

- **v1 vs v2 is confusing.** The README points new work to the v2 split packages (which implement 2026-07-28), while the hackathon requires 2025-11-25. It took research to confirm that v1.32.1 negotiates exactly 2025-11-25 and that v2's legacy mode also serves it.
- **Strict TypeScript friction.** With `exactOptionalPropertyTypes`, passing `sessionIdGenerator: undefined` and passing `StreamableHTTPServerTransport` to `server.connect` both fail to type-check. We needed a cast and a comment.
- **The Express helper checks Host only.** `createMcpExpressApp` validates Host but not Origin, while the spec says servers MUST validate Origin. We wrote our own Origin check. The transport-level `allowedHosts`/`allowedOrigins` options are marked deprecated.
- **Noise against stateless servers.** After `initialize`, the client probes `GET` for an SSE stream. A stateless server correctly answers 405, but the browser logs it as a failed request, which looks like an error to anyone demoing.
- Tool schemas are emitted as JSON Schema draft-07, although 2025-11-25 makes 2020-12 the default dialect.

**Would we build with it again?** Yes. It removed a lot of protocol work, and the test client made transport testing straightforward.

## MCP specification (2025-11-25)

**Used for:** transport requirements (POST-only stateless endpoint, 405 on GET/DELETE, `MCP-Protocol-Version` handling, Origin validation), tool output schemas and structured content, and tool annotations.

**Feedback:** the Streamable HTTP page is clear about MUST-level requirements. It would help to have a short "minimal compliant stateless server" checklist. The existence of a newer revision (2026-07-28) without a clear statement of which clients support it made choosing a version a research task.

## Alexa+ developer documentation (read only)

**Used for:** understanding how an add-on would connect (the MCP Toolkit supports 2025-11-25 over Streamable HTTP, with OAuth 2.1 + PKCE for account linking), so the server's shape matches what Alexa+ expects.

**Feedback:** the toolkit, CLI and Web Simulator are not available to hackathon participants, so we could not test against Alexa+ itself. A public, sandboxed simulator, even a limited one, would let builders verify the real integration path instead of simulating it. It would also help to state clearly near the top of each page which tools are partner-only.

## Other tools

- **Node.js 24 (`node:sqlite`)**: a built-in synchronous SQLite with no native build step; it made transactions and migrations simple on Windows.
- **Vite + React 19, Playwright (+ axe-core)**: the end-to-end tests include a real server restart and automated accessibility checks.
- **Claude Code** was used to build the project.
