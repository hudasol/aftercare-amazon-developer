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
- **Elicitation does not work on a stateless server, and the docs do not say so.** We wanted `approve_proposed_return` to ask the human through elicitation, so the server itself confirms the exact terms. In stateless mode every request gets a fresh server that never saw `initialize`, so `server.server.elicitInput` refuses with "Client does not support form elicitation", even when the client declared the capability. Sending the `elicitation/create` request directly also fails: with `enableJsonResponse` the client is never asked; with an SSE response the client is asked and answers, but its answer arrives as a new POST at a new server and transport that do not know the pending request, so the tool call times out. It works only with a stateful session (`sessionIdGenerator` plus an in memory session map). A sentence in the elicitation and stateless sections saying that server to client requests need a session would have saved a time boxed spike.

- **Small models and JSON mode.** Not an SDK issue, but it cost time in the same layer: with `response_format: { "type": "json_object" }` on a local OpenAI compatible endpoint (Ollama, qwen2.5:3b-instruct), the model sometimes left out a requested key and added one of its own. Validation then rejected every such reply until a missing key was treated as "not said". On a laptop CPU the first call took about 19 seconds while the model loaded.

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

## Onboarding experience: zero to hello world

**First working call.** The first working round trip in this project is `npm run mcp:smoke`. It uses the official SDK client to send `initialize` (protocol 2025-11-25 is negotiated), `tools/list` (10 tools are listed) and one `tools/call` (`start_return_case`, which opens a case and asks for the item's serial number). The script was added on 2026-10-18, the first day of the repository.

**From a clean checkout (measured 2026-10-23).** Windows 11, Node.js v24.15.0, npm 11.12.1, a new empty directory, no `.env` file and no `AFTERCARE_` variables, commit 4c75719:

| Step                                 | Command                                                               | Wall time |
| ------------------------------------ | --------------------------------------------------------------------- | --------: |
| Clone                                | `git clone https://github.com/hudasol/aftercare-amazon-developer.git` |     7.1 s |
| Install                              | `npm ci`                                                              |    29.7 s |
| Build the web app                    | `npm run build`                                                       |     5.0 s |
| Start until `/api/health` answers    | `PORT=8811 npm start`                                                 |     4.7 s |
| initialize, tools/list, tools/call   | `npm run mcp:smoke -- http://127.0.0.1:8811/mcp`                      |     4.5 s |
| Total, clone to a passing smoke test |                                                                       |    51.0 s |

This measures how quickly someone can reach a working call with this repository. It does not measure how long the first working call took while the project was being built.

TO CONFIRM BY AUTHOR: Before this repository existed, how long did it take you to get a first MCP tools/call working with the SDK, and what, if anything, was confusing on the way?

**What was clear.**

- MCP TypeScript SDK: `registerTool` with zod schemas gave typed handlers, stateless mode needed only a fresh server and transport per request, and the same client package worked in Node and in the browser (see "What worked well" above).
- MCP specification: the MUST level requirements of the Streamable HTTP transport were clear enough to write transport tests against them (`tests/interfaces/mcp-http.test.ts`, added 2026-10-18).
- Node.js 24: the built in `node:sqlite` needs no native build step, and `npm ci` completed on Windows in the measured run above.

**What cost time or caused a wrong turn** (details in [FRICTION_LOG.md](FRICTION_LOG.md); dates from the git history):

- 2026-10-18, SDK version (entry 1): research was needed to confirm that SDK 1.32.1 negotiates protocol 2025-11-25 while the README points new work to v2.
- 2026-10-18, Origin validation (entry 2): the Express helper validates Host but not Origin, so we wrote our own guard.
- 2026-10-18, strict TypeScript (entry 3): `exactOptionalPropertyTypes` rejected `sessionIdGenerator: undefined` and the transport type, which needed a cast.
- 2026-10-18, GET probe (entry 4): the browser client's GET probe returns 405 from a stateless server and looks like an error in demos.
- 2026-10-18, Alexa+ tools (entry 10): the MCP Toolkit, CLI and Web Simulator are not available to participants, so the real Alexa+ path could not be tried.
- 2026-10-22, elicitation (entry 5): a time boxed spike showed that elicitation cannot complete on a stateless endpoint, and the error names a missing client capability instead of the missing session.

TO CONFIRM BY AUTHOR: Did you sign up for, or request access to, any Alexa+ developer program or toolkit, and if so how did that feel? The repository records only that these tools are not available to participants.

TO CONFIRM BY AUTHOR: Was creating the Amazon developer account or registering on Devpost part of your onboarding, and did any step there cost time?

**One suggestion per tool that cost time.**

- MCP TypeScript SDK: add a README table that maps each SDK line to the protocol versions it negotiates by default, and state in the stateless and elicitation sections that server to client requests need a session.
- MCP specification: add a short checklist for a minimal compliant stateless server.
- Alexa+ developer documentation: provide a public, sandboxed simulator, even a limited one, and state near the top of each page which tools are partner only.
