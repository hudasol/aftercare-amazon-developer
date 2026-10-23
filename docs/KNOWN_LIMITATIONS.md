# Known limitations

The honest boundaries of what is built and verified.

## Not integrated

- **No native Alexa+ integration.** The Alexa+ add-on tools (MCP Toolkit, Category SDK, CLI, Web Simulator) are not available to hackathon participants. AFTERCARE is a self-hosted MCP server that an assistant _could_ call. The web assistant surface is a labelled simulation of such an assistant, not Alexa.
- **No real retailer, carrier or payment system.** Kestrel Goods, its policies, orders, serial numbers, labels and refunds are fictional and simulated in `sim_*` tables. Nothing real is ever created.
- **No customer authentication or account linking.** The server acts for one configured fictional customer. See [THREAT_MODEL.md](THREAT_MODEL.md).

## Approval over MCP

- **The server cannot ask the human itself.** Approval over MCP is only as strong as the client that calls `approve_proposed_return` (see [THREAT_MODEL.md](THREAT_MODEL.md)). MCP elicitation would let the server ask the person to confirm the exact terms. A time boxed spike with SDK 1.32.1 showed it cannot work on this stateless endpoint: each request gets a new server that never saw `initialize`, so `elicitInput` reports that the client does not support elicitation; sending the request directly reaches the client over an SSE response, but the client's answer arrives as a new POST at a new server and the tool call times out. It works with a stateful session. That would mean in memory sessions on the server, which do not survive a restart or the hosted instance sleeping, so it was not adopted. Approval is unchanged: an explicit tool call naming the proposal and its digest.

## Language understanding

- **The model is optional and off by default.** With no settings, the rules interpreter reads every message and no language model is called, which is how the hosted demo runs. An optional model assisted interpreter (any OpenAI compatible endpoint, for example a local Ollama server) can read product, issue and purchase time, a goal when the rules found none, and a reason when it quotes words from the message; serial and order numbers always come from the rules. It was measured on 30 hand labelled messages with one small local model only ([INTERPRETER_EVALUATION.md](INTERPRETER_EVALUATION.md)): better than the rules on the reason, equal on the goal, and it still stated a reason the customer did not give on 4 messages, because the quote check only tests that the quoted words are in the message, not that they give a reason. A small local model can be slow on its first call; a reply after the timeout (8 seconds by default) falls back to the rules interpreter.
- The rules interpreter recognizes a limited vocabulary: return or exchange intent, common fault phrases, change of mind phrases, a handful of product nouns, serial and order number formats. Unusual phrasing may be missed. The compiler then asks for the missing item rather than guessing.

## Product scope

- One workflow is built deeply: **return for a refund**. Replacement, refund-without-return and warranty referral are evaluated as candidate actions and shown as allowed or blocked, but only the return can be executed. The warranty referral is a message, not an operation.
- Policies support delivery-based windows per category and reason, a returnless-refund price limit, and a warranty remedy. Restocking fees, condition grading, partial refunds and multi-item orders are not modelled.
- Escalation (`needs_review`) explains what is blocking and what would resolve it, but the product has no human-agent console to resolve it. New evidence can move the case on again.
- The business date is pinned (2026-10-17) so the demo is repeatable. Override it with `AFTERCARE_CASE_DATE`.

## Operational

- A single process with an in-memory per-case lock. Horizontal scaling would rely on optimistic version checks and unique constraints only.
- A simple in memory rate limit per client address (600 requests per minute by default) on `/mcp` and `/api`. It resets on restart and does not stop a distributed load. The demo control endpoints are not role gated beyond the optional access token, and the hosted demo runs without one.
- **Hosting:** a live demo runs at https://aftercare-mxfm.onrender.com (MCP endpoint `/mcp`), deployed from `main` on Render's free plan. It is meant to stay up through the judging period (until Nov 20, 2026). Verified on 2026-10-18: `npm run mcp:smoke` against the live `/mcp` negotiated protocol 2025-11-25, listed all 10 tools and opened a case. In the browser, the full Return Rescue flow worked end to end: wrong serial rejected, chat agreement not taken as approval, outcome unknown, reconciled, verified, confirmed. An unlisted `Origin` gets 403. Limits of that hosting:
  - The free plan sleeps after 15 minutes without traffic. The first request after that takes about a minute while it wakes. The web app shows a waking notice and retries reads for up to about 90 seconds; an MCP client with a short timeout may still fail on its first call. A free external uptime monitor on `/api/health` keeps it awake, but it is set up by hand and is not part of the repository.
  - There is no persistent disk. The SQLite file lives on the instance's temporary filesystem, so cases are lost whenever the service sleeps, restarts or redeploys, and the fictional seed data comes back. Nothing a judge needs depends on earlier cases.
  - No token is required (`AFTERCARE_PUBLIC_DEMO=true`). Anyone can open cases, reset the demo or script the simulated retailer, so a judge may see another visitor's case. The Lab's reset restores the starting state.
- Official sources disagree on whether a live endpoint is required during judging; see [COMPETITION_REQUIREMENTS.md](COMPETITION_REQUIREMENTS.md). The project also runs locally with one command.
- The browser MCP client probes `GET /mcp` for an optional SSE stream and gets 405 from the stateless server. This is expected behaviour, but it appears as a network error in the browser console.
- Voice input uses the browser's Web Speech API where available (Chrome or Edge). Read-aloud uses speech synthesis. Neither is required.

## Evaluation

See the limitations section of [EVALUATION.md](EVALUATION.md): 22 synthetic scenarios, hand labelled, with two deterministic baselines that are not LLMs.
