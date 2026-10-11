# Offline Windows Sandbox guest process supervision.
# Streams are read in small asynchronous chunks; never use ReadToEndAsync here.
# The output budget is measured while running, not truncated after collection.
function Invoke-StudioBoundedTest {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory=$true)][string]$NodeBinary,
    [Parameter(Mandatory=$true)][string]$WorkDirectory,
    [Parameter(Mandatory=$true)][string[]]$Arguments,
    [Parameter(Mandatory=$true)][int]$TimeoutMs,
    [int]$PerStreamChars = 8000,
    [int]$CombinedChars = 9000
  )

  if ($TimeoutMs -lt 100 -or $TimeoutMs -gt 120000 -or
      $PerStreamChars -lt 256 -or $PerStreamChars -gt 8000 -or
      $CombinedChars -lt $PerStreamChars -or $CombinedChars -gt 9000) {
    throw 'invalid-guest-process-bounds'
  }
  if (!(Test-Path -LiteralPath $NodeBinary -PathType Leaf) -or
      !(Test-Path -LiteralPath $WorkDirectory -PathType Container) -or
      $Arguments.Count -lt 4 -or $Arguments.Count -gt 19 -or
      $Arguments[0] -ne '--test' -or
      $Arguments[1] -ne '--test-reporter=tap' -or
      $Arguments[2] -ne '--test-concurrency=1' -or
      @($Arguments[3..($Arguments.Count - 1)] | Where-Object {
        $_ -notmatch '^[A-Za-z0-9][A-Za-z0-9._/-]*\.(test|spec)\.mjs$' -or
        $_ -match '(\.\.|node_modules|\.git|//)'
      }).Count -gt 0) {
    throw 'invalid-guest-process-arguments'
  }

  $info = [System.Diagnostics.ProcessStartInfo]::new()
  $info.FileName = $NodeBinary
  $info.Arguments = ($Arguments -join ' ')
  $info.WorkingDirectory = $WorkDirectory
  $info.UseShellExecute = $false
  $info.CreateNoWindow = $true
  $info.RedirectStandardOutput = $true
  $info.RedirectStandardError = $true
  # Avoid inheriting launcher-controlled Node flags or parent test-runner state:
  # NODE_OPTIONS can inject code, and NODE_TEST_CONTEXT suppresses nested tests.
  foreach ($name in @('NODE_OPTIONS', 'NODE_PATH', 'NODE_TEST_CONTEXT',
                       'NODE_V8_COVERAGE', 'NODE_EXTRA_CA_CERTS')) {
    [void]$info.EnvironmentVariables.Remove($name)
  }
  $process = [System.Diagnostics.Process]::new()
  $process.StartInfo = $info
  $started = $false
  $clock = [System.Diagnostics.Stopwatch]::StartNew()
  $stdout = [System.Text.StringBuilder]::new()
  $stderr = [System.Text.StringBuilder]::new()
  $bufferOut = New-Object 'Char[]' 2048
  $bufferErr = New-Object 'Char[]' 2048
  $outClosed = $false
  $errClosed = $false
  $limited = $false
  $timedOut = $false

  try {
    $started = $process.Start()
    if (!$started) { throw 'test-process-not-started' }
    $outTask = $process.StandardOutput.ReadAsync($bufferOut, 0, $bufferOut.Length)
    $errTask = $process.StandardError.ReadAsync($bufferErr, 0, $bufferErr.Length)

    while ($true) {
      if (!$outClosed -and $outTask.IsCompleted) {
        $count = $outTask.GetAwaiter().GetResult()
        if ($count -eq 0) {
          $outClosed = $true
        } else {
          if ($stdout.Length + $count -gt $PerStreamChars -or
              $stdout.Length + $stderr.Length + $count -gt $CombinedChars) {
            $limited = $true
            break
          }
          [void]$stdout.Append($bufferOut, 0, $count)
          $outTask = $process.StandardOutput.ReadAsync($bufferOut, 0, $bufferOut.Length)
        }
      }
      if (!$errClosed -and $errTask.IsCompleted) {
        $count = $errTask.GetAwaiter().GetResult()
        if ($count -eq 0) {
          $errClosed = $true
        } else {
          if ($stderr.Length + $count -gt $PerStreamChars -or
              $stdout.Length + $stderr.Length + $count -gt $CombinedChars) {
            $limited = $true
            break
          }
          [void]$stderr.Append($bufferErr, 0, $count)
          $errTask = $process.StandardError.ReadAsync($bufferErr, 0, $bufferErr.Length)
        }
      }
      if ($process.HasExited -and $outClosed -and $errClosed) { break }
      if ($clock.ElapsedMilliseconds -ge $TimeoutMs) {
        $timedOut = $true
        break
      }
      Start-Sleep -Milliseconds 15
    }

    if ($limited) {
      return [pscustomobject]@{
        status = 'error'; exitCode = -1;
        stdout = $stdout.ToString();
        stderr = 'test-output-limit-exceeded'
      }
    }
    if ($timedOut) {
      return [pscustomobject]@{
        status = 'timeout'; exitCode = -1;
        stdout = $stdout.ToString(); stderr = 'test-timeout'
      }
    }
    $exit = $process.ExitCode
    if ($null -eq $exit -or $exit -lt 0 -or $exit -gt 255) {
      throw 'unavailable-test-exit-code'
    }
    return [pscustomobject]@{
      status = $(if ($exit -eq 0) { 'passed' } else { 'failed' });
      exitCode = [int]$exit;
      stdout = $stdout.ToString();
      stderr = $stderr.ToString()
    }
  } finally {
    if ($started -and !$process.HasExited) {
      try {
        $process.Kill()
        [void]$process.WaitForExit(2500)
      } catch { }
    }
    $clock.Stop()
    $process.Dispose()
  }
}
