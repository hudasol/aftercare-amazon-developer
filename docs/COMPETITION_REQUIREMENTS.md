# Competition requirements and compliance

**Competition:** Build, Ship, Shape: Amazon Developer Hackathon (AmazonAppDev 2026), Alexa+ track
**Checked:** 2026-10-18, against the primary sources listed at the end of this file
**Submission deadline:** Friday 23 October 2026, 12:00 pm Pacific Time

This file separates what the official sources say (quoted) from our reading of them. Quotes are kept short; follow the links for full text. Devpost blocked automated page fetches (HTTP 403), so pages were downloaded with curl and read directly.

## 1. What the Alexa+ track accepts

| Topic | Confirmed (source) | Our reading |
| --- | --- | --- |
| Valid submission | Build "a working Agent Skill or a self-hosted MCP server" (Rules, project requirements). The minimum MCP version is 2025-11-25. | Two routes: a self-hosted MCP server, or a simulated Alexa+ experience in a web app. |
| MCP route specifics | MCP server must implement "spec version 2025-11-25 (or a later version, once confirmed) over Streamable HTTP" (Rules, submission requirements). | 2026-07-28 now exists, but the rules have not confirmed it, so we target **2025-11-25**. |
| Simulated route | "simulate the Alexa+ experience in a web app"; no "specific framework, SDK, or MCP-shaped surface required"; exempt from the runtime-technology-hook requirement (Rules). | Allowed, but it shows less of the track's technology. |
| Runtime proof (non-simulated) | Track technology must be "imported and actually called", "not just named in the README" (Rules). | Our MCP tools must actually be called at runtime. The demo client calls them over HTTP. |
| Demo client | A standard MCP client is "technically sufficient", but a polished UI that "could reasonably work through an Echo device will likely score higher" (forum 45567). A web page sending initialize, tools/list and tools/call over Streamable HTTP "satisfies the requirement" (FAQ). | Our customer surface is a web MCP client, labeled as a simulated Alexa+-style surface. |
| Native Alexa+ integration | Add-on tools (Category SDK, MCP Toolkit, CLI, Web Simulator) "are in preview and available to select partners only", with "no way for hackathon participants to apply" (FAQ). Registering a server with Alexa+ directly "is incorrect" (forum 45263). Expected level of Alexa+ integration: "None whatsoever" (forum 45397). | We make no native integration claim. There is no account linking and no Alexa+ registration. |

## 2. Mandatory submission items

| Requirement | Source | Status in this repo |
| --- | --- | --- |
| Working project built during the submission window | Rules | Built from an empty repository during the window (see git history). |
| GitHub repo with "all necessary source code, assets, and instructions" and "clear setup and run instructions" | Rules | `README.md`. |
| Repo must be public with an open-source license file visible in the About section, **or** private and shared with the named reviewers | Rules; update "Got an idea"; forum 45264 | Apache-2.0 `LICENSE`. **Action for the submitter:** make the repo public and check that the license shows in the About sidebar. |
| Demo video under three minutes on YouTube or Vimeo, public, showing the project working | Rules | `docs/DEMO_SCRIPT.md` is the script. **Action for the submitter:** record and upload it. |
| Text description | Rules | Can be drawn from `README.md`. |
| Product feedback on every tool, API or SDK used | Rules ("a required part of every submission") | `docs/PRODUCT_FEEDBACK.md` is a draft. **Action for the submitter:** review it and paste it into the form. |
| Track and mini-challenge selection | Rules | Alexa+ track. |

## 3. Judging

- Stage 1 is pass/fail: does the project "reasonably fit the theme and reasonably apply the required APIs/SDKs" (Rules)?
- Stage 2 has four equally weighted criteria, each scored 1 to 5: **Technological Implementation, Design, Potential Impact, Quality of the Idea** (Rules; update "Got an idea").
- The Rules list examples. Obvious: "single-turn Q&A bot, basic MCP wrapper around an existing API". Creative: "agentic workflow that orchestrates across services autonomously", "context-aware add-on that maintains state across sessions".
- Organizer guidance (forum 45397): Alexa+ is a "consumer-focused personal assistant"; aim for "voice-first … but not voice-only".
- Optional friction logs can add "up to 10%" to the score (Rules).

How AFTERCARE answers this:

- It is multi-turn and stateful, and cases persist across sessions.
- The Resolution Compiler is the main contribution. It is not a thin wrapper.
- Every tool response includes a short `speech` line for a voice surface and a structured `display` card.

## 4. Hosting (sources conflict)

- FAQ: "hosting isn't required"; a "locally runnable public repo plus your demo video is enough".
- Forum 45411 and forum 45493 (the newest reply, about 7 days before our check): the endpoint "needs to be live and accessible till the end of the judging period".
- The judging period is given as Nov 9 to Nov 20 (Rules) and Oct 26 to Nov 20 (schedule page).

**Our approach:** the project runs locally with one command, and it can be deployed as a single Node service (see `README.md`, Deployment). Whether to publish a public endpoint is the submitter's call. The Rules say ambiguity should go to organizers as a written clarification request.

## 5. Branding and simulation

- "We cannot grant you approval to use the Alexa+ logo" (forum 45450). Plain text such as "Simulated Alexa+ add-on" with no logo is "fine" (forum 45541).
- Simulated integrations are allowed. The judging criteria "aren't bound by the publicly documented addon capabilities" (forum 45199).
- The product uses no Amazon or Alexa logos, colors or proprietary UI. All retailer, order and policy data is fictional and labeled as demo data.

## 6. Mini-challenges (optional)

| Challenge | Requirement | Decision |
| --- | --- | --- |
| AWS Builder | "incorporates AWS services (i.e. Amazon Bedrock, AgentCore, Strands SDK, Kiro Crew, SageMaker, etc.) with documented integrations" | **Not pursued.** There are no AWS credentials in this environment, the hackathon's AWS credits ran out on Oct 7, and adding an AWS service just for the prize would add risk without improving the product. |
| Open Source | A *new, additional* open-source project or contribution. The primary-track repo "doesn't count" (forums 45547, 45567). | **Not pursued.** It needs a separate project and would pull time from the primary submission. |

## 7. Route decision

| Criterion | Route A: self-hosted MCP server | Route B: simulated web experience |
| --- | --- | --- |
| Eligibility | Explicitly accepted. Needs 2025-11-25 and Streamable HTTP, called at runtime. | Explicitly accepted and exempt from the runtime hook. |
| Tooling available to us | Official TypeScript SDK 1.32.1 negotiates `2025-11-25` (checked locally on Node 24). | No constraints. |
| Implementation risk | Moderate. Transport and tool contracts need tests. | Low. |
| Demonstrability | A web MCP client gives the same visual demo as Route B, and the server also works with any standard MCP client. | Good, but the agent boundary exists only inside the app. |
| Product fit | Tools are the boundary an assistant like Alexa+ would call, so the add-on story is real. | A simulation of something we could have built for real. |

**Chosen: Route A.** AFTERCARE is a self-hosted MCP server on spec 2025-11-25 over Streamable HTTP. Its tools call the same application services as the web interface.

The customer experience is a web MCP client, labeled *"Simulated Alexa+-style surface"*. It does what an assistant would do: it sends the customer's words and structured choices to the tools, and it renders the returned `speech` and `display`. Route B was rejected because it would show less of the track's technology for no reduction in risk. The MCP server is the part of the system that would actually connect to Alexa+.

## 8. What the demo must show

- The customer problem, stated plainly, in the first few seconds.
- MCP tools being called at runtime, visible in the Lab's event timeline and named in the video.
- The flagship Return Rescue workflow: a blocker, the customer resolving it, a scoped approval, execution, an ambiguous timeout, safe reconciliation, a verified outcome, and resuming the case after a restart.
- The baseline comparison, using measured numbers only.

## Sources (accessed 2026-10-18)

- Overview: https://amazonappdev2026.devpost.com/
- Rules: https://amazonappdev2026.devpost.com/rules
- FAQ: https://amazonappdev2026.devpost.com/details/faqs
- Dates: https://amazonappdev2026.devpost.com/details/dates
- Resources: https://amazonappdev2026.devpost.com/resources
- Forum: https://amazonappdev2026.devpost.com/forum_topics (threads 45058, 45199, 45262, 45263, 45264, 45310, 45321, 45329, 45333, 45397, 45411, 45420, 45450, 45493, 45494, 45541, 45547, 45567)
- MCP versioning: https://modelcontextprotocol.io/specification/versioning
- MCP 2025-11-25 transports: https://modelcontextprotocol.io/specification/2025-11-25/basic/transports
- MCP 2025-11-25 changelog: https://modelcontextprotocol.io/specification/2025-11-25/changelog
- Alexa+ MCP Toolkit overview, for reference only (not available to participants): https://developer.amazon.com/docs/alexaplus/add-ons/mcp-toolkit-overview.html
- TypeScript SDK: https://github.com/modelcontextprotocol/typescript-sdk (npm `@modelcontextprotocol/sdk` 1.32.1)
