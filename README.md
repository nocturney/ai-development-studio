# AI Development Studio (working title)

Standalone, local-first development studio. No Office 2.0 runtime or repository dependency.

Status: v0.0.2 local-chat prototype, not yet a code-editing agent or full app builder.

Goals:
- No application-imposed message quotas.
- Existing Ollama as local default.
- Explicit user opt-in for each remote model provider.
- No paid inference or remote transfer without clear authorization.
- Local model discovery, model routing, and tested policy checks.
- Next: standalone desktop UI, code agent, live preview, Git, and packaging.

Run `npm test`, `npm run scan` or `npm start` from this project. The local-only web shell is at http://127.0.0.1:4178 on the Windows host.

Project-specific configuration and credentials must never be committed.
