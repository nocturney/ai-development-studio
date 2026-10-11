# Studio offline runner contract — v0.0.15

**Status: actual Windows Sandbox lifecycle, guest isolation probe, and trusted Node test fixture verified. Arbitrary project-code execution remains disabled in the app.**

## Contract

- src/sandbox/offline-runner.mjs accepts limited source types and explicitly listed .test.mjs or .spec.mjs entry points only. The app does not accept unrestricted shell commands or dependencies.
- Each staged package has a SHA-256 manifest with bounded input files, explicit timeout of 5–120 seconds, VM memory setting of 4096–16384 MB and network disabled.
- The bundle contains the guest script, a pinned input manifest, the Node executable and allowlisted static source/test files. It is mounted at C:\StudioInput with ReadOnly=true.
- The sole writable host mapping is a dedicated per-job empty output directory at C:\StudioResults. The guest performs tests in disposable local VM temporary storage.
- The .wsb XML profile disables network, vGPU, clipboard, microphone, video and printer redirection; enables ProtectedClient. It deliberately contains **no LogonCommand**, since that command is not reliably executed in a headless Sandbox before login.
- After verified preflight and explicit manual per-job approval, vm-controller.mjs uses wsb start with a sealed XML config, then wsb exec with a **fixed hard-coded PowerShell guest-runner command** running as System. No source paths or model outputs are interpolated into this command.
- The controller requires an ExitCode 0 CLI response, then independently validates the guest's result.json. Guest reports can never approve source code automatically and are always trusted=false with requiresHumanReview=true.
- On every result, error, cancellation or timeout, wsb stop is attempted. The controller then verifies the VM's exact ID is absent from wsb list --raw before releasing the ownership journal. An ambiguous stop leaves the journal locked.
- Empty PowerShell output files must serialize as JSON strings, never null. The guest Node test reporter uses ASCII TAP to improve log portability.

## Validated on Windows (October 11, 2026)

- Microsoft Store Windows Sandbox CLI v0.8.107.0 detected from the signed-in Windows user.
- Actual CLI start, exec, stop and list worked; the VM was removed from the list.
- In the guest, a trusted probe observed 0 active adapters, 0 default IPv4 routes, outbound TCP to 1.1.1.1:443 unavailable, read-only input-folder write refused, and dedicated output-folder write succeeded.
- A hard-coded add(2,3) Node test was staged with file/runtime hashes, executed inside a real VM via wsb exec, and reported passed, exitCode=0, trusted=false, requiresHumanReview=true; 1/1 tests passed. The first attempt exposed a null-versus-empty stderr schema bug, fixed and successfully retested.
- Automated tests exercise tamper rejects, guest command parsing, stop/list failure, ownership journaling, cancellation and deadlines. Automated tests themselves do not launch VMs.

## Limits

- Only the manual CLI supports launching the predefined sample. The Studio HTTP server and two-file agent have **no VM execution endpoint**.
- The VM output report remains untrusted and cannot approve changes.
- Single-directory journal locking does not solve all privileged host tampering, process race or supply-chain risks.
- MemoryInMB is not a calibrated per-process memory/CPU quota. No CPU limits, dependency installation, malicious breakout resistance or production security audit have been proven.
- Microsoft documents that wsb exec does not stream guest stdout/stderr; reports are written to the isolated output mapping.
- There is no automatic VM orphan recovery or journal removal after uncertain stop.
- The manually approved CLI must exit with a nonzero process code for guest `failed`, `timeout` or `error` outcomes, even if teardown succeeds. This classifies test results only; guest reports remain untrusted and never approve code.
- No Office 2.0 dependency, cloud model fallback, model-generated shell execution or paid agent runtime was added.

## Operator commands

Read-only: npm run runner:vm-readiness

Future manual demo: set STUDIO_ALLOW_VM_EXECUTION=1 in the interactive Windows desktop PowerShell, run npm run runner:vm-demo, and type the exact approval phrase displayed for that particular job.

## References

- https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/windows-sandbox-cli
- https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/windows-sandbox-configure-using-wsb-file


## v0.0.15 bounded guest output — implementation and evidence

The prior guest harness used .NET ReadToEndAsync for both Node pipes, then
truncated the captured result after process exit. A noisy test could therefore
allocate excessive guest memory before truncation; truncation after completion
was not a resource limit.

The guest now sources a dedicated trusted helper, guest-bounded-process.ps1,
from the read-only bundle. Host preflight compares the complete helper contents
to the trusted source file, validates the exact top-level bundle inventory
and rejects added or modified files before any VM launch.

The helper reads both output streams concurrently through 2,048-character
asynchronous buffers, without ReadToEndAsync or unbounded accumulation.
It enforces a maximum of 8,000 captured UTF-16 characters per stream and
9,000 combined. Reaching either limit terminates the test and reports
status=error, exitCode=-1, stderr=test-output-limit-exceeded.
A separate bounded timeout terminates the process and reports timeout.
The returned log strings are bounded before serialization. The max combined
length also bounds the worst-case JSON escape expansion to fit the 70 KB
host result-file allowance.

The helper strips inherited NODE_OPTIONS, NODE_PATH, NODE_TEST_CONTEXT,
NODE_V8_COVERAGE and NODE_EXTRA_CA_CERTS before starting Node, avoiding
unwanted runtime flags and nested Node test-runner suppression.

Verified on Windows:
- 129/129 complete automated tests, including the real bounded PowerShell
  process tests: passing test, failing assertion, oversized stdout,
  oversized stderr, timeout and traversal rejection.
- Three successive actual Windows Sandbox VMs using the new sealed bundle:
  pass => guest passed, exitCode 0, manual CLI 0;
  deliberately failing assertion => failed, exitCode 1, manual CLI 2;
  deliberate output flood => error, exitCode -1, manual CLI 2, and the
  explicit test-output-limit-exceeded marker.
- All three VMs were stopped and confirmed absent via WSB list. No active
  ownership journal remains. No user project or AI-generated code ran.
- Driver JSON, guest JSON, manifests and the trusted fixture are preserved
  in the separate host evidence archive under
  D:\Velvet\Services\AIStudio\logs\vm-validation-20261011\bounded-output-v015.

Limits: Character-based output budgeting is a memory/output guard, not a
per-process CPU, system memory, I/O, disk or detached-descendant quota.
The whole VM remains the isolation and final teardown boundary. This
does not authorize untrusted user-project execution.
