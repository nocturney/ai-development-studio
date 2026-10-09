# Read-only local project browser — v0.0.8

This is the first general project browsing capability in the standalone Studio. **It does not grant the AI agent write or execution permissions.** It is an opt-in, metadata-first way to inspect local source files while the OS execution sandbox remains unavailable.

## Enabling safely

By default the project catalog is disabled. Set `STUDIO_PROJECTS_ROOT` to an existing, explicitly approved **non-root** directory before launching Studio. Only immediate child directories in that root are candidates.

Windows PowerShell example:

```powershell
$env:STUDIO_PROJECTS_ROOT = "D:\Velvet\AIStudioProjects"
npm start
```

The UI never accepts an arbitrary absolute folder path. The server does not expose the configured root through HTTP. Cloud adapters remain disabled.

## Routes

- `GET /api/projects`: enabled state and an alphabetically sorted set of permitted immediate child projects.
- `GET /api/projects/files?project=<id>`: shallow, size-limited source-file metadata (path and byte count).
- `GET /api/projects/file?project=<id>&path=<relative>`: at most 256 KiB of selected UTF-8 text. Uses the same-origin route and returns `readOnly: true`.

The browser uses `textContent` to show all file contents. Nothing is evaluated, dynamically imported, sent to an external model, executed as HTML, or copied into Agent workspaces.

## Protections

- No catalog until an operator chooses a host directory.
- Only simple project names and approved text/code extensions.
- Rejects hidden directories, `.env`, credentials, `node_modules`, `.git`, `dist`, `vendor`, and symbolic links/junctions.
- Refuses relative path traversal, arbitrary Windows drive paths, symlinked intermediate directories, files larger than 256 KiB, binary/NUL data and malformed UTF-8.
- The list caps output at 100 projects and 240 files with a shallow directory traversal.
- **Read-only:** there is no PUT, POST, file-write, delete or execution API for imported project contents.

## Limitations

Code and documentation may still contain embedded secrets even if `.env` is excluded. In this prototype the contents remain local and visible only to the user through the localhost UI. Do not automatically pass imported project content to remote model providers; future cloud adapters will require explicit per-project consent and data-egress control.

This is not yet a full project editor, repository importer, or safe multi-file code-execution environment. It is a deliberately narrow first inspection step.

## Tests

`npm test` includes catalog activation, restrictions, read-only verification, symlink refusal and file limits. An HTTP smoke script is available at `scripts/manual-project-catalog-smoke.mjs` when a local test project is explicitly mounted.
