# Friction log

Friction met while building AFTERCARE, in the order it happened. Every entry is something that actually occurred in this project. Product feedback with the same findings, in shorter form, is in [PRODUCT_FEEDBACK.md](PRODUCT_FEEDBACK.md).

## 1. Choosing the SDK version for protocol 2025-11-25

- **Task attempted:** build the MCP server on the protocol version the hackathon requires (2025-11-25).
- **Steps taken:** read the TypeScript SDK README, which points new work to the v2 split packages; checked which protocol versions v1 and v2 negotiate; checked v2's legacy mode.
- **Expected versus actual:** expected the README to say which package line serves 2025-11-25. Actually v2 targets 2026-07-28, and it took research to confirm that v1.32.1 negotiates exactly 2025-11-25 and that v2's legacy mode also serves it.
- **Severity:** medium (cost research time at the start; no rework).
- **Workaround:** used `@modelcontextprotocol/sdk` 1.32.1 and verified the negotiated version in a transport test.
- **Actionable suggestion:** a table in the README mapping each SDK line to the protocol versions it negotiates by default.

## 2. The Express helper validates Host but not Origin

- **Task attempted:** protect the HTTP endpoint against DNS rebinding and cross site requests, as the 2025-11-25 transport section requires (servers MUST validate `Origin`).
- **Steps taken:** read `createMcpExpressApp` in SDK 1.32.1; checked the transport level `allowedHosts` and `allowedOrigins` options.
- **Expected versus actual:** expected the helper to validate `Origin`. Actually it validates only `Host`, and only for loopback binds; the transport options that cover `Origin` are marked deprecated.
- **Severity:** medium (a security requirement left to each server author).
- **Workaround:** wrote our own Host and Origin guard in `src/interfaces/http/app.ts`, with tests for a foreign `Origin` (403).
- **Actionable suggestion:** in v1.x, document clearly that the helper does not check `Origin`, or offer an opt in Origin allow list. (SDK v2 later turned on Origin validation in the app factories for loopback binds and then made it opt in, see [issue 2852](https://github.com/modelcontextprotocol/typescript-sdk/issues/2852); [issue 2843](https://github.com/modelcontextprotocol/typescript-sdk/issues/2843) reports that non loopback hosts still get no check.)

## 3. Strict TypeScript settings and the SDK types

- **Task attempted:** compile the server with `exactOptionalPropertyTypes` enabled.
- **Steps taken:** passed `sessionIdGenerator: undefined` for stateless mode, and passed a `StreamableHTTPServerTransport` to `server.connect`.
- **Expected versus actual:** expected both to type check. Actually both fail under `exactOptionalPropertyTypes`, because the transport type declares optional callbacks in a way that setting rejects.
- **Severity:** low.
- **Workaround:** omitted `sessionIdGenerator` instead of passing `undefined`, and cast the transport once, with a comment.
- **Actionable suggestion:** declare optional members as `prop?: T | undefined` in the public types, and add a type test with `exactOptionalPropertyTypes`.

## 4. A 405 that looks like an error in every demo

- **Task attempted:** run the browser MCP client against our stateless server.
- **Steps taken:** connected with the official client from the web app and watched the browser console.
- **Expected versus actual:** expected a clean console. Actually the client probes `GET /mcp` for an optional event stream after `initialize`; the stateless server correctly answers 405, and the browser logs it as a failed request.
- **Severity:** low (cosmetic, but it looks like a fault to anyone watching a demo).
- **Workaround:** documented it in KNOWN_LIMITATIONS.md.
- **Actionable suggestion:** let the client skip the probe when told the server is stateless, or remember a 405 for the session.

## 5. Elicitation cannot complete on a stateless endpoint

- **Task attempted:** have `approve_proposed_return` ask the human, through MCP elicitation, to confirm the exact terms, so approval does not depend only on the client.
- **Steps taken:** a time boxed spike with SDK 1.32.1: a tool handler called `server.server.elicitInput` under three setups (stateless with JSON responses, stateless with an SSE response, stateful with a session map), using the official client with an elicitation handler. Then the same with `elicitation/create` sent directly, bypassing the capability check.
- **Expected versus actual:** expected the request to travel on the SSE response of the tool call. Actually, in stateless mode the per request server never saw `initialize`, so `elicitInput` reports that the client does not support elicitation. Sent directly, the request reached the client over SSE, but the client's answer arrived as a new POST at a new server instance and the tool call timed out. Only the stateful setup worked.
- **Severity:** high for this feature (it could not be built on our transport).
- **Workaround:** none adopted. Approval stays an explicit tool call bound to the proposal digest; the finding is in KNOWN_LIMITATIONS.md and THREAT_MODEL.md.
- **Actionable suggestion:** state in the elicitation and stateless documentation that server to client requests need a session; consider an error that names the cause instead of a missing capability.

## 6. A tool handler without an input schema receives different arguments

- **Task attempted:** register a tool with no input schema in the elicitation spike.
- **Steps taken:** wrote the callback as `(args, extra) => ...`, as for tools with a schema.
- **Expected versus actual:** expected the second argument to be the request context. Actually, without an `inputSchema` the callback receives only `extra`, so `extra` was undefined and the handler failed with "Cannot read properties of undefined (reading 'requestId')".
- **Severity:** low.
- **Workaround:** used `(extra) => ...`.
- **Actionable suggestion:** keep one callback signature for both cases, or make the difference visible in the type of `registerTool`.

## 7. A small local model does not always follow the JSON shape

- **Task attempted:** read customer messages with a local model (qwen2.5:3b-instruct on Ollama) through the OpenAI compatible chat completions API, with `response_format: { "type": "json_object" }`.
- **Steps taken:** sent the system prompt and the customer's message; validated the reply with a zod schema.
- **Expected versus actual:** expected an object with the five requested keys. Actually the model sometimes left out `reason` and added an `exchange` key instead, so strict validation rejected the reply and the rules interpreter was used.
- **Severity:** medium (silently lost most of the model's value until noticed).
- **Workaround:** a missing key now counts as "not said"; a value of the wrong type is still rejected. The prompt also shows the exact form of the reply.
- **Actionable suggestion:** for providers that support it, use a JSON schema response format rather than plain JSON mode, and log the rejection reason during development.

## 8. Local model latency against the timeout

- **Task attempted:** keep the default model timeout short (8 seconds) so a slow model never delays a customer for long.
- **Steps taken:** measured the local model on a laptop CPU, alone and while the end to end tests were running.
- **Expected versus actual:** expected answers within a few seconds. Actually the first call took about 19 seconds while the model loaded, and under load two of three runs of the same message exceeded 8 seconds and fell back to the rules interpreter.
- **Severity:** low (the fallback works as designed, but the model's reading is lost).
- **Workaround:** the interpreter evaluation was run with `AFTERCARE_LLM_TIMEOUT_MS=30000`; the README says to raise the timeout for slow local models.
- **Actionable suggestion:** none for the providers; for ourselves, warm the model at startup when one is configured.

## 9. The hosted service name was not the requested one

- **Task attempted:** deploy to Render as a service named `aftercare`, with the public origin in `AFTERCARE_ALLOWED_ORIGINS`.
- **Steps taken:** created the service with the allowed origin set to `https://aftercare.onrender.com`.
- **Expected versus actual:** expected that URL. Actually Render added a suffix, and the service got `https://aftercare-mxfm.onrender.com`, so browser requests from the real origin would have been refused with 403.
- **Severity:** low (caught before any visitor).
- **Workaround:** updated the allowed origins after creation and redeployed; checked that the real origin gets 200 and a foreign one 403.
- **Actionable suggestion:** create the service first and set origin dependent settings from the URL it returns.

## 10. The Alexa+ tools are not available to participants

- **Task attempted:** test AFTERCARE against Alexa+ itself.
- **Steps taken:** read the Alexa+ MCP Toolkit, CLI and Web Simulator documentation.
- **Expected versus actual:** expected at least a simulator. Actually these tools are not available to hackathon participants, so the real integration path could not be tested.
- **Severity:** high for the track (the integration is simulated, not verified).
- **Workaround:** built a self hosted MCP server, which the rules accept, and a clearly labelled simulated assistant surface.
- **Actionable suggestion:** a public, sandboxed simulator, even a limited one, and a note near the top of each page saying which tools are partner only.
