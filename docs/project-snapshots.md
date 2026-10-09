# Explicit Git project snapshots — v0.0.9

The Studio can now create a **separate copy** of selected, allowlisted source files and initialize a new Git repository with a clean `main` baseline. The source project is read-only throughout.

## User flow

1. Configure an explicit `STUDIO_PROJECTS_ROOT`. If it is absent, project browsing and snapshots are disabled.
2. Open the local Studio UI and select a project.
3. Click **Create isolated Git copy**. This is an explicit write operation in Studio's own data directory; merely browsing a project has no effect.
4. Studio lists eligible source files through the read-only catalog, copies at most 200 small UTF-8 source files (8 MiB total) and creates a separate Git repository with a baseline commit.
5. The original project folder, including its existing Git metadata, is not modified. The `.git`, `.env`, private, dependency and build folders are excluded from the snapshot.
6. The resulting snapshot metadata appears in the UI; it can be used by a future isolated Agent without granting access to the original source.

## Storage

Snapshots are placed under `STUDIO_DATA_ROOT/project-snapshots/<uuid>/` (or the legacy `.pilot-workspace/project-snapshots` directory), each containing a `checkout/` Git repo and a `manifest.json` with source file hashes.

The snapshot operation uses a fixed Git identity and explicitly disables inherited hooks through Git command overrides. **Git initializes and commits Studio's own copied files only**; no install, scripts, builds, remote fetch, or arbitrary source commands run.

## Guards

- No automatic snapshot creation. POST requests require an explicit selected project.
- Source and destination path validation, UTF-8/text-only file filtering, symlink/junction refusal.
- Up to 200 files, 8 MiB per snapshot and 25 retained snapshots; the limits prevent unbounded copying.
- Failed preparations attempt to remove only their new UUID-scoped destination.
- The manifest, Git baseline and snapshot directory remain separate from the source project.
- The HTTP response includes only the snapshot ID, source project name, file count, bytes, timestamp and new Git SHA. Absolute paths are not exposed in the browser.
- Future agents must obtain separate permission before changing copied code; no tool currently executes untrusted snapshot code or applies it to the original project.
- Snapshot metadata is treated as untrusted on reload and carefully checked before display.

## Limitations

This is **snapshot preparation**, not general app editing or a full sandbox. Imported source files can contain embedded secrets; even though credentials folders are excluded, users should opt in only to roots they are comfortable inspecting. No remote cloud model transfer occurs.

Cross-process writer locks, snapshot deletion/retention UI, deep repository features, large asset handling and safe workspace execution remain future milestones. Only one Studio process should use a particular data directory.

## Tests

Five new unit tests cover clean Git baseline creation, source immutability, excluded secret files, invalid project refusal, persistence and symlink rejection. The dedicated HTTP end-to-end smoke is `scripts/manual-project-snapshot-smoke.mjs`, targeting a purpose-built sample-site project.
