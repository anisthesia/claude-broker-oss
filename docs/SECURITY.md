# Security

## Reporting a vulnerability

Please report security issues privately to the maintainer rather than opening a public issue.
Include repro steps and impact; you'll get an acknowledgement and a fix timeline.

## Auth model

The broker authenticates with a **single shared bearer token** (`SHARED_SECRET`). Any client
holding the token has full access to every tool and channel.

- The token is checked in **constant time** (`crypto.timingSafeEqual`) on `/mcp` and all
  protected endpoints, so it can't be recovered by response-timing analysis.
- The broker **refuses to start** without a secret unless you explicitly opt out with
  `BROKER_ALLOW_NO_AUTH=1` (local/trusted use only).
- `/health` is public by design (liveness probes). Everything else requires the token.

### There is no multi-tenancy

This is the most important thing to understand before deploying:

> **One secret grants everything.** There are no per-user identities, roles, or scopes. Any token
> holder can read every channel, `purge_channel`, `delete_message`, and — if worker supervision is
> configured — `start_worker`/`stop_worker`/`register_worker`.

Consequences:

- Treat the token like a root password. One secret per trust boundary.
- Run **separate broker instances** for mutually-untrusted groups; don't share one bus.
- There is no built-in audit log of who did what. If you need attribution, put it in the message
  `sender` field and enforce it out of band.

## Transport

No built-in TLS. The token and the dashboard `?token=` query parameter travel in cleartext over
HTTP. **Always terminate TLS in front of the broker** for any non-loopback deployment
(see [DEPLOYMENT.md](DEPLOYMENT.md#3-tls)) and bind the broker to `127.0.0.1`.

### Dashboard token in the URL

Because browsers can't attach an `Authorization` header to a page navigation, the dashboard
routes also accept `?token=<secret>`. Query strings can land in proxy logs, browser history, and
`Referer` headers. Mitigations: use HTTPS, restrict dashboard access at the proxy (IP allowlist /
basic-auth / SSO) instead of relying on the URL token, and rotate the secret if a URL leaks.

## Worker supervision hardening

When `WORKERS_CONFIG`/`WATCHDOG_BIN` are set, token holders can cause process spawns. The broker
defends the spawn path:

- Worker **names are validated** against `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$` and rejected if they
  contain `..` — they become log filenames and tmux window names, so this blocks path traversal.
- All spawn **arguments and the binary path are single-quoted** before they reach a shell, so
  metacharacters in a worker config or `register_worker` input cannot inject commands.
- `WATCHDOG_BIN` is operator-configured, never client-supplied.

Residual risk: a token holder can still start/stop the workers you *have* defined and register new
ones that run your `WATCHDOG_BIN`. Keep the token trusted and the watchdog script minimal.

## Input handling

- All SQL uses **parameterized statements** — no string interpolation of user data into queries.
- Channel names with control characters / newlines are rejected (prevents log injection).
- Dashboard HTML output is escaped.
- Request bodies are capped (`express.json({ limit: "1mb" })`).

## Hardening checklist

- [ ] `SHARED_SECRET` set to a 32-byte random value (`openssl rand -hex 32`); never committed.
- [ ] `BROKER_ALLOW_NO_AUTH` **unset** in production.
- [ ] TLS terminated in front; broker bound to loopback.
- [ ] Dashboard access restricted at the proxy, not just by the URL token.
- [ ] Separate broker instances across trust boundaries.
- [ ] `WATCHDOG_BIN` points at a script you control; token shared only with trusted operators.
- [ ] Backups of schemas and `PRUNE_EXEMPT` channels.

## Known limitations

- No rate limiting is built in — add it at the proxy if you expose the broker beyond a trusted
  network. Long-poll tools intentionally hold connections open (up to 60s), so size proxy
  timeouts and connection limits accordingly.
- No per-request audit trail.
