# Manual Windows Sandbox VM journal recovery — v0.0.16

## Scope and boundaries

This capability is restricted to the standalone AI Development Studio manual
Windows Sandbox workflow. It does NOT add a web/Agent VM launch or recovery API.
It does NOT launch, stop, execute code inside, or automatically delete an
unconfirmed VM. It does not grant automatic Git approval.

The purpose is to recover exactly one stale local owner journal after the
operator has independently verified that the old Sandbox VM has already stopped.
The CLI operates only on the chosen STUDIO_RUNNER_JOBS_ROOT (or the same
default LOCALAPPDATA\AIStudio\SandboxJobs used by the manual runner).

## Read-only inspection

From a signed-in Windows desktop PowerShell session:

    npm run runner:vm-recovery -- --inspect

The inspector reads the local owner record, checks the Windows Sandbox feature
and official CLI, compares the operator's actual Windows SID against the SID
stored in the journal, checks whether the recorded controlling PID still exists,
and runs the user's actual WSB list --raw. It does not create folders or mutate
files.

If anything is missing, malformed, ambiguous, occupied, owned by another user,
or attached to a still-running PID, it reports blocked rather than recoverable.

## Explicit manual release of an already stopped VM

1. Inspect the recorded VM identifier and confirm no VM is running.
2. If it is still running, stop that exact VM yourself through the official
   Windows Sandbox CLI. Do NOT use the recovery command to stop it.
3. Confirm the original controlling process is no longer running, and that you
   are signed in as the same Windows SID recorded by the original controller.
4. Inspect the journal using the read-only command above.
5. Only when the inspector reports eligible, in the same interactive terminal:

       $env:STUDIO_ALLOW_VM_RECOVERY = "1"
       npm run runner:vm-recovery -- --release

6. Type the exact phrase shown, containing the VM ID, job ID and immutable
   owner-record fingerprint prefix. If the phrase does not match, nothing is
   released. Noninteractive terminals and SYSTEM/service identities are denied.
7. The recovery engine performs two further independent WSB list queries,
   separated in time, and checks the original PID and the owner record again.
   Any active WSB session, changed owner content, SID mismatch, unknown PID
   liveness or list error prevents release.
8. Only the exact matching owner record is transitioned to stopped and released.
   Manual release takes an atomic one-operator directory guard inside the owner
   lock and revalidates the record before unlinking it. Competing releases fail;
   an interrupted release retains the parent lock or recovery guard and requires
   separate administrator-guided investigation. There is no force-unlock flag.
   If a filesystem operation fails, do not delete the partial lock by hand.

## Identity binding

From v0.0.16 onward, new VM owner records contain a Windows account SID obtained
from the OS in the exact interactive process that launches the VM. The readiness
probe fails closed when that SID cannot be verified. Cross-user inspection
cannot authorize release even if another user's Sandbox list is empty.

Legacy records created before SID binding are intentionally not eligible for
this automated release procedure. They remain locked until a separately
verified administrator-guided resolution; do not delete .vm-active by hand.

The journal also stores its original controller PID. Recovery requires that
this PID is demonstrably absent. If the PID was reused by another process, the
conservative result is to remain blocked.

## Verification — October 11, 2026

- Unit tests of absent journals, corrupt journals, wrong SID, unavailable
  Windows Sandbox, active owner PID, active VM, list failure, mismatched typed
  approval, mutated owner record, concurrent recovery, and second-list races.
- Read-only official WSB probe in the signed-in Chris session confirmed that
  Windows SID resolution works, Sandbox is Enabled and 0 VMs were listed.
- Separate controlled **synthetic orphan** under D:\Velvet\Temp:
  a trusted Node child recorded a VM journal with the correct Windows SID,
  transitioned it to stop-unverified and exited without launching any VM.
  The parent verified its PID was dead, inspected it through the real user
  WSB CLI, performed two new empty-list checks, and released that fixture's
  lock. No actual VM was launched for the recovery smoke.
- A separate actual Windows Sandbox VM was then launched through the updated
  driver to verify the new journal SID binding, with a predefined trusted
  Node addition test. The VM passed with guest exit 0, stopped successfully,
  and released its owner record. The journal's SID was checked against the
  launching Chris Windows identity before VM execution. No model-generated
  project code was executed.
- The real SID probe, synthetic recovery reports, real VM guest report,
  manifest and scripts are preserved with SHA-256 evidence at
  D:\Velvet\Services\AIStudio\logs\vm-validation-20261011\vm-recovery-v016.

## Limitations

- The recovery engine depends on Microsoft Store WSB list visibility from the
  same SID; it cannot guarantee that the operating system has no inaccessible
  hypervisor sessions. Unknown conditions block recovery.
- It does not audit VM escape resistance, CPU quotas, or the guest's test result.
- It does not automatically stop a suspected orphan, restart code execution,
  approve source changes, or scan other accounts or jobs directories.
- Multi-directory locking and broader host-wide VM orchestration remain
  future work. This manual CLI is not a full unattended recovery service.

See docs/vm-ownership.md and docs/vm-controller.md.
