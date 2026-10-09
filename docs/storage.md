# Persistent review storage (v0.0.6)

The Studio can optionally store its **two-file Git-review pilot data** outside the application checkout. This makes source upgrades and secondary checkouts easier to test without automatically moving or deleting review data.

## Configuration

The default remains the existing, backward-compatible `<app checkout>/.pilot-workspace` path. Existing users do not have to change anything.

For a **new** independent storage root, launch a single Studio process with an absolute `STUDIO_DATA_ROOT` path. Example on Windows PowerShell:

```powershell
$env:STUDIO_DATA_ROOT = "D:\Velvet\AIStudioData"
$env:STUDIO_PORT = "4181"
npm start
```

On macOS, an equivalent environment variable may be set to an absolute, non-root path such as `$HOME/Velvet/AIStudioData`.

The `/api/health` endpoint reports `storageMode: external` or `legacy-project-local`; it does not expose the absolute storage path to the browser. The single-file CLI demo remains a legacy stand-alone pilot in its original local path.

## Data model

`STUDIO_DATA_ROOT` contains the `seed-repo/`, `review-worktrees/`, and `review-manifests/` directories. The application will fail closed if a storage directory is a symlink, a supplied path is not absolute, or the seed repository is not recognized.

All user approval, discard, and integrity-check behavior remains unchanged. Two different source checkouts can read an existing review store **sequentially** using the same `STUDIO_DATA_ROOT`, as validated by tests.

## Important limits

- **Do not simply copy or move an existing `.pilot-workspace` folder**: Git worktree administrative references may contain absolute paths. A dedicated, validated migration workflow is needed before migrating current user Reviews.
- **Do not run two Studio servers against the same `STUDIO_DATA_ROOT` at once**. Cross-process write locking is not implemented yet; the feature is designed for controlled, single-process prototyping.
- There is no automatic migration, deletion, backup, background synchronization, or network storage support in this prototype.
- Do not configure this directory inside sensitive system or user profile locations.
- The review data may contain generated code or file contents. Protect it using normal filesystem permissions and backups; no remote uploading is performed.
- This feature does not make executing generated code safe. Arbitrary Shell/build execution remains disabled.

## Tests

`npm test` includes five new storage-isolation tests: legacy default, external review continuity across checkouts, invalid paths, symlink rejection, and unexpected foreign seed data.

For HTTP verification, run the Studio server and `scripts/manual-integrated-preview-smoke.mjs` with the same `STUDIO_DATA_ROOT`; set `STUDIO_TEST_URL` to the matching local HTTP address.
