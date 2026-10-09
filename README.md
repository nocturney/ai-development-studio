# AI Development Studio (working title)

Standalone, local-first development studio. No Office 2.0 runtime or repository dependency.

Status: v0.0.3 local-chat prototype with a narrow, verified, tool-using HTML demo agent. Not yet a general code-editing agent or full app builder.

Goals:
- No application-imposed message quotas.
- Existing Ollama as local default.
- Explicit user opt-in for each remote model provider.
- No paid inference or remote transfer without clear authorization.
- Local model discovery, model routing, and tested policy checks.
- Next: standalone desktop UI, code agent, live preview, Git, and packaging.

Run `npm test`, `npm run scan`, `npm run agent:pilot`, or `npm start` from this project. The local-only web UI at http://127.0.0.1:4178 has a safe Agent Demo button and progress/diff view. No arbitrary shell commands or project-wide edits are available.

Project-specific configuration and credentials must never be committed.
