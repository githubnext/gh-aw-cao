package hostedcli

// System is the documented headless wsb exec context. ExistingLogin needs an
// RDP session and is deliberately not used. The workload runs as System inside
// the disposable VM; this profile does not claim an additional restricted-user
// boundary. Host isolation is the VM plus the two narrowly scoped mappings.
//
// This is the only interpreted source. Invocation values are never injected
// into PowerShell source or cmd.exe. ProcessStartInfo on Windows PowerShell 5.1
// lacks ArgumentList, so Quote-NativeArgument implements Windows argv quoting.
const windowsSandboxBootstrap = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Set-StrictMode -Version Latest

function Quote-NativeArgument([string] $value) {
    $text = [System.Text.StringBuilder]::new()
    [void] $text.Append('"')
    $slashes = 0
    foreach ($character in $value.ToCharArray()) {
        if ($character -eq '\') { $slashes++; continue }
        if ($character -eq '"') {
            [void] $text.Append(('\' * ($slashes * 2 + 1)))
        } else {
            [void] $text.Append(('\' * $slashes))
        }
        [void] $text.Append($character)
        $slashes = 0
    }
    [void] $text.Append(('\' * ($slashes * 2)))
    [void] $text.Append('"')
    return $text.ToString()
}

function Invoke-NativeTool([string] $program, [string[]] $arguments, $invocation, $stdout, $stderr) {
    $start = [System.Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $program
    $quoted = foreach ($argument in $arguments) { Quote-NativeArgument $argument }
    $start.Arguments = $quoted -join ' '
    $start.WorkingDirectory = $invocation.directory
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $start.RedirectStandardInput = $true
    $start.EnvironmentVariables.Clear()
    foreach ($entry in $invocation.env.PSObject.Properties) {
        $start.EnvironmentVariables[$entry.Name] = [string] $entry.Value
    }
    $start.EnvironmentVariables['SystemRoot'] = 'C:\Windows'
    $start.EnvironmentVariables['WINDIR'] = 'C:\Windows'
    $start.EnvironmentVariables['COMSPEC'] = 'C:\Windows\System32\cmd.exe'
    $start.EnvironmentVariables['PATH'] = 'C:\cao-tools\gh;C:\cao-tools\gh-aw;C:\cao-tools\git\cmd;C:\cao-tools\git\usr\bin;C:\Windows\System32;C:\Windows'
    $start.EnvironmentVariables['USERPROFILE'] = 'C:\cao-workspace\home'
    $start.EnvironmentVariables['APPDATA'] = 'C:\cao-workspace\home\AppData\Roaming'
    $start.EnvironmentVariables['LOCALAPPDATA'] = 'C:\cao-workspace\home\AppData\Local'
    $start.EnvironmentVariables['TEMP'] = 'C:\cao-workspace\home\.tmp'
    $start.EnvironmentVariables['TMP'] = 'C:\cao-workspace\home\.tmp'
    $start.EnvironmentVariables['GH_CONFIG_DIR'] = 'C:\cao-workspace\home\.config\gh'
    $start.EnvironmentVariables['GIT_CONFIG_NOSYSTEM'] = '1'
    $start.EnvironmentVariables['GIT_CONFIG_SYSTEM'] = 'NUL'
    $start.EnvironmentVariables['GIT_TERMINAL_PROMPT'] = '0'
    $start.EnvironmentVariables['GH_PROMPT_DISABLED'] = '1'
    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $start
    try {
        if (-not $process.Start()) { throw 'Native tool could not start' }
        $process.StandardInput.Close()
        $outTask = $process.StandardOutput.BaseStream.CopyToAsync($stdout)
        $errTask = $process.StandardError.BaseStream.CopyToAsync($stderr)
        $process.WaitForExit()
        $outTask.GetAwaiter().GetResult()
        $errTask.GetAwaiter().GetResult()
        return $process.ExitCode
    } finally {
        $process.Dispose()
    }
}

try {
    $invocation = [IO.File]::ReadAllText('C:\cao-input\invocation.json', [Text.Encoding]::UTF8) | ConvertFrom-Json
    if ($invocation.sha256 -cnotmatch '^[a-f0-9]{64}$') { throw 'Invalid digest' }
    $actual = (Get-FileHash -LiteralPath 'C:\cao-input\tools.zip' -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -cne $invocation.sha256) { throw 'Native tools digest mismatch' }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::ExtractToDirectory('C:\cao-input\tools.zip', 'C:\cao-tools')
    $program = switch -Exact ($invocation.program) {
        'gh' { 'C:\cao-tools\gh\gh.exe' }
        'gh-aw' { 'C:\cao-tools\gh-aw\gh-aw.exe' }
        default { throw 'Unsupported native executable' }
    }
    foreach ($directory in @(
        'C:\cao-workspace\home\.tmp', 'C:\cao-workspace\home\.config\gh',
        'C:\cao-workspace\home\AppData\Roaming', 'C:\cao-workspace\home\AppData\Local',
        'C:\cao-workspace\data'
    )) { [void] [IO.Directory]::CreateDirectory($directory) }
    $stdout = [IO.File]::Open('C:\cao-workspace\.cao-output\stdout', [IO.FileMode]::Open, [IO.FileAccess]::Write, [IO.FileShare]::ReadWrite)
    $stderr = [IO.File]::Open('C:\cao-workspace\.cao-output\stderr', [IO.FileMode]::Open, [IO.FileAccess]::Write, [IO.FileShare]::ReadWrite)
    try {
        $initCode = Invoke-NativeTool 'C:\cao-tools\git\cmd\git.exe' @('-c', 'init.defaultBranch=main', 'init', '--quiet', '--template=', '.') $invocation $stdout $stderr
        if ($initCode -ne 0) { throw 'Git root initialization failed' }
        $code = Invoke-NativeTool $program @($invocation.args) $invocation $stdout $stderr
        if ($code -lt 0 -or $code -gt 255) { throw 'Workload exit code is outside the supported range' }
        $stdout.Flush($true)
        $stderr.Flush($true)
    } finally {
        $stdout.Dispose()
        $stderr.Dispose()
    }
    $receipt = @{ execution = $invocation.execution; exitCode = $code } | ConvertTo-Json -Depth 4 -Compress
    if ($receipt.Length -gt 1024) { throw 'Invalid exit evidence' }
    [IO.File]::WriteAllText('C:\cao-workspace\.cao-output\result.next', $receipt, [Text.UTF8Encoding]::new($false))
    [IO.File]::Move('C:\cao-workspace\.cao-output\result.next', 'C:\cao-workspace\.cao-output\result.json')
    exit 0
} catch {
    # Do not expose exception messages, invocation JSON, or environment values.
    # A bootstrap failure has no workload exit receipt.
    exit 1
}
`
