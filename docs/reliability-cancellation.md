# Agent cancellation and recovery (isolated development branch)

## Purpose

Prevent long-running local Ollama requests from becoming unreviewed commits or permanently stranded worktrees. This change is developed separately from the concurrent preview/sandbox branch and does not modify the Office 2.0 repository.

## API and UI

- The two-file agent SSE endpoint emits a unique `runId` in its `start` event.
- `POST /api/agent/review-demo/cancel` requires `{ "runId": "..." }` and the current active run; mismatched identifiers receive 409.
- `GET /api/agent/review-demo/status` reports whether the current service owns an active review run.
- The UI displays **Cancel current run** only while a matching run is active.
- The selected Ollama model remains local. No model-provider fallback occurs on cancellation.
- `STUDIO_PORT` allows launching a development sidecar on a separate loopback port for API verification.

## Agent safeguards

- An overall deadline defaults to eight minutes. Inference requests also have a 115-second step timeout.
- A combined AbortSignal is checked before inference, before each tool, and before/after preparing a review.
- Cancellation or timeout sets the review status to `failed`, so it can never be approved without a new, successful run.
- Partial changes remain in the isolated Git worktree for inspection and explicit discard; nothing merges into main.
- Each step refreshes a persisted heartbeat. If an application stops unexpectedly, `recoverStaleRuns` marks **running** reviews with no activity for at least 15 minutes as failed when the server initializes.
- Recovery never deletes worktrees, never replays a model request, and never changes pending/approved reviews.
- The 15-minute recovery threshold is intentionally conservative: another process might still use the same review store.

## Limitations

- This is a safety improvement to a restricted, two-file HTML/CSS pilot, **not** a general OS sandbox.
- Worktree branch isolation is not kernel/process isolation; no untrusted scripts or shell execution are permitted.
- The current Remote Desktop Commander service context runs as SYSTEM. Windows Sandbox is disabled, Docker and Podman are unavailable, and WSL cannot be invoked from that identity. No system settings were changed, and no reboot was requested.
- Browser automation of the GUI has not been independently validated in this environment.
- Cancellation cannot guarantee Ollama instantly frees GPU memory internally after aborting the HTTP request.

## Verification

- `npm test` covers the existing project and seven new recovery/cancellation cases.
- Run a separate app server with `STUDIO_PORT=4179` for end-to-end HTTP smoke tests.
- `node scripts/manual-agent-cancel-smoke.mjs` verifies an invalid run token fails, valid cancellation succeeds (HTTP 202), SSE reports agent cancellation, and the persisted review is failed and no longer active.

## Future work

A production runtime requires a trustworthy execution sandbox with process and network isolation, resource limits, explicit project-root permissions, tests/builds inside the sandbox, crash recovery, and automated security regression tests. Enabling Windows Sandbox may require BIOS/virtualization changes and a reboot, which should be planned separately rather than done silently.
