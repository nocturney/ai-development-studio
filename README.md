# AI Development Studio (working title)

Standalone, local-first AI development studio. Independent repository, runtime and releases; **not an Office 2.0 component**.

**Current build: v0.0.5 research prototype.** Local model chat plus two tested, **restricted** tool-using agent pilots, Git worktree review, safe static preview, run cancellation, and crash recovery. This is **not** a general-purpose Dyad replacement, a secure production execution sandbox, or an unrestricted developer agent.

## Run on Windows

Requires Node.js 22+, Git, and Ollama running on localhost.

```sh
npm ci --ignore-scripts
npm test
npm run scan
npm start
```

Open **http://127.0.0.1:4178** on the **same machine**; the service binds only to 127.0.0.1. To use another port without disturbing an existing session, set `STUDIO_PORT` (e.g. 4180) before running `npm start`.

## What works

- **Chat:** choose a discovered local Ollama model (currently the Windows pilot uses Qwen 3.5 9B) and chat without app-imposed message quotas.
- **One-file demo:** restricted HTML editing and deterministic checks.
- **Two-file worktree demo:** inspect, edit and statically validate index.html and styles.css in a per-run Git worktree.
- **Human review:** inspect a Git diff and approve a commit on the pilot branch or discard and roll back the branch. The primary branch is not silently changed.
- **Static preview:** parsed allowlist HTML/CSS rendered inside a sandboxed iframe; scripts, forms, external resources and outbound network access are blocked by validation and response CSP.
- **Cancel run:** active two-file run cancellation via per-run token; cancellation prevents review approval and preserves partial files for explicit discard.
- **Recovery:** eight-minute agent deadline, per-inference timeouts, review heartbeats and conservative recovery of stale, interrupted runs. Existing pending/approved reviews are preserved.
- **Sandbox diagnostics:** read-only Windows Sandbox feature-state report. **Generated-code execution stays disabled even if Windows Sandbox is installed.**

Cloud provider adapters remain disabled; nothing in the app automatically falls back from a local model to the cloud. Account-based free tiers can be added separately later, with explicit privacy/cost approval.

## Checks

```sh
npm test
node scripts/manual-review-pilot.mjs
node scripts/manual-agent-cancel-smoke.mjs
node scripts/manual-integrated-preview-smoke.mjs
```

Manual HTTP smoke scripts require a separate development sidecar (default `STUDIO_PORT=4179` for cancellation and `STUDIO_PORT=4180` for integrated preview). Use loopback and never expose the dev server on public interfaces. The model smoke creates an ignored pilot workspace with changes awaiting review.

## Safety limits

**Git worktrees do not isolate processes.** The agent is currently allowed to change only two sample static files. Arbitrary Shell commands, untrusted build/test execution, dependency installation by the agent, editing customer/user projects, remote model fallback, and Office integration remain **disabled**.

The Windows host inspection found Windows Sandbox disabled; Docker and Podman were not available, and WSL was inaccessible to the remote service identity. The current implementation only diagnoses potential execution capability and generates conservative *sample* Sandbox configuration. It does **not** install, enable, launch or bypass a sandbox. Enabling Windows virtualization components may require BIOS changes and a restart.

Cursor may help review code as a separately authorized development tool, **not** as the application's model runtime. No Cursor API/Agent quota was consumed during this build.

See [Architecture](docs/architecture.md), [Git Worktrees](docs/review-worktrees.md), [Cancellation & Recovery](docs/reliability-cancellation.md), [Cursor collaboration](docs/cursor-collaboration.md), and [Provider Research](docs/providers.md).
