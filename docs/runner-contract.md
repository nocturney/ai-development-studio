# Studio offline runner contract — v0.0.7

**Status: package preparation validated; Windows Sandbox execution remains DISABLED.**

## Why this exists

The first coding agent edits restricted HTML/CSS files but must NOT run arbitrary project scripts in the host process. Git worktrees isolate branches, not execution. This module prepares an explicit Node test-run package for a future Windows Sandbox VM. No feature is enabled, no VM is launched and no guest code is executed by package preparation.

## Contract

- `src/sandbox/offline-runner.mjs` validates source-file names, size caps and a fixed `node-offline-tests` task (only explicit `*.test.mjs` or `*.spec.mjs` entrypoints).
- A canonical SHA-256 manifest records all input hashes, timeout (5–120 seconds), memory (4–16 GB) and `network: disabled`.
- Package directories are created with exclusive create; payload files are staged under `bundle/source/` and the portable Node executable under `bundle/node.exe`. The input files and guest PowerShell runner are mapped read-only **inside** Windows Sandbox.
- A **separate, newly created output folder** is the sole writable host mapping; it is used only for `result.json`. No project or source directory is mapped writable. Guest executes from VM temporary storage.
- `job.wsb` explicitly disables network, vGPU, clipboard, microphone, video and printer redirection; enables ProtectedClient. A script in the read-only bundle is referenced through LogonCommand.
- The guest script verifies SHA-256 checksums of the copied source files and runs only bundled Node test entrypoints, with a timeout and bounded stdout/stderr capture.
- Host result parser validates schema, job ID, manifest fingerprint, exit code, limits and lengths. **All guest results remain untrusted, require human review, and never auto-approve a Git change.**

## Current verification

`npm test` tests the runner contract and static safety gates. The guest script parses without syntax errors in PowerShell, and `npm run runner:prepare` packages a two-file calculator fixture with the host's existing portable Node executable. This creates files only under the ignored local `.pilot-workspace/offline-runner-packages` directory.

## Not yet enabled

- Windows Sandbox is Disabled on the current Windows host. Windows reported firmware virtualization not enabled. Supporting virtualization and any required restart must be scheduled separately.
- There is no trusted host job launcher, no guest readiness handshake, no verified VM process lifecycle and no host-side kill/cleanup policy.
- Output is a prototype contract only; a malicious guest can forge its writable `result.json`. Host must never treat it as proof of safety or merge authority.
- There is no installation or network dependency resolution in the sandbox. Tests must be self-contained or have explicitly bundled dependencies.
- CPU ceilings are not controlled by the WSB XML profile. The contract bounds memory and guest duration; stricter process limits, VM lifecycle and global concurrency controls must be designed and tested.
- Windows Sandbox is not a headless application container; logon commands require a running VM user session. This has not been exercised.
- The input bundle remains a host directory rather than tamper-evident sealed storage; rehash inputs immediately before future VM launch.
- This contract is independent of Office 2.0 and Cloud Providers.

## Commands

```sh
npm test
npm run runner:prepare
```

**Do not double-click or launch the resulting `.wsb` file in this prototype.** It is a generated future-run configuration, not a completed or secure execution service.

References: Microsoft Learn Windows Sandbox configuration, mapped folders, LogonCommand and install prerequisites.
