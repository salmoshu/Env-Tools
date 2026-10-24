$realCodex = '__CODEX_REAL_SHIM__'
$resolver = Join-Path $PSScriptRoot 'codex-resolve.cjs'
$hasExplicitCodexHome = [Environment]::GetEnvironmentVariables().Contains('CODEX_HOME')

if (-not $hasExplicitCodexHome) {
    if (-not (Test-Path -LiteralPath $resolver -PathType Leaf)) {
        [Console]::Error.WriteLine("codex-profile: resolver not found: $resolver")
        exit 1
    }
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
        [Console]::Error.WriteLine('codex-profile: node is required but was not found')
        exit 127
    }

    $oldConsoleOutputEncoding = [Console]::OutputEncoding
    $oldOutputEncoding = $OutputEncoding
    try {
        [Console]::OutputEncoding = [Text.Encoding]::UTF8
        $OutputEncoding = [Text.Encoding]::UTF8
        $resolvedHome = & node $resolver
        $resolverExit = $LASTEXITCODE
    } finally {
        [Console]::OutputEncoding = $oldConsoleOutputEncoding
        $OutputEncoding = $oldOutputEncoding
    }
    if ($resolverExit -ne 0) { exit $resolverExit }
    if (@($resolvedHome).Count -ne 1 -or [string]::IsNullOrEmpty([string]$resolvedHome)) {
        [Console]::Error.WriteLine('codex-profile: could not resolve a Codex home')
        exit 1
    }
    $env:CODEX_HOME = [string]$resolvedHome
}

function Quote-CmdArgument([string]$value) {
    if ([string]::IsNullOrEmpty($value)) { return '""' }
    $quoted = '"'
    $backslashes = 0
    foreach ($char in $value.ToCharArray()) {
        if ($char -eq '\') {
            $backslashes++
        } elseif ($char -eq '"') {
            $quoted += ('\' * ($backslashes * 2 + 1)) + '"'
            $backslashes = 0
        } else {
            if ($backslashes -gt 0) {
                $quoted += ('\' * $backslashes)
                $backslashes = 0
            }
            $quoted += $char
        }
    }
    if ($backslashes -gt 0) { $quoted += ('\' * ($backslashes * 2)) }
    return $quoted + '"'
}

# PowerShell 5.1 会重组原生参数，直接构造 cmd 原始命令行以保留空参数和引号。
$command = '""' + $realCodex + '"'
foreach ($arg in @($args)) { $command += ' ' + (Quote-CmdArgument $arg) }
$command += '"'
$comSpec = if ($env:ComSpec) { $env:ComSpec } else { 'cmd.exe' }
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $comSpec
$psi.Arguments = '/d /v:off /c ' + $command
$psi.UseShellExecute = $false
$psi.CreateNoWindow = $false
$process = [System.Diagnostics.Process]::Start($psi)
$process.WaitForExit()
$exitCode = $process.ExitCode
$process.Dispose()
exit $exitCode
