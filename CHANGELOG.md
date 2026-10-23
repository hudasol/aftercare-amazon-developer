# Changelog

All notable changes are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The project has one tagged line of
development, 0.1.0, built for the Amazon Developer Hackathon 2026 (Alexa+ track).

## 0.1.0

### Added

- Domain layer: case lifecycle state machine, versioned return policies with a declared scope,
  an evidence model with an explicit authority policy for conflicts, scoped approvals bound to
  a SHA-256 proposal digest, operation records, and the Resolution Compiler with a validated
  assessment contract.
- Persistence and services: SQLite repository with SQL migrations, write ahead operation
  records, reconciliation before any retry, postcondition verification, and recovery of
  submissions interrupted by a restart.
- Interfaces: a stateless MCP server over Streamable HTTP (protocol 2025-11-25) with ten tools,
  a read API, demo controls, Host and Origin checks, and an optional bearer token.
- Web app: an assistant surface that calls the MCP tools as a real client, and the Resolution
  Lab with the case journey, evidence inspector, decision trace, action lifecycle, event
  timeline and the simulated retailer's own records.
- Evaluation: 22 hand labelled scenarios run against AFTERCARE and two deterministic baselines,
  with generated results and a test that reproduces them.
- An optional model assisted interpreter for goal, reason, product and purchase time, with the
  rules interpreter as a fallback, and an interpreter evaluation on 30 hand labelled messages.
- A wake notice and automatic retries for the hosted demo's cold start, and an in memory rate
  limit on `/mcp` and `/api`.
- Documentation: architecture, threat model, evaluation, known limitations, product feedback,
  friction log and a timed demo script.

### Changed

- A verified return on different terms is stored and shown as a mismatch, not as a refusal.
- Only an explicit request cancels a case. A description of a fault never does.
- The evaluation scores outcomes on the retailer's settled records, and reports confirming
  before verifying as a separate measure.
- The optional model reading prefers the rules goal, and accepts a model reason only when the
  model quotes the customer's own words.

### Not included

- Native Alexa+ integration, which is not available to hackathon participants.
- Customer authentication, a persistent hosted database and a real retailer integration. See
  [docs/KNOWN_LIMITATIONS.md](docs/KNOWN_LIMITATIONS.md).
