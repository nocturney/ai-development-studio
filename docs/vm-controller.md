# Windows Sandbox VM execution gate — v0.0.10

## Current status

The new VM controller handles job-specific operator approval, capability checking,
preflight integrity verification, VM startup, completion polling, cancellation, guest
timeout, and VM shutdown. The VM lifecycle has been tested using mocked WSB CLI calls.
**No actual Windows Sandbox VM has run**.

Windows host inspection (October 9, 2026): Windows 11 Pro with Sandbox feature
Disabled, Hyper-V Disabled, VirtualMachinePlatform Enabled. The remote service runs
as NT AUTHORITY\SYSTEM. Sandbox binaries are not installed in this service context.

Studio's HTTP app does NOT expose VM launch endpoints. Arbitrary project execution
and host shell execution remain unavailable.

## Readiness and manual demonstration

Read-only command, safe at any time:

    npm run runner:vm-readiness

When Windows Sandbox is installed and the operator is logged into an interactive
Windows desktop session, the following future opt-in can start ONLY the bundled
sample Node.js addition test in a Windows Sandbox VM:

    $env:STUDIO_ALLOW_VM_EXECUTION = "1"
    npm run runner:vm-demo

The operator must type the exact per-job phrase containing the unique job ID and
verified manifest digest. Missing consent, service Session 0, unavailable Sandbox,
missing WSB CLI, or a headless terminal block execution.

This mode has NOT been exercised on an actual Sandbox host yet.

## Guarded lifecycle

1. Require interactive Windows user rather than a SYSTEM/service identity.
2. Confirm Windows Sandbox Enabled and the trusted WSB CLI executable exists.
3. Require environment opt-in, terminal confirmation, and exact per-job approval.
4. Verify the staged package against independently supplied trusted hashes.
5. Start a uniquely identified VM with WSB start --id and a sealed, offline XML config.
6. Poll only the dedicated result.json file within startup and execution deadlines.
7. Treat all guest output as untrusted, with mandatory human review.
8. Attempt WSB stop --id after completion, failure, timeout, or cancellation.
9. Fail closed and disclose the VM identifier if stop confirmation fails.

The config disables guest network access, vGPU, clipboard, printer and device sharing.
It exposes only a read-only input bundle and a dedicated writable result folder.

## Critical limitations

- Testing verified the controller's logic using simulated WSB CLI calls; not actual
  guest isolation, startup performance, networking behavior, or shutdown behavior.
- Unexpected host termination during the startup/stop window may leave a VM that
  requires manual investigation with WSB list and WSB stop --id.
- VM job ownership locks and post-crash VM recovery are not yet implemented.
- A privileged host process could alter staging inputs between verification and launch;
  run from a protected, single-writer staging directory.
- Guest success is not proof of secure code and never auto-approves source changes.
- MemoryInMB controls sandbox allocation, not a calibrated per-process resource quota.
- Never share credentials or real user projects with an unverified Sandbox Runner.
- No virtualization features or security settings were changed; no restart was done.
- Windows Sandbox is disabled on the connected host, and enabling it may require
  a planned reboot. That is a distinct operational milestone.

## Primary documentation

https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/windows-sandbox-cli

https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/windows-sandbox-configure-using-wsb-file

https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/windows-sandbox-sample-configuration
