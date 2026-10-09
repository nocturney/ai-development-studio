# Architecture Decision 0001: Standalone local-first studio

Date: 2026-10-09
State: Accepted for prototype; revisable after benchmark.

Prototype update (2026-10-09): v0.0.3 now has a loopback-only web UI with a restricted agent demo, streamed tool events, and a line diff. The first CLI and SSE end-to-end runs passed on Qwen 3.5 9B via the existing Windows Ollama process. The executor supports only a single static HTML pilot file and does not grant shell access. This is NOT a production multi-file coding agent.

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
