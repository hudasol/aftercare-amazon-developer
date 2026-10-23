# Contributing

AFTERCARE is a self hosted MCP server and a web client for a fictional retailer. This
document describes how to run it, how to check a change, and what a change needs to be
accepted.

## Setup

Node.js 24 or later is required, because the project uses the built in `node:sqlite`
module. The version is pinned in `.nvmrc`.

```bash
nvm use
npm ci
npm run build
npm start
```

The server listens on http://127.0.0.1:8787. No account, key or network service is needed.

## Checks

Run these before opening a pull request. CI runs the same steps.

| Command            | Purpose                                                                                          |
| ------------------ | ------------------------------------------------------------------------------------------------ |
| `npm run check`    | Type check, lint, format check, unit and integration tests                                       |
| `npm run build`    | Build the web app                                                                                |
| `npm run test:e2e` | Browser tests (run `npx playwright install chromium` once)                                       |
| `npm run eval`     | Rerun the evaluation; it must leave the committed results unchanged unless the scenarios changed |

## Conventions

- **Layers.** The domain layer (`src/domain`) is pure: no I/O, no clock, no randomness. ESLint
  enforces this. Decisions belong to the Resolution Compiler, never to the interface or to a
  language model.
- **Language models.** The optional model interpreter produces claims by the customer only. It
  must not be able to approve, decide eligibility, submit or confirm.
- **Evidence.** Numbers in documentation come from a run of the repository. Do not add a figure
  that a command in this repository cannot reproduce.
- **Fictional data.** Seed data describes a fictional retailer. Do not add real names, orders or
  addresses.
- **Commits.** One logical change per commit, with a message that says what changed and why.
  Do not rewrite published history.
- **Scenarios.** Write the expected outcome of an evaluation scenario by hand from the policy
  text, and commit it before running any strategy on it.

## Reporting a problem

Open an issue with the steps to reproduce it, the expected behaviour and the actual behaviour.
For a security concern, see [SECURITY.md](SECURITY.md).
