# Studio offline runner guest harness. Only for Windows Sandbox.
$ErrorActionPreference = 'Stop'
$inputRoot = 'C:\StudioInput'
$outputRoot = 'C:\StudioResults'
$clock = [System.Diagnostics.Stopwatch]::StartNew()
$report = @{
  schema = 'studio.runner.v1'
  id = ''
  manifestHash = ''
  status = 'error'
  exitCode = -1
  elapsedMs = 0
  stdout = ''
  stderr = ''
}
$workDir = ''
try {
  $job = Get-Content -LiteralPath (Join-Path $inputRoot 'job.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($job.schema -ne 'studio.runner.v1' -or $job.kind -ne 'node-offline-tests' -or
      [string]$job.id -notmatch '^[0-9a-f-]{36}$' -or [string]$job.manifestHash -notmatch '^[0-9a-f]{64}$') {
    throw 'invalid-job-manifest'
  }
  $report.id = [string]$job.id
  $report.manifestHash = [string]$job.manifestHash
  if ([int]$job.timeoutSeconds -lt 5 -or [int]$job.timeoutSeconds -gt 120) {
    throw 'invalid-timeout'
  }
  if (!$job.tests -or $job.tests.Count -gt 16) { throw 'invalid-tests' }
  foreach ($test in $job.tests) {
    if ([string]$test -notmatch '^[A-Za-z0-9][A-Za-z0-9._/-]*\.(test|spec)\.mjs$' -or
        [string]$test -match '(\.\.|node_modules|\.git|//)') {
      throw 'invalid-test-path'
    }
  }
  $runtimePath = Join-Path $inputRoot 'node.exe'
  if (!(Test-Path -LiteralPath $runtimePath -PathType Leaf)) { throw 'node-runtime-not-packaged' }
  $workDir = Join-Path $env:TEMP ('studio-' + $job.id)
  New-Item -ItemType Directory -Path $workDir -ErrorAction Stop | Out-Null
  $srcDir = Join-Path $inputRoot 'source'
  Get-ChildItem -LiteralPath $srcDir -Force | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination $workDir -Recurse -Force
  }
  foreach ($file in $job.files) {
    $relative = [string]$file.name
    if ($relative -notmatch '^[A-Za-z0-9][A-Za-z0-9._/-]*$' -or $relative -match '(\.\.|node_modules|\.git|//)') {
      throw 'invalid-file-path'
    }
    $full = Join-Path $workDir $relative.Replace('/', '\')
    if (!(Test-Path -LiteralPath $full -PathType Leaf)) { throw 'input-file-missing' }
    $actualSha = (Get-FileHash -LiteralPath $full -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualSha -ne [string]$file.sha256) { throw 'input-file-integrity-failed' }
  }
  foreach ($test in $job.tests) {
    $full = Join-Path $workDir ([string]$test).Replace('/', '\')
    if (!(Test-Path -LiteralPath $full -PathType Leaf)) { throw 'test-not-found' }
  }
  $stdoutPath = Join-Path $env:TEMP ('studio-out-' + $job.id + '.txt')
  $stderrPath = Join-Path $env:TEMP ('studio-err-' + $job.id + '.txt')
  $testNames = @($job.tests | ForEach-Object { [string]$_ })
  $arguments = @('--test', '--test-reporter=tap', '--test-concurrency=1') + $testNames
  $process = Start-Process -FilePath $runtimePath -ArgumentList $arguments -WorkingDirectory $workDir -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath -WindowStyle Hidden -PassThru
  try {
    Wait-Process -Id $process.Id -Timeout ([int]$job.timeoutSeconds) -ErrorAction Stop
    $process.Refresh()
    $report.exitCode = [int]$process.ExitCode
    $report.status = if ($report.exitCode -eq 0) { 'passed' } else { 'failed' }
  } catch {
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    $report.status = 'timeout'
    $report.exitCode = -1
  }
  if (Test-Path -LiteralPath $stdoutPath) {
    $value = Get-Content -LiteralPath $stdoutPath -Raw -Encoding UTF8
    if ($null -ne $value) {
      $report.stdout = [string]$value
      if ($report.stdout.Length -gt 30000) { $report.stdout = $report.stdout.Substring(0, 30000) }
    }
  }
  if (Test-Path -LiteralPath $stderrPath) {
    $value = Get-Content -LiteralPath $stderrPath -Raw -Encoding UTF8
    if ($null -ne $value) {
      $report.stderr = [string]$value
      if ($report.stderr.Length -gt 30000) { $report.stderr = $report.stderr.Substring(0, 30000) }
    }
  }
} catch {
  $report.status = 'error'
  $report.exitCode = -1
  $report.stderr = [string]$_.Exception.Message
} finally {
  $clock.Stop()
  $report.elapsedMs = [int][Math]::Min($clock.ElapsedMilliseconds, [int]::MaxValue)
  if (!(Test-Path -LiteralPath $outputRoot -PathType Container)) { exit 2 }
  $target = Join-Path $outputRoot 'result.json'
  $temporary = Join-Path $outputRoot 'result.part.json'
  $json = $report | ConvertTo-Json -Depth 6 -Compress
  [System.IO.File]::WriteAllText($temporary, $json, [System.Text.UTF8Encoding]::new($false))
  Move-Item -LiteralPath $temporary -Destination $target -Force
  if ($workDir -and (Test-Path -LiteralPath $workDir)) {
    Remove-Item -LiteralPath $workDir -Force -Recurse -ErrorAction SilentlyContinue
  }
}
