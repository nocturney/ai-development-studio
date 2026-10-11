# Windows Sandbox VM execution gate — v0.0.13

## Current state

The controller in src/sandbox/vm-controller.mjs now has **actual live smoke-test evidence** on Windows 11 Pro and Store Windows Sandbox CLI v0.8.107.0, alongside automated tests of failure and cancellation paths.

- The user enabled Windows Sandbox and rebooted; Studio did not alter OS security features.
- Read-only readiness works from the signed-in Chris Windows session without administrator privileges.
- The Studio localhost server runs under CHRIS\Chris with Qwen3.5 9B via local Ollama and retains previous Review state.
- The browser and model-driven Agent cannot launch a VM, execute arbitrary commands, or install dependencies.
- A separate manual CLI command remains guarded by a unique typed approval phrase and a transient opt-in.
- The first fully real test used only a trusted, hard-coded addition fixture. No model-generated or unknown code was executed.

## Manual commands

Status without changing the system:

    npm run runner:vm-readiness

Predefined offline sample (requires signed-in interactive PowerShell and exact per-run consent):

    $env:STUDIO_ALLOW_VM_EXECUTION = "1"
    npm run runner:vm-demo

The manual command stages the sample, prints its unique ID and SHA-256 manifest fingerprint, and asks the operator to type its exact approval phrase. Without typed approval or an interactive session, the command exits before launching a VM.

## Verified lifecycle

1. Deny service accounts and Session 0. Detect the user-local Store App Execution Alias (fallback: System32 only) and verify its version.
2. Diagnose the Windows Sandbox feature using Win32_OptionalFeature WMI, with DISM fallback. Unknown state fails closed.
3. Validate explicit approval, runtime staging, source checksums, guest script, guest Node binary, exact source inventory, and the XML profile.
4. Acquire an atomic per-operator VM ownership lock and write the VM ID and job ID before launch.
5. Start the exact VM with wsb start --id and offline XML config. Mount only a read-only bundle at C:\StudioInput and one dedicated writable output directory at C:\StudioResults. Disable networking, virtual GPU, clipboard and redirections.
6. Do not rely on LogonCommand. In the headless CLI it was observed not to run automatically without guest logon. Invoke the **fixed** PowerShell guest harness using wsb exec --run-as System with a single --command string.
7. Require the CLI's structured ExitCode 0 response. Read the separately written guest result.json and validate its job ID, digest, fields and size. Guest results remain trusted=false, requiresHumanReview=true, with no automatic approval.
8. On success, error, abort or timeout, request wsb stop for the exact VM ID.
9. After stopping, call wsb list --raw and require that the VM is absent before marking it stopped and releasing the ownership lock. If CLI stop or list cannot be verified, retain stop-unverified state and surface the ID for manual investigation.

## Real Windows checks (October 11, 2026)

- Real wsb start, list, exec and stop were used to create, run and destroy temporary VMs.
- A dedicated trusted audit inside a sandbox with offline XML and mapped read-only input recorded: zero active network adapters, zero IPv4 default routes, TCP 443 to 1.1.1.1 unreachable, inability to write to the input folder and successful output-folder write.
- A fixed sample Node.js test added two numbers and passed 1/1 tests within a VM. The guest report initially showed stderr:null when the error file was empty; the host correctly rejected that schema. The guest writer was fixed to retain empty strings, and the next real run passed with exitCode=0, trusted=false and sandboxStopped=true. The ownership journal was empty afterwards.
- The controller now also protects against the subtle case in which wsb stop returns success but wsb list still shows the VM. Tests preserve the lock in that case.

These checks prove the configured host integration works for the trusted sample and measured isolation properties. They **do not** prove all Sandbox escape techniques are impossible, offer a malware security certification, or enable arbitrary app project execution.

## Known limitations

- Crash/reboot during VM startup or teardown can leave an orphan. The journal will block future launches; a fully verified interactive recovery/unlock flow is not yet shipped.
- Cross-process locks protect one designated jobs folder, not multiple deliberately different folders.
- WSB memory allocation is not a calibrated per-process RAM or CPU quota.
- Guest stdout is not streamed by wsb exec; tests write bounded logs to their dedicated result file.
- A privileged host process can potentially tamper with inputs between hashing and VM launch. Production use needs stronger ownership/ACLs and input immutability guarantees.
- No user project sources, unknown dependencies or model-produced scripts have been executed in the VM.
- The app has no VM launch endpoint and no cloud provider fallback.
- No Office 2.0 code or process is changed by this work.

## Primary references

https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/windows-sandbox-cli

https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/windows-sandbox-configure-using-wsb-file

https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/windows-sandbox-sample-configuration
