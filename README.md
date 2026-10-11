# AI Development Studio (working title)

Standalone, local-first AI development studio. Independent repository, runtime and releases; **not an Office 2.0 component**.

**Current build: v0.0.16 research prototype.** Local model chat plus two tested, **restricted** tool-using agent pilots, Git worktree review, safe static preview, run cancellation, and crash recovery. This is **not** a general-purpose Dyad replacement, a secure production execution sandbox, or an unrestricted developer agent.

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

- **Chat:** choose a discovered local Ollama model (Windows pilot: Qwen 3.5 9B) and receive streamed replies with a Stop button. No app-imposed daily message quota or cloud fallback.
- **Read-only project browser (opt-in):** set `STUDIO_PROJECTS_ROOT` to a permitted local parent directory and browse a restricted list of project source files. User code is never executed, edited or sent to a model from this feature.
- **Isolated project snapshots (explicit action):** create a separate Git repository baseline from permitted source files, stored in Studio data rather than editing the original project. No Agent edits or builds on imported projects yet.
- **One-file demo:** restricted HTML editing and deterministic checks.
- **Two-file worktree demo:** inspect, edit and statically validate index.html and styles.css in a per-run Git worktree.
- **Human review:** inspect a Git diff and approve a commit on the pilot branch or discard and roll back the branch. The primary branch is not silently changed.
- **Static preview:** parsed allowlist HTML/CSS rendered inside a sandboxed iframe; scripts, forms, external resources and outbound network access are blocked by validation and response CSP.
- **Cancel run:** active two-file run cancellation via per-run token; cancellation prevents review approval and preserves partial files for explicit discard.
- **Recovery:** eight-minute agent deadline, per-inference timeouts, review heartbeats and conservative recovery of stale, interrupted runs. Existing pending/approved reviews are preserved.
- **Sandbox diagnostics:** read-only Windows Sandbox feature-state report. **Generated-code execution stays disabled even if Windows Sandbox is installed.**
- **Offline runner staging and manual VM gate:** stages SHA-256-verified Node test bundles under one read-only Windows Sandbox input mapping, with an isolated writable result folder and networking disabled. A signed-in Windows user can launch only the predefined addition-test demo via a separate CLI after exact per-job typed consent. The controller now uses headless `wsb exec --run-as System` rather than relying on guest logon, validates the returned exit code and guest report, and verifies the VM disappears from `wsb list` before releasing ownership. A **trusted, hard-coded sample** was actually executed in Windows Sandbox on October 11, 2026 and passed 1/1 tests. The browser/Agent still cannot launch VMs or execute arbitrary project code.
- **Bounded guest output:** the offline VM runner now drains test stdout/stderr concurrently in fixed-size chunks, with a hard 8,000-character cap per stream and 9,000 combined. Exceeding the limit terminates the test and returns an untrusted error, not a successful or truncated test result. The collection script is independently sealed and verified during preflight. Real passing, failing and output-flooding VM fixtures passed.
- **Manual orphan recovery (CLI only):** new owner records are bound to the launching Windows user's SID. Read-only inspection checks owner PID and real WSB sessions. Release of a stale owner journal requires the same SID, two fresh empty VM lists, an inactive original PID, exact typed confirmation and a transient explicit opt-in. Legacy records lacking SID remain locked. The web and Agent cannot unlock VMs.
- **Fail-closed manual VM process exit:** a guest report of `failed`, `timeout` or `error` causes a nonzero operator CLI exit code even if the VM stopped correctly. Only a validated, passing, non-automergeable guest report after confirmed VM stop allows CLI exit 0; that still never approves source changes.
- **External review storage (opt-in):** set `STUDIO_DATA_ROOT` to an absolute directory to persist Git-review pilot data separately from the checkout; the default legacy location is unchanged. No automatic migration is attempted.

Cloud provider adapters remain disabled; nothing in the app automatically falls back from a local model to the cloud. Account-based free tiers can be added separately later, with explicit privacy/cost approval.

## Checks

```sh
npm test
node scripts/manual-review-pilot.mjs
node scripts/manual-agent-cancel-smoke.mjs
node scripts/manual-integrated-preview-smoke.mjs
node scripts/manual-stream-smoke.mjs
node scripts/manual-project-snapshot-smoke.mjs
npm run runner:prepare
npm run runner:vm-readiness
npm run runner:vm-recovery -- --inspect
```

Manual HTTP smoke scripts require a separate development sidecar (default `STUDIO_PORT=4179` for cancellation and `STUDIO_PORT=4180` for integrated preview). Use loopback and never expose the dev server on public interfaces. The model smoke creates an ignored pilot workspace with changes awaiting review.

## Safety limits

**Git worktrees do not isolate processes.** The agent is currently allowed to change only two sample static files. Arbitrary Shell commands, untrusted build/test execution, dependency installation by the agent, editing customer/user projects, remote model fallback, and Office integration remain **disabled**.

Run **one Studio server per storage directory**; cross-process locks are not implemented. Do not move existing `.pilot-workspace` directories by hand because Git worktree administrative metadata can contain absolute paths. See [Storage](docs/storage.md).

As of October 11, 2026, Windows Sandbox and Store CLI `0.8.107.0` are enabled and operational. The local host passed a live, isolated guest audit (no active adapters or default route; outbound TCP blocked; read-only input mapping; writable dedicated output) and one *trusted* Node test job via `wsb exec`. No unknown/model-generated code has been run. The user enabled Sandbox and rebooted; Studio made no OS virtualization, firewall or UAC changes. Studio's main HTTP service runs under the normal `Chris` account, while web-triggered VM launches remain unavailable. No broad claim of malicious-code escape resistance or guaranteed CPU limits is made.

Cursor may help review code as a separately authorized development tool, **not** as the application's model runtime. No Cursor API/Agent quota was consumed during this build.

See [Manual VM recovery](docs/vm-recovery.md), [Live Sandbox evidence](docs/live-sandbox-evidence.md), [VM ownership & crash recovery](docs/vm-ownership.md), [VM execution gate](docs/vm-controller.md), [Project snapshots](docs/project-snapshots.md), [Read-only project browser](docs/project-browser.md), [Offline runner contract](docs/runner-contract.md), [Streaming Chat](docs/streaming-chat.md), [Storage](docs/storage.md), [Architecture](docs/architecture.md), [Git Worktrees](docs/review-worktrees.md), [Cancellation & Recovery](docs/reliability-cancellation.md), [Cursor collaboration](docs/cursor-collaboration.md), and [Provider Research](docs/providers.md).
