# Isolated Git Worktree Review Pilot — v0.0.4

## What is working
- A local Ollama model can inspect and edit two files (index.html and styles.css) using strictly allowlisted tools.
- Each run creates a uniquely named Git worktree in the ignored `.pilot-workspace/` folder.
- A separate seed repository supplies a reproducible starting point. No Office, VelvetOS, or user project files are imported.
- The model adds an accessible button in HTML and keyboard-focus styles in CSS.
- Ten deterministic static checks verify structural constraints and prohibited content without executing generated code.
- The run becomes **pending** only if both files changed, checks passed, Git sees no unrelated changes, and the Git diff is valid.
- Review manifests persist between app restarts. The browser can recover pending/approved/failed reviews and inspect the plain-text Git diff.
- **Approve & commit pilot branch** creates a commit only on the review branch; it does not merge to main.
- **Discard / rollback pilot** deletes the worktree and its review branch, even after an isolated approval. It never mutates main.
- After preparation, an approval is refused if the reviewed files have changed.

## User flow
1. Start the existing local service with `npm start`.
2. Open http://127.0.0.1:4178 on Windows.
3. Select a detected local Ollama model.
4. Click **Run two-file worktree demo** and observe tool steps.
5. Inspect the proposed Git diff and the check results.
6. Choose **Approve & commit pilot branch** or **Discard / rollback pilot**.
7. Refresh: pending and approved review states are still available.

No app-imposed message quota; Ollama remains the selected inference provider. Cloud providers are disabled.

## Developer checks
- `npm test` — includes two-file review store and simulated-agent tests.
- `node scripts/manual-review-pilot.mjs` — actual local model run via CLI, leaves uncommitted pending review.
- `node scripts/manual-review-action-api-smoke.mjs` — exercises approve, approved diff, discard, remote-model blocking and unchanged main through HTTP.
- `node scripts/manual-review-sse.mjs` — live local model request through streamed HTTP endpoint, leaves pending review.

## Security boundaries
Git worktrees separate filesystem changes and branches but are **NOT** an OS execution sandbox.
Only two exact pilot filenames can be edited, and the local agent exposes no arbitrary shell, network, dependency installation or generated-code execution tools.
The server binds to loopback; same-origin request validation and a restrictive browser connect-src policy prevent implicit off-machine model requests.
Unexpected files, symlinks, path traversals, altered content after review, and remote inference URLs are rejected.
This is a demonstration of the review workflow, not proof that arbitrary code from a public repository can be executed safely.

## Machine inspection (October 9, 2026)
Windows pilot: Docker unavailable, Podman unavailable, and the Desktop Commander service context cannot invoke WSL (`WSL_E_LOCAL_SYSTEM_NOT_SUPPORTED`).
Therefore full project `npm install`, shell commands, untrusted scripts and dev servers remain disabled.
A production sandbox must be designed and independently audited before enabling those capabilities.

## Upgrade criteria
- Separate job runner with OS process-level isolation and resource limits (network, filesystem, CPU, RAM and time).
- Allowlisted project roots and security policy enforcement independent of model output.
- Cancellation, timeouts and recovery after app crash.
- Real validation (unit tests, builds and browser preview) executed ONLY in the sandbox.
- Change review with per-file and per-hunk approval, Git baseline selection and audit trail.
- Repeatable benchmarks on at least three nontrivial projects, including failed model operations.
- Optional local model routing and third-party cloud provider plugins only after core workflow passes.
