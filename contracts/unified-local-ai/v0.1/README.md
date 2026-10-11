# Unified LOCAL_ONLY capability contract v0.1 (REVIEW DRAFT)

**Status:** static code-only metadata contract, no runtime integration, no operational authority. This is a scoped proposal in the AI Development Studio repository, not a cross-repository deployment. Source facts were cross-checked against pinned GitHub commits on 2026-10-11. Both Windows Chris and MacMiniOffice.local were reported **Offline** by Remote Desktop Commander during this review. No endpoint, OS process, project checkout, VM, GPU lease, browser session, Blender GUI, MCP server, model inference, or production deployment was checked live here.

## Why

Three independent products may later expose a common read-only description of their capabilities. Merely reading a descriptive record must never become authorization to start GPU work, VM, plugins, cloud credit spending, shell commands, printer operations or new persistent services. `declaredModes` are documentation labels, never permission flags. The static fixtures are intentionally runtime `UNKNOWN` and no adapter exists.

## Scope

- `capability.schema.json`: strict JSON Schema for **static source snapshot declarations** only.
- `validator.mjs`: fail-closed zero-dependency reference validator and non-executing request evaluator.
- `fixtures/*.json`: three independent pinned code snapshots; NO machine names/ports/credentials/customer data. The Genex fixture pins **release v0.1.6**, not moving upstream `dev`.
- `validator.test.mjs`: deterministic Node.js negative/positive tests; no network or external libraries.

Run from this folder: `node --test validator.test.mjs`. The test uses only the supplied fixtures and built-in Node modules. Running it does not launch Ollama, Windows Sandbox, Genex, Blender, TripoSR, a local listener or a printer.

## Non-negotiable gates

1. **Evidence is not execution permission:** a live host needs independently authenticated identity, fresh owner/port readback, explicit operator authorization and project-specific review; this v0.1 schema *cannot* express those approvals. Anything except `inspect_static_descriptor` is denied.
2. **Always local-only by default:** no automatic network egress, SaaS, external accounts, credits, providers or fallback. Genex Tools and 3D AI Studio MCP are external and remain out of scope.
3. **Resource ownership stays separate:** LOCAL3D's internal GPU lease does not coordinate with Ollama or Blender; Studio's per-job Windows VM journal is not a host-wide global lock (#17). Unknown resource state is not availability.
4. **Separate repos and Human Review:** no common job queue, mutable shared data store, direct code imports, Git merges or execution endpoints; independent versioning and release QA remains mandatory.
5. **Physical manufacture always blocked:** `trusted=false`, `printQualified=false`, `approvedForPrinter=false`, `fabricationAction=NONE`; even valid SHA and geometry tests do not grant print approval.
6. **No runtime authority:** `evaluateRequest` only returns `STATIC_METADATA_ONLY` for inspection, or `DENY`. It does not dispatch tools, inspect hosts or read/write project assets.

## Known gaps / next gates

- Resolve 127.0.0.1:4178 ownership from live process + `/api/health`; docs disagree (Office vs Studio). G1/4177 and manual G2/4179 also require fresh live verification.
- Studio: design and mock-test cross-root host-wide Windows Sandbox ownership before issue #17 can be closed. No OS/root/ACL changes without approval.
- LOCAL3D: bounded 100 MiB HTTP asset readback concurrency and independent manifest provenance; Windows native decoder sandbox/egress remains unproven (Issues #3/#4/#5 stay open).
- Genex: Mac lab offline recheck first; native/Electron/Blender GUI requires OS isolation and approval; OAuth, external 3D AI Studio MCP and any credits require separate consent.
- Contract v0.2 would need independently attested live status and a different authorization layer. DO NOT mechanically loosen v0.1 constants or infer permission from green fixture tests.

**The validator/schema are a reviewable prototype, not an audited security boundary.** No CI/full-product regression, Windows NTFS/WSB test, host deployment, GUI acceptance, or source project runtime readback is claimed by their local Node fixture test results.
