# VM ownership journal — v0.0.16

## Why the journal exists

A Windows Sandbox VM can outlive the local Node process that started it if
the host process crashes, the computer loses power, or a stop command fails.

The journal stores exactly one active VM identifier, job identifier, trusted
manifest hash, verified Windows account SID (for v0.0.16+ records), original
controller PID and control state per runner-jobs folder, with atomic ownership
acquisition through a newly created directory. This does not itself prove that
the guest has stopped.

## Storage

The interactive manual-runner CLI stores jobs in a stable user-specific
directory under LOCALAPPDATA/AIStudio/SandboxJobs by default, or the absolute
STUDIO_RUNNER_JOBS_ROOT supplied by the operator.

The active owner record is kept inside the reserved .vm-active directory.
It contains no user passwords, API keys, source files or guest log payloads.

The read-only readiness command:

    npm run runner:vm-readiness

also reports any active journal and its recorded VM ID, without launching a
sandbox, modifying files, or automatically deleting an orphan.

## State machine

reserved -> launch-requested -> running -> stopping -> stopped -> released

A VM that cannot be confirmed stopped instead transitions to stop-unverified.
Such a record remains locked and explicitly requires operator investigation.
An invalid, missing or tampered owner record inside an existing lock directory
is reported as indeterminate and blocks additional runs.

The journal is released only after the controller confirms both that wsb stop
returned successfully and that the exact VM is absent from the wsb list --raw
response; only then is the stopped state recorded. VM stop is always attempted
even if progress callbacks fail, test results are malformed, or the operator cancels.

## Crash/operator recovery

1. Inspect the read-only journal status and the recorded VM identifier.
2. From a trusted, interactive Windows desktop session with Windows Sandbox
   installed, use the official Windows Sandbox CLI to inspect VM sessions:

       wsb list

3. If the exact recorded VM exists, close that VM explicitly:

       wsb stop --id <recorded-vm-id>

4. Confirm the VM is absent, inspect the job result directory and local
   ownership record. For a v0.0.16+ record bound to your exact Windows SID,
   use read-only `npm run runner:vm-recovery -- --inspect`. If the record is
   eligible and its original process has exited, manually opt in with
   `STUDIO_ALLOW_VM_RECOVERY=1` and run `npm run runner:vm-recovery -- --release`
   from a genuine interactive PowerShell session. Type the full unique phrase.
   The engine performs two additional real WSB-list checks and verifies that
   the record did not change. No automatic stop or force-unlock is available.
   Legacy records without an owner SID remain locked.
5. Do not claim success, trust guest logs, or merge source code because a VM
   produced a successful exit code. Manual review remains mandatory.

## Verified and not verified

- Automated tests cover ownership acquisition, collisions, stage transitions,
  crash persistence, corrupted journals, cancellation, confirmed stop and
  failed stop. These do not start a VM or run generated code.
- The local Windows host completed live Sandbox start, exec, list, and stop; an offline guest audit and one trusted Node test fixture passed. These checks are not a production security certification.
- Cross-process locks are limited to one configured jobs folder. Operators must
  not point different launchers at different directories to evade a stuck lock.
- Windows Sandbox CLI list/stop behavior and selected guest network/read-only isolation properties were measured live. Abrupt power-loss recovery and complete escape resistance remain unverified.
- Manual recovery unit tests verify user SID mismatch, live controller PID,
  active VM sessions, altered records, invalid list results, duplicate callers,
  and typed consent. A synthetic local orphan was released on the real Chris
  Windows host after two genuine empty WSB list queries; no VM was launched
  for that fixture. Abrupt power-loss recovery remains untested.
- The web UI has no VM launch, recovery or unlock API endpoints. Runtime
  Cloud providers remain disabled; this does not affect Office 2.0.

## Source

src/sandbox/vm-journal.mjs
src/sandbox/vm-controller.mjs
scripts/manual-vm-runner.mjs
src/sandbox/vm-recovery.mjs
scripts/manual-vm-recovery.mjs
test/vm-journal.test.mjs
test/vm-recovery.test.mjs
