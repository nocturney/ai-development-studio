# AI Development Studio (working title)

Standalone, local-first AI development studio. Independent repository, runtime and release cycle; **not an Office 2.0 component**.

**Current build: v0.0.4 research prototype.** Local model chat plus two independently verified, narrow coding-agent pilots. This is **not** a general-purpose Dyad replacement or an unrestricted developer agent.

## Running the Windows pilot

Requires Node.js 22+, Git and the existing Ollama server listening on the configured loopback port.

```sh
npm test
npm run scan
npm start
```

Open http://127.0.0.1:4178 on the **same machine**. The app only binds to 127.0.0.1.

## What to try

- **Local chat:** choose a discovered Ollama model and send a prompt.
- **One-file demo:** restricted HTML editing and static checks, with progress and diff.
- **Two-file worktree demo:** the local model reads index.html and styles.css, edits both, and runs ten static checks.
- **Human review:** inspect its Git diff; approve a commit on the isolated pilot branch or discard the review worktree. Nothing is merged into main.
- **Restart persistence:** unapproved/approved pilot reviews can be reloaded after restarting the app.

No implicit cloud model access, API keys, tokens, subscriptions or app-enforced message quotas. The cloud provider catalog remains disabled and is only for future research.

## Local model smoke tests

```sh
node scripts/manual-tool-smoke.mjs
node scripts/manual-review-pilot.mjs
node scripts/manual-review-action-api-smoke.mjs
node scripts/manual-review-sse.mjs
```

The scripts that run a model are slow and deliberately create local pilot review data. Read [review-worktrees.md](docs/review-worktrees.md) before using them.

## Safety and limitations

The model can only edit explicit pilot files in an ignored local test directory. The review engine uses Git worktrees for branching, but **Git worktrees do not sandbox code execution**. Arbitrary Shell access, package installation, user-project file editing, network access from the agent, running generated code and remote model selection remain disabled.

Full sandboxed agent execution, multi-project support, visual editor/preview, Windows/macOS packaging, and optional cloud providers are future phases. No integration with Office 2.0 until independently validated.

See [Architecture](docs/architecture.md), [Worktree Review](docs/review-worktrees.md), and [Provider Research](docs/providers.md).
