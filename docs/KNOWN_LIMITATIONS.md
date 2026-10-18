# Known limitations

The honest boundaries of what is built and verified.

## Not integrated

- **No native Alexa+ integration.** The Alexa+ add-on tools (MCP Toolkit, Category SDK, CLI, Web Simulator) are not available to hackathon participants. AFTERCARE is a self-hosted MCP server that an assistant _could_ call. The web assistant surface is a labelled simulation of such an assistant, not Alexa.
- **No real retailer, carrier or payment system.** Kestrel Goods, its policies, orders, serial numbers, labels and refunds are fictional and simulated in `sim_*` tables. Nothing real is ever created.
- **No customer authentication or account linking.** The server acts for one configured fictional customer. See [THREAT_MODEL.md](THREAT_MODEL.md).

## Language understanding

- **Rules-based interpreter only.** No language model is called. There were no model credentials in the build environment, and decisions are designed not to depend on generated text. The `Interpreter` port lets a model-backed implementation be added, with the rules interpreter as fallback. That implementation is not built.
- The interpreter recognizes a limited vocabulary: return or exchange intent, common fault phrases, change-of-mind phrases, a handful of product nouns, serial and order-number formats. Unusual phrasing may be missed. The compiler then asks for the missing item rather than guessing.

## Product scope

- One workflow is built deeply: **return for a refund**. Replacement, refund-without-return and warranty referral are evaluated as candidate actions and shown as allowed or blocked, but only the return can be executed. The warranty referral is a message, not an operation.
- Policies support delivery-based windows per category and reason, a returnless-refund price limit, and a warranty remedy. Restocking fees, condition grading, partial refunds and multi-item orders are not modelled.
- Escalation (`needs_review`) explains what is blocking and what would resolve it, but the product has no human-agent console to resolve it. New evidence can move the case on again.
- The business date is pinned (2026-10-17) so the demo is repeatable. Override it with `AFTERCARE_CASE_DATE`.

## Operational

- A single process with an in-memory per-case lock. Horizontal scaling would rely on optimistic version checks and unique constraints only.
- No rate limiting. The demo-control endpoints are not role-gated beyond the optional access token.
- **Hosting:** the project runs locally with one command. It has not been deployed to a public URL from this environment. Official sources disagree on whether a live endpoint is required during judging; see [COMPETITION_REQUIREMENTS.md](COMPETITION_REQUIREMENTS.md).
- The browser MCP client probes `GET /mcp` for an optional SSE stream and gets 405 from the stateless server. This is expected behaviour, but it appears as a network error in the browser console.
- Voice input uses the browser's Web Speech API where available (Chrome or Edge). Read-aloud uses speech synthesis. Neither is required.

## Evaluation

See the limitations section of [EVALUATION.md](EVALUATION.md): 14 synthetic scenarios, hand-labelled, with a deterministic baseline that is not an LLM.
