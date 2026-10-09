# Agent Pilot — v0.0.3: first live run passed

## Goal
Validate a tool-using local coding loop using the existing Windows Ollama server and Qwen 3.5 9B. This pilot is deliberately smaller than a production coding agent.

## Scope
- Runs through `npm run agent:pilot` (CLI) or through the web UI Run safe agent demo button.
- Reads and writes only one allowlisted file named `index.html` in `.pilot-workspace/`.
- The task is to preserve the heading and add an accessible demo button.
- Exposes `read_file`, `write_file`, `run_checks`, `finish` and no other tools.
- Enforces read-before-write and checks-before-finish, independently of model instructions.
- Checks are static only; generated code is NOT executed.
- Limits HTML size, blocks scripts/iframes, inline event handlers and remote URLs.
- Uses loopback Ollama only. No model API provider or remote network fallback.
- The original project files, Office 2.0 and VelvetOS Core are never writable by this pilot.

## Test procedure
`npm test` covers model response harness, path controls, provider policy, and step ordering.
`npm run agent:pilot` runs a live inference against the installed model.
CLI run artifacts (ignored by Git) are in `.pilot-workspace/cli-<timestamp>/` with `index.html`,
`index.before.html`, and `pilot-report.json`. Web demo runs each get a separate `browser-<timestamp>-<id>` folder.
The first real Qwen3.5 9B CLI run passed all five static checks with four tool calls (read, write, check, finish).
UI streams progress events and returns the before/after line diff when complete.

## Why not OpenCode first
OpenCode remains a candidate for the full agent host with an official headless server/SDK.
The Ollama integration docs recommend 64K+ context for OpenCode. Current Qwen 9B smoke tests are tuned to 16K.
Rather than paying the cost of huge context or granting shell access to the host without isolation,
prove local tool calling through a narrow executor, then benchmark OpenCode behind the same provider API.

## Next hard gates
- Repeated live success on at least three varied tasks; model/tool correctness and latency metrics.
- Turn cancellation, secure worktree isolation and deny-by-default shell permissions.
- Diff viewer, human approval for sensitive actions, recovery/rollback and repeatable verification.
- Full project code agent, editor and live preview only after executable sandbox exists.
