# AI Development Studio

A standalone, local-first AI development studio **research prototype (v0.0.16)**. It is not an Office 2.0 component or a general-purpose autonomous coding agent.

## Current capabilities

- Stream local Ollama chat replies with model selection and cancellation. No automatic cloud fallback.
- Opt-in, read-only browsing of explicitly permitted project files and separate Git snapshot creation; imported projects are **not** edited by the agent.
- Restricted one-file and two-file HTML/CSS demos, with an isolated Git worktree, static validation, diff review and explicit approval or discard.
- Script-free, restricted static previews; cancellation, execution deadlines and conservative recovery after an interrupted pilot run.
- **Manual Windows Sandbox research:** a trusted, predefined addition-test demo was executed in a network-isolated VM. The operator-only CLI requires explicit consent and verifies guest reports and teardown. The browser and agent cannot launch a VM or run arbitrary generated code.

## Run locally

Requires Node.js 22+, Git and a locally running Ollama instance on the same machine.

```sh
npm ci --ignore-scripts
npm test
npm run scan
npm start
```

Open `http://127.0.0.1:4178` on that machine. The service binds to loopback; `STUDIO_PORT` can select a different port. Use a separate storage directory for each concurrent server.

## Safety boundaries

**Do not treat this as a secure sandbox for untrusted code.** Worktrees isolate file changes, not processes. Arbitrary agent shell commands, untrusted dependency installation, customer-project edits, unattended VM execution and automatic deployment are disabled. The Sandbox pilot verifies a narrowly defined trusted example, not security against arbitrary hostile programs. Cloud-provider adapters remain disabled.

## More detail

- [Architecture](docs/architecture.md) and [project snapshots](docs/project-snapshots.md)
- [Git review workflow](docs/review-worktrees.md), [cancellation/recovery](docs/reliability-cancellation.md) and [storage](docs/storage.md)
- [Offline runner contract](docs/runner-contract.md), [VM execution gate](docs/vm-controller.md), [ownership/recovery](docs/vm-ownership.md) and [live Sandbox evidence](docs/live-sandbox-evidence.md)

Detailed experimental and security evidence is maintained in those documents rather than on this landing page.
