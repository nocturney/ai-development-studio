# Live Windows Sandbox evidence — October 11, 2026

This note records work performed on the authorized Chris Windows 11 Pro computer, with Windows Sandbox Store CLI v0.8.107.0 and Node.js installed. All launches used the signed-in CHRIS\Chris session, not NT AUTHORITY\SYSTEM. The core service is separate and remains local-only.

## 1. Trusted empty VM lifecycle

- Before start: wsb list --raw showed no sessions.
- Started one disposable VM with no mapped host folders, networking disabled, vGPU disabled, clipboard disabled and 4096 MB VM memory.
- wsb start returned exit 0 and the chosen VM ID.
- wsb list --raw showed that exact ID.
- wsb stop returned exit 0.
- wsb list --raw afterward returned an empty environment list.

## 2. Built-in guest process execution

- A separate disposable VM was launched with the same offline base configuration.
- A built-in Windows executable, whoami.exe, was invoked inside the guest with wsb exec --run-as System.
- The CLI returned JSON with ExitCode 0.
- The VM was stopped and verified absent from the list.
- CLI version 0.8.107.0 requires an entire guest command (including parameters) as a **single** --command string, not as extra arguments after --command.

## 3. Guest network and mount audit

A trusted PowerShell audit script was mapped in as read-only input. The VM had a separate mapped writable results folder; only that folder persisted output. The script was invoked via wsb exec, because an XML LogonCommand by itself did not produce a report in the headless session.

Inside the guest, the recorded values were:

| Measurement | Observed |
|---|---|
| Active network adapters | 0 |
| IPv4 default routes | 0 |
| TCP 443 connection to 1.1.1.1 | false |
| Attempt to write into input mount | denied |
| Write to dedicated output mount | succeeded |
| Audit exceptions | none |

The measured properties support the specific offline configuration. They are not a certification that every VM-to-host escape is impossible.

## 4. Real trusted Node.js runner fixture

The predefined test had two source files: a function adding two numbers and a single built-in Node.js test. The manifest, Node binary, PowerShell guest script, config and exact source inventory were verified before execution.

- First genuine execution: the guest reported 1/1 tests passed and exit code 0, but serialized empty stderr as null; the host correctly rejected the malformed result.
- After fixing the guest harness to retain empty strings, a second genuine VM run returned a valid report.
- Successful fixture job: 7ebfce7a-523b-4782-8d9f-70fcbe54c286.
- VM for successful fixture: 068a9e5e-475e-4a2a-b90f-ac244d691a91.
- Result: passed, guest exitCode=0, 1/1 tests passed; trusted=false; requiresHumanReview=true.
- Stop verified through wsb stop followed by wsb list --raw; sandboxStopped=true and ownership journal inactive.
- Following the final ASCII TAP reporter adjustment, a third independent trusted sample also passed: job 24b929ed-6ebf-48f6-885e-1379680d0de8; guest exitCode 0, TAP 1/1 tests passed, stderr empty string, trusted=false, sandboxStopped=true, ownership journal inactive.
- No external dependencies were downloaded by the guest. No user project code or model-generated code was executed.

## 5. Corrections based on real evidence

- Remove the XML LogonCommand from the headless runner profile to prevent unreliable or duplicate execution.
- Explicitly launch a fixed bundled guest harness with wsb exec --run-as System.
- Parse the CLI acknowledgement without assuming stdout/stderr of the guest are available through WSB.
- Handle missing/empty PowerShell log files as empty JSON strings.
- Verify the VM ID disappears from the live session list before releasing the persistent owner lock. If the list response is malformed or the VM remains, fail closed.

## 6. What is still blocked

The app's browser routes and model-driven agent cannot launch VMs, execute arbitrary builds, or install dependencies. The shipped manual CLI requires both a transient opt-in and exact typed per-job consent. This evidence came from controlled, hard-coded local engineering smoke tests and does not remove that approval gate.

Production hardening still needs robust crash recovery, strict staging ACLs and ownership, multi-process scheduling, resource accounting, timeout calibration, supply-chain controls and adversarial escape testing.

Official Microsoft references:
https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/windows-sandbox-cli
https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/windows-sandbox-configure-using-wsb-file
