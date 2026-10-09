# AI Development Studio (working title)

Standalone, local-first development studio. No Office 2.0 runtime or repository dependency.

Status: Foundation prototype only, not a complete Dyad alternative.

Goals:
- No application-imposed message quotas.
- Existing Ollama as local default.
- Explicit user opt-in for each remote model provider.
- No paid inference or remote transfer without clear authorization.
- Local model discovery, model routing, and tested policy checks.
- Next: standalone desktop UI, code agent, live preview, Git, and packaging.

Run `npm test` and `npm run scan` from this project.

Project-specific configuration and credentials must never be committed.
