# Contributing

Thanks for your interest in improving claude-broker. It's a small, focused project — a single
server file plus tests — so contributing is straightforward.

## Development setup

```bash
git clone https://github.com/rideprodev/claude-broker.git
cd claude-broker
npm install
cp .env.example .env      # set a SHARED_SECRET
npm test                  # runs the full suite against a scratch broker
```

Node.js ≥ 20 is required (native `better-sqlite3`).

## Project layout

| Path | What |
|---|---|
| `server.js` | The entire broker: DB setup, MCP tools, HTTP routes, dashboard. |
| `run-tests.js` | Aggregate runner — boots a throwaway broker on a temp DB and runs every suite. |
| `test-*.js` | Test suites (MCP tools, schema validation, REST, heartbeats, regressions). |
| `schemas/` | Example JSON schemas (a task/result worker protocol) used as fixtures and reference. |
| `docs/` | API, deployment, and security docs. |

## Making changes

1. **Branch** off `main`.
2. Keep changes focused; `server.js` is deliberately one file — match the surrounding style.
3. **Add or update a test** for any behavior change. The suite is the safety net.
4. Run `npm test` — all suites must pass.
5. Open a PR describing the change and its motivation.

## Testing conventions

- `run-tests.js` isolates everything on a scratch DB and a spare port (`TEST_PORT`, default 8181);
  it never touches a live `broker.db`.
- Individual suites can be run against a running broker via
  `BROKER_URL=http://localhost:8080/mcp SHARED_SECRET=... node test-v2.js`.
- Tests use run-scoped channel prefixes so they're safe to run repeatedly.

## Reporting bugs & security issues

- **Bugs / features**: open a GitHub issue with repro steps.
- **Security vulnerabilities**: report privately (see [docs/SECURITY.md](docs/SECURITY.md)), not
  in a public issue.

## License

By contributing, you agree your contributions are licensed under the [MIT License](LICENSE).
