# Customer setup — single machine

This is the fastest, safest way to run claude-broker for one customer: the broker and all their
Claude Code sessions live on **one computer**, talking over `localhost`. No TLS, no network
exposure, no reverse proxy. (For a team spread across machines, see
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) instead — that path *requires* TLS.)

---

## Part A — You (once, to deliver the code)

1. **Create a private GitHub repo** and push this cleaned copy:
   ```bash
   cd claude-broker-oss
   git remote add origin git@github.com:<you>/claude-broker.git
   git push -u origin main
   ```
2. **If your repo name/owner differs from `anisthesia/claude-broker`**, update the URLs in
   `package.json` (`homepage`, `repository`, `bugs`) and the clone line in `README.md` so the
   customer's `git clone` works.
3. **Grant the customer read access** to the repo (Settings → Collaborators).

> No GitHub? Run `npm pack` to produce `claude-broker-2.1.0.tgz` and send them the file; they
> install it with `npm install ./claude-broker-2.1.0.tgz`.

---

## Part B — Customer (on their machine)

### 0. Prerequisites

- **Node.js ≥ 20.** Check with `node -v`.
- **A C toolchain** (the broker uses the native `better-sqlite3` module, compiled at install):
  - macOS: `xcode-select --install`
  - Ubuntu/Debian: `sudo apt-get install -y build-essential python3`
  - Windows: install the "Desktop development with C++" workload (Visual Studio Build Tools)
- **Claude Code** installed and logged in.

### 1. Clone & install

```bash
git clone https://github.com/<you>/claude-broker.git
cd claude-broker
npm install          # compiles better-sqlite3 — this is where a missing toolchain fails
```

### 2. Configure — run the setup wizard

```bash
npm run setup -- --project /path/to/the/customers/project
```

The wizard scans the project for its components (backend, frontend, …), derives a namespace,
generates a strong `SHARED_SECRET`, and writes `.env` + `workers.json` for you. It's re-runnable
and never overwrites an existing secret. Run it once now (before the broker is up) to write the
config; run it again after step 3 and it will also register starter channel schemas on the running
broker. It prints the exact `claude mcp add` command for step 4 at the end — copy that.

> Prefer to do it by hand? `cp .env.example .env`, then
> `echo "SHARED_SECRET=$(openssl rand -hex 32)" >> .env`. **The broker refuses to start without a
> secret** — a deliberate safety default.

### 3. Start the broker & verify

```bash
npm start
```

Expected:
```
[claude-broker] v2.1.0 listening on :8080  auth:on  prune:48h  exempt:[]
[claude-broker] dashboard: http://localhost:8080/dashboard
```

In a second terminal:
```bash
curl -s localhost:8080/health      # {"ok":true,...}
```

Leave `npm start` running. (Make it persistent in step 6.)

### 4. Register the broker in each Claude Code session

Run this once **per project/session** that should join the bus. The bearer token must match the
`SHARED_SECRET` from `.env`:

```bash
claude mcp add --transport http broker http://localhost:8080/mcp \
  --header "Authorization: Bearer <paste-SHARED_SECRET-here>"
```

Now every session started in that project has the broker's tools available.

### 5. Prove it works (2-minute acceptance test)

Open **two** Claude Code sessions. In session A:

> Use send_message to post to channel "smoke-test", sender "A", content "hello from A".

In session B:

> Use wait_for_messages on channel "smoke-test" since_id 0.

Session B should receive A's message. Open `http://localhost:8080/dashboard` in a browser
(it'll ask for the token — paste the secret) and you'll see the `smoke-test` channel with one
message. **If both happen, the deployment is good.**

### 6. Keep it running

`npm start` stops when the terminal closes. For an always-on local broker:

- **macOS** — a launchd agent (see [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md#launchd-macos)).
- **Any OS** — pm2: `npm i -g pm2 && pm2 start server.js --name claude-broker && pm2 save`.
- **Quick & dirty** — run `npm start` inside a `tmux`/`screen` session.

---

## Part C — Wire it to the customer's project (the actual value)

The broker is running; now shape it around their repo. This is where multi-agent coordination
pays off. Two optional layers:

### Channels & schemas

Pick a short namespace prefix for the customer (e.g. `acme-`) and one channel per component plus a
shared status/telemetry channel:

```
acme-backend, acme-frontend, acme-worker   # per-component inboxes
acme-status                                # results firehose
acme-telemetry                             # heartbeats (dashboard cost view)
acme-control                               # broadcasts
```

Optionally enforce a message protocol by registering a schema on a channel (start permissive):

```
register_channel_schema(channel="acme-status", schema=<contents of schemas/status.json>, strict=false)
```

`strict=false` warns on non-conforming messages; flip to `strict=true` once the format settles.
See [schemas/README.md](schemas/README.md). The examples in `schemas/` are a full task/result
worker protocol — copy and trim them to the customer's needs.

### Worker supervision (advanced, optional)

Only if the customer wants the broker to *start and stop* long-running agent processes. Copy
`workers.example.json` → `workers.json`, point each entry's `--repo-root` at the customer's repo,
set `WORKERS_CONFIG=./workers.json` and `WATCHDOG_BIN=<their supervisor script>` in `.env`, and
restart. Most first customers can skip this entirely — plain messaging between sessions is the
core feature. See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md#worker-supervision).

### Starter role files (optional)

Add `--scaffold-roles` to the setup wizard to generate ready-to-use agent instructions:

```bash
npm run setup -- --project /path/to/project --scaffold-roles
```

This writes a `roles/` folder with one `orchestrator.md` and one `<component>.md` per worker. Each
file defines that session's identity, its channels, a turn-start ritual, and the exact task/result
envelope to use (the examples are validated against the strict schemas). Use each file as the
`CLAUDE.md` in the directory where you run that session — or paste it as the session's opening
instructions. This is the fastest way to get the orchestrator and workers behaving consistently.

---

## Gotchas checklist

- [ ] `node -v` ≥ 20 **before** `npm install` (native build).
- [ ] `SHARED_SECRET` set in `.env` — the broker won't start otherwise.
- [ ] The `Bearer` token in `claude mcp add` **exactly matches** `SHARED_SECRET` (a mismatch → 401).
- [ ] Broker is running before sessions try to use its tools.
- [ ] Dashboard prompts for the token on first load — that's expected; paste the secret.
- [ ] Everything is on `localhost` — never expose port 8080 to a network without the TLS setup in
      [docs/SECURITY.md](docs/SECURITY.md).
