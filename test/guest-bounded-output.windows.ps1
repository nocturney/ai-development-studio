# Trusted local regression test: no Windows Sandbox or user project access.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\src\sandbox\guest-bounded-process.ps1')
$runtime = 'C:\Program Files\nodejs\node.exe'
$folder = Join-Path $env:TEMP ('studio-guest-output-' + [guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path $folder -ErrorAction Stop | Out-Null
function Invoke-Case([string]$name, [string]$source, [int]$timeout) {
  $file = $name + '.test.mjs'
  [IO.File]::WriteAllText((Join-Path $folder $file), $source, [Text.UTF8Encoding]::new($false))
  return Invoke-StudioBoundedTest -NodeBinary $runtime -WorkDirectory $folder -Arguments @('--test', '--test-reporter=tap', '--test-concurrency=1', $file) -TimeoutMs $timeout
}
try {
  $priorOptions = $env:NODE_OPTIONS
  try {
    # The helper must scrub launcher-controlled Node options before execution.
    $env:NODE_OPTIONS = '--require=studio-fixture-must-not-be-loaded'
    $pass = Invoke-Case 'passing' 'import test from "node:test"; import assert from "node:assert/strict"; test("sum",()=>assert.equal(2+3,5));' 8000
  } finally {
    $env:NODE_OPTIONS = $priorOptions
  }
  if ($pass.status -ne 'passed' -or $pass.exitCode -ne 0 -or $pass.stdout -notmatch '# pass 1') { throw ('passing-test-failed:'+($pass | ConvertTo-Json -Compress)) }
  $fail = Invoke-Case 'failing' 'import test from "node:test"; import assert from "node:assert/strict"; test("sum",()=>assert.equal(2+3,6));' 8000
  if ($fail.status -ne 'failed' -or $fail.exitCode -ne 1 -or $fail.stdout -notmatch '# fail 1') { throw 'failing-test-not-detected' }
  $flood = Invoke-Case 'floodout' 'import test from "node:test"; test("emit",()=>process.stdout.write("X".repeat(250000)));' 8000
  if ($flood.status -ne 'error' -or $flood.exitCode -ne -1 -or $flood.stderr -ne 'test-output-limit-exceeded' -or $flood.stdout.Length -gt 8000) { throw 'unbounded-stdout' }
  $floodErr = Invoke-Case 'flooderr' 'import test from "node:test"; test("emit",()=>process.stderr.write("Y".repeat(250000)));' 8000
  if ($floodErr.status -ne 'error' -or $floodErr.exitCode -ne -1 -or $floodErr.stderr -ne 'test-output-limit-exceeded') { throw 'unbounded-stderr' }
  $timeout = Invoke-Case 'waiting' 'import test from "node:test"; test("slow",async()=>{await new Promise(r=>setTimeout(r,3000));});' 350
  if ($timeout.status -ne 'timeout' -or $timeout.exitCode -ne -1) { throw 'timeout-did-not-kill-test' }
  $caught = $false
  try {
    Invoke-StudioBoundedTest -NodeBinary $runtime -WorkDirectory $folder -Arguments @('--test', '--test-reporter=tap', '--test-concurrency=1', '../bad.test.mjs') -TimeoutMs 1000 | Out-Null
  } catch {
    if ($_.Exception.Message -eq 'invalid-guest-process-arguments') { $caught = $true }
  }
  if (!$caught) { throw 'traversal-did-not-fail' }
  Write-Output (ConvertTo-Json -Compress @{
    passed = $true; positive = $pass.status; negative = $fail.status;
    overflowStdout = $flood.status; overflowStderr = $floodErr.status;
    timeout = $timeout.status; traversalRejected = $caught;
    stdoutCaptured = $flood.stdout.Length; stderrCaptured = $floodErr.stdout.Length
  })
} finally {
  Remove-Item -LiteralPath $folder -Force -Recurse -ErrorAction SilentlyContinue
}
