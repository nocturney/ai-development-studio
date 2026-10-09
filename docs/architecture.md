# Architecture Decision 0001: Standalone local-first studio

Date: 2026-10-09
State: Accepted for prototype; revisable after benchmark.

Prototype update (2026-10-09): v0.0.3 proved single-file tool use through local Qwen, CLI and SSE. v0.0.4 now extends the isolated pilot to two allowlisted files, one fresh Git worktree per run, explicit review and approve/discard actions, persisted review manifests, post-review content fingerprints, and a Git diff. The first live multi-file CLI pilot passed 10/10 checks and remained pending while main stayed untouched. This is still NOT a production general-purpose coding agent; no arbitrary shell or untrusted code execution.

Prototype update (2026-10-09): v0.0.5 integrates the two-file review system with a parsed, allowlist-based HTML/CSS preview in a scriptless sandboxed iframe. The agent now supports explicit per-run cancellation, a total deadline, persisted heartbeats, and conservative recovery from stale runs. A read-only Windows Sandbox diagnostic endpoint reports platform readiness but **does not enable execution**. Validation: 40 unit tests passed; integrated HTTP smoke checks verified preview CSP, tamper blocking, rejected/discarded review handling, and cancellation over SSE. UI browser click automation is not yet proven; no arbitrary code is executed.

## Isolation
The studio has an independent repository, release lifecycle, settings, credentials, UI, model-provider registry, and project state. No imports from Office 2.0 or VelvetOS. Future integration is an OPTIONAL adapter over documented API after product validation.

## Components
1. Desktop shell (Electron vs Tauri to be benchmarked; no commitment yet).
2. UI: workspace switcher, chat, model selector, file tree, code editor, preview, logs, history and Git diffs.
3. Agent host: OpenCode headless+SDK feasibility test first; alternative native agent if needed.
4. Provider gateway: uniform streaming/tool-calls interface, capabilities, context limits, health, latency and quotas.
5. Project executor: isolated directories/worktrees, command approvals, test runner, rollback.
6. Privacy policy: local-only mode as default, remote inference requires project+provider consent.

## Non-negotiables
- Never couple normal runtime to Office 2.0.
- Never impose application-level chat quotas.
- Never infer 'free' implies unlimited.
- Never send project source to cloud implicitly or on local failure.
- Never silently upgrade a free service to a billable account.
- Never install a third-party unofficial provider adapter as an automatic fallback.
- Never copy FSL-licensed Dyad Pro internals into an eventual competing distributed product.
- Audit every model request with provider, model, project, data egress and observed quotas; never log secrets.
- Protect build execution: isolated workspace; least privilege; no unrestricted shell execution by default.

## Candidate building blocks
Dyad Apache-2.0 source OUTSIDE src/pro can inform or support UI, subject to attribution.
Dyad src/pro is FSL 1.1 and needs separate license review.
bolt.diy is MIT but its WebContainers commercial licensing can create a dependency.
OpenCode (MIT) has a headless HTTP server and SDK, promising for agent host.
REA (MIT) is a research aid where static source inspection leaves gaps, not a component needed at runtime.

## Gates
G0: Provider registry, local inference discovery, explicit cloud policy tests.
G1: Local-only chat, streaming, selected model, errors, cancellation.
G2: Agent executes isolated edit/test/retry loop with diff and rollback.
G3: Visual app builder, preview, project lifecycle; Windows/macOS packaging.
G4: Official free remote providers with account consent, transparent quotas and zero-spend policy.
G5: Comparative coding benchmarks, reliability, security audit.
G6: Optional Office 2.0 integration adapter only if G5 passes.
