# Security policy

AFTERCARE is a demonstration. It simulates a retailer, and every record in it is fictional.
No real customer data, credential or payment system is involved.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting for this repository if it is available.
Otherwise open an issue that describes the affected area without exploit details, and a
maintainer will arrange a private channel.

## Scope and known limits

The threat model, the controls in place and the gaps that are known and accepted are in
[docs/THREAT_MODEL.md](docs/THREAT_MODEL.md) and
[docs/KNOWN_LIMITATIONS.md](docs/KNOWN_LIMITATIONS.md). In particular:

- The hosted demo runs with `AFTERCARE_PUBLIC_DEMO=true`, so its `/mcp` and `/api` endpoints
  accept unauthenticated requests by design.
- Approval over MCP is as strong as the client that calls the approval tool.
- Rate limiting is basic and held in memory.

A deployment with real data would need authentication, per request identity and a persistent
store, none of which this repository provides.
