# AI CLI 工具安装/更新 (Windows)
# 用法:
#   setup_ai_tools.ps1                  # 安装/更新全部工具
#   setup_ai_tools.ps1 --codex          # 仅 codex
#   setup_ai_tools.ps1 --kimi --codex   # 指定多个
#   setup_ai_tools.ps1 --all            # 全部工具
# 依赖 nodejs（npm），缺失时自动调用 ..\nodejs\setup_nodejs.ps1 安装。
#
# 安装方式说明（与 linux/ai-tools/setup_ai_tools.sh 行为对齐）：
#   codex / codebuddy 走 npm 全局安装（装到 npm prefix -g，通常为 %AppData%\npm），
#   多个 npm 工具合并为一次 npm install -g（npm 全局目录不能并发写，npm 内部自带并行）。
#   kimi 走官方原生安装器（irm https://code.kimi.com/kimi-code/install.ps1 | iex），
#   二进制装到 %USERPROFILE%\.kimi-code\bin（可用 KIMI_INSTALL_DIR 覆盖），与 npm 无关。
#   npm 工具与 kimi 原生安装作为两个 Job 并行执行，输出带 [npm]/[kimi] 前缀实时合流。
#   若检测到 npm 全局残留的旧 kimi 副本，安装成功后自动卸载，避免双份并存互相遮蔽。
#   每个工具处理完后校验 PATH 实际解析的命令是否来自预期目录，被其他安装源
#   （如 IDE 自带 node 工作区）遮蔽时打 WARN——"装好了但 --version 仍是旧版"根因通常在此。

[CmdletBinding()]
param(
    [switch]$All,
    [switch]$Codex,
    [switch]$Kimi,
    [switch]$Codebuddy
)

$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$logDir = Join-Path $dir 'log'
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
$log = Join-Path $logDir 'setup.log'

function Log($msg) {
    $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  $msg"
    $line | Out-File $log -Append -Encoding utf8
    Write-Host $line
}

# 让新装的 node/npm 在当前会话中立即可用
function Update-SessionPath {
    $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $user = [Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = "$machine;$user"
}

# PowerShell 5.1 默认不协商 TLS 1.2，访问 code.kimi.com 需要先启用（同官方 install.ps1）
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
# 系统代理（Clash/v2ray 等本地代理）对 code.kimi.com 会 TLS EOF，脚本内 web 请求一律直连
# （与 linux/ai-tools/usage-monitor 的约定一致：kimi 接口默认不走代理）
[System.Net.WebRequest]::DefaultWebProxy = $null

function Test-Npm {
    Update-SessionPath
    return [bool](Get-Command node -ErrorAction SilentlyContinue)
}

# 解析真实的 npm 可执行文件：优先取与 node.exe 同目录的 npm（绕过 PATH 中可能被其他
# 工具遮蔽/篡改的 npm 别名、函数或 .cmd shim——这类遮蔽会让 `npm prefix -g` 返回
# "Unknown command"、让 `npm install` 报 "Unknown command: pm"）。找不到时回退到 Get-Command。
function Get-NpmExe {
    $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
    if ($nodeCmd -and $nodeCmd.Source) {
        $nodeDir = Split-Path $nodeCmd.Source
        foreach ($cand in @('npm.cmd', 'npm.ps1', 'npm')) {
            $p = Join-Path $nodeDir $cand
            if (Test-Path $p) { return $p }
        }
    }
    $npmCmd = Get-Command npm -ErrorAction SilentlyContinue
    if ($npmCmd -and $npmCmd.Source) { return $npmCmd.Source }
    return $null
}

# prefix 是否像一个合法路径（避免出现 "Unknown command" 之类的噪声字符串被当成路径）
function Test-ValidPrefix($prefix) {
    if (-not $prefix) { return $false }
    $p = $prefix.Trim()
    if ($p -match 'unknown command') { return $false }
    return (Test-Path -IsValid $p)
}

function Get-ToolVersion($cmd) {
    try {
        return (& $cmd --version 2>$null | Select-Object -First 1)
    } catch {
        return $null
    }
}

# 安装/更新后校验 PATH 实际解析的命令是否来自预期目录。
# 被其他安装源（官方原生安装、IDE 自带 node 工作区等）遮蔽时打 WARN：
# npm 明明装好了新版，`tool --version` 却仍是旧版，根因通常就是 PATH 顺序。
function Test-CommandShadow($cmd, $expectedDir) {
    if (-not $expectedDir) { return }
    $resolved = (Get-Command $cmd -ErrorAction SilentlyContinue | Select-Object -First 1).Source
    if (-not $resolved) { return }
    $r = [IO.Path]::GetFullPath($resolved).TrimEnd('\')
    $e = [IO.Path]::GetFullPath($expectedDir).TrimEnd('\')
    if (-not $r.StartsWith($e, [StringComparison]::OrdinalIgnoreCase)) {
        Log "WARN: $cmd 实际解析到 $resolved，并非预期目录 $expectedDir；存在其他安装源遮蔽，请检查 PATH 顺序"
    }
}

# 卸载 npm 全局残留的 kimi 副本（kimi 以官方原生安装为唯一有效来源）。
# 残留判定直接看 prefix\node_modules 下的包目录，不调 npm ls（npm CLI 每次调用都是一次 node 冷启动）
function Remove-NpmKimi($npmExe, $cache, $prefix) {
    if (-not (Test-ValidPrefix $prefix)) { return }
    $pkg = '@moonshot-ai/kimi-code'
    if (-not (Test-Path (Join-Path $prefix 'node_modules\@moonshot-ai\kimi-code'))) { return }
    Log "检测到 npm 全局残留的 $pkg，卸载以避免与官方原生安装并存 ..."
    & $npmExe uninstall -g $pkg --loglevel=error --cache $cache
    if ($LASTEXITCODE -ne 0) {
        Log "WARN: npm 版 kimi 卸载失败 (exit=$LASTEXITCODE)，可手动执行: npm uninstall -g $pkg"
    } else {
        Log 'npm 版 kimi 已卸载'
    }
}

# kimi 官方安装器的安装位置与二进制路径（与 install.ps1 的默认保持一致）
$kimiInstallDir = if ($env:KIMI_INSTALL_DIR) { $env:KIMI_INSTALL_DIR } else { Join-Path $env:USERPROFILE '.kimi-code' }
$kimiBin = Join-Path $kimiInstallDir 'bin\kimi.exe'

# --- npm 工具线程：版本查询 + 合并安装（Job 内无法访问主线程函数， helpers 内置）------
$npmWorker = {
    param([string[]]$names, [string]$npmCache, [string]$npmPrefix, [string]$npmExe)
    $ErrorActionPreference = 'Continue'
    $pkgOf = @{ codex = '@openai/codex'; codebuddy = '@tencent-ai/codebuddy-code' }
    # 默认源失败时回退的国内 npm 镜像
    $npmMirror = 'https://registry.npmmirror.com'

    # 从 --version 输出中提取 x.y.z（各 CLI 输出格式不一，如 "codex-cli 0.25.0"）
    function Get-Semver($text) {
        if ($text -match '(\d+\.\d+\.\d+)') { return $Matches[1] }
        return $null
    }

    # 当前版本只看 npm prefix 下的 shim（<cmd>.cmd --version）：直达 npm 安装目录，
    # 免疫 PATH 遮蔽（IDE 自带 node 工作区等），shim 不存在即视为未安装。
    # 不调 npm ls -g —— npm CLI 每次调用都是一次 node 冷启动，串行多次调用很慢
    function Get-LocalVersion($cmd, $prefix) {
        if (-not $prefix) { return $null }
        $shim = Join-Path $prefix "$cmd.cmd"
        if (-not (Test-Path $shim)) { return $null }
        return & $shim --version 2>$null | Select-Object -First 1
    }

    $install = @()
    $installNames = @()
    $beforeMap = @{}
    foreach ($name in $names) {
        $pkg = $pkgOf[$name]
        $before = Get-LocalVersion $name $npmPrefix
        $beforeMap[$name] = if ($before) { $before } else { '未安装' }
        $localVer = Get-Semver $before
        "查询 $name 最新版本 ($pkg) ..."
        $latest = ((& $npmExe view $pkg version --loglevel=error --cache $npmCache 2>$null | Select-Object -Last 1) -replace '\s', '')
        if (-not $latest) {
            # 默认源查询失败，回退国内镜像
            $latest = ((& $npmExe view $pkg version --loglevel=error --cache $npmCache --registry $npmMirror 2>$null | Select-Object -Last 1) -replace '\s', '')
            if ($latest) { "默认源查询失败，已改用国内镜像 ($npmMirror)" }
        }
        if ($localVer -and $latest -and ($localVer -eq $latest)) {
            "$name 已是最新 ($localVer)，跳过安装"
            "RESULT|$name|OK"
        } else {
            $install += "$pkg@latest"
            $installNames += $name
        }
    }
    if ($install.Count -eq 0) { return }

    # npm 全局目录不能安全地由多个 npm 进程同时写入，多个包合并为一次 install
    "安装/更新 $($installNames -join '、'): npm install -g $($install -join ' ')"
    & $npmExe install -g --loglevel=error --cache $npmCache $install
    if ($LASTEXITCODE -ne 0) {
        "默认源安装失败 (npm exit=$LASTEXITCODE)，改用国内镜像重试: $npmMirror"
        & $npmExe install -g --loglevel=error --cache $npmCache --registry $npmMirror $install
    }
    if ($LASTEXITCODE -ne 0) {
        foreach ($name in $installNames) {
            "ERROR: $name 安装失败 (npm exit=$LASTEXITCODE)"
            "RESULT|$name|FAIL"
        }
        return
    }
    foreach ($name in $installNames) {
        $after = Get-LocalVersion $name $npmPrefix
        $afterText = if ($after) { $after } else { '未知' }
        "$name 完成: $($beforeMap[$name]) -> $afterText"
        "RESULT|$name|OK"
    }
}

# --- kimi 线程：官方原生安装器 -------------------------------------------------------
$kimiWorker = {
    param([string]$kimiBin)
    $ErrorActionPreference = 'Continue'
    # Job 是全新 PowerShell 进程，需同样启用 TLS 1.2 并绕开系统代理（本地代理会 TLS EOF）
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    [System.Net.WebRequest]::DefaultWebProxy = $null

    function Get-Semver($text) {
        if ($text -match '(\d+\.\d+\.\d+)') { return $Matches[1] }
        return $null
    }

    # kimi 版本以原生二进制为准（PATH 上的 kimi 可能被其他来源遮蔽）
    function Get-KimiVersion {
        if (Test-Path $kimiBin) {
            $v = & $kimiBin --version 2>$null | Select-Object -First 1
            if ($v) { return $v }
        }
        if (Get-Command kimi -ErrorAction SilentlyContinue) {
            return & kimi --version 2>$null | Select-Object -First 1
        }
        return $null
    }

    # kimi 官方 CDN 上的最新版本；查询失败返回空，按"需要安装"兜底
    function Get-LatestKimiVersion {
        try {
            $v = (Invoke-WebRequest -Uri 'https://code.kimi.com/kimi-code/latest' -UseBasicParsing).Content
            # CDN 未显式声明 text content-type 时 PS 可能返回 byte[]
            if ($v -is [byte[]]) { $v = [System.Text.Encoding]::UTF8.GetString($v) }
            $v = $v.Trim()
            if ($v) { return $v }
            return $null
        } catch {
            return $null
        }
    }

    $before = Get-KimiVersion
    $beforeText = if ($before) { $before } else { '未安装' }
    $localVer = Get-Semver $before
    '查询 kimi 最新版本 (code.kimi.com) ...'
    $latest = Get-LatestKimiVersion
    if ($localVer -and $latest -and ($localVer -eq $latest)) {
        "kimi 已是最新 ($localVer)，跳过安装"
        'RESULT|kimi|OK'
        return
    }
    "安装/更新 kimi (官方安装器 install.ps1)，当前版本: $beforeText"
    # 子进程是全新 PowerShell 会话，需同样启用 TLS 1.2 并绕开系统代理
    & powershell -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12; [System.Net.WebRequest]::DefaultWebProxy = `$null; irm https://code.kimi.com/kimi-code/install.ps1 | iex"
    if ($LASTEXITCODE -ne 0) {
        "ERROR: kimi 安装失败 (install.ps1 exit=$LASTEXITCODE)"
        'RESULT|kimi|FAIL'
        return
    }
    $after = Get-KimiVersion
    $afterText = if ($after) { $after } else { '未知' }
    "kimi 完成: $beforeText -> $afterText"
    'RESULT|kimi|OK'
}

# 主线程轮询 Job 输出：普通行加 [tag] 前缀写入日志（带时间戳），RESULT 行只用于成败统计
function Receive-WorkerOutput($worker) {
    foreach ($line in (Receive-Job $worker.Job)) {
        if ($line -is [string] -and $line.StartsWith('RESULT|')) {
            $parts = $line.Substring(7) -split '\|'
            $worker.Results[$parts[0]] = $parts[1]
        } elseif ($line -is [System.Management.Automation.ErrorRecord]) {
            Log "[$($worker.Tag)] $($line.Exception.Message)"
        } elseif ($line) {
            Log "[$($worker.Tag)] $line"
        }
    }
}

$tools = [ordered]@{
    codex     = @{ Command = 'codex';     Method = 'npm' }
    kimi      = @{ Command = 'kimi';      Method = 'native' }
    codebuddy = @{ Command = 'codebuddy'; Method = 'npm' }
}

$targets = @()
if ($Codex)     { $targets += 'codex' }
if ($Kimi)      { $targets += 'kimi' }
if ($Codebuddy) { $targets += 'codebuddy' }
if ($All -or $targets.Count -eq 0) { $targets = @($tools.Keys) }

Log "=== ai-tools setup start (targets: $($targets -join ', ')) ==="

# --- 依赖：nodejs / npm -------------------------------------------------------
if (-not (Test-Npm)) {
    Log '未检测到 node/npm，先部署 nodejs ...'
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $dir '..\nodejs\setup_nodejs.ps1')
    if ($LASTEXITCODE -ne 0) {
        Log "ERROR: nodejs 部署失败 (exit=$LASTEXITCODE)"
        exit 1
    }
    if (-not (Test-Npm)) {
        Log 'ERROR: nodejs 部署后仍无法找到 npm'
        exit 1
    }
}
Log "npm 就绪: $(Get-ToolVersion 'node') (node)"

# 解析真实 npm（绕过 PATH 中可能被遮蔽/篡改的 npm 别名或 shim）
$npmExe = Get-NpmExe
if (-not $npmExe) {
    Log 'ERROR: 找不到可用的 npm（node 已就绪但 npm 不在预期位置）'
    exit 1
}
Log "npm 路径: $npmExe ($(& $npmExe --version 2>$null | Select-Object -First 1))"

# --- 并行安装/更新 ------------------------------------------------------------------
# 脚本的 npm 下载（view 元数据 + install 包）全部放进独立临时缓存，结束后删除，
# 不污染用户的全局 npm 缓存（%LocalAppData%\npm-cache）
$npmCache = Join-Path $env:TEMP ("ai-tools-npm-cache-" + [guid]::NewGuid().ToString('N'))
$npmPrefix = (& $npmExe prefix -g 2>$null | Select-Object -First 1)
if ($npmPrefix) { $npmPrefix = $npmPrefix.Trim() }
if (-not (Test-ValidPrefix $npmPrefix)) {
    Log "ERROR: 无法获取有效的 npm prefix（npm prefix -g 返回: '$npmPrefix'）。请确认 npm 本身可正常运行：`npx prefix -g`"
    exit 1
}

$npmNames = @($targets | Where-Object { $tools[$_].Method -eq 'npm' })
$kimiTarget = @($targets | Where-Object { $_ -eq 'kimi' }).Count -gt 0

$workers = @()
try {
    if ($npmNames.Count -gt 0) {
        $workers += @{ Tag = 'npm'; Tools = $npmNames; Results = @{}; Job = (Start-Job $npmWorker -ArgumentList (,$npmNames), $npmCache, $npmPrefix, $npmExe) }
    }
    if ($kimiTarget) {
        $workers += @{ Tag = 'kimi'; Tools = @('kimi'); Results = @{}; Job = (Start-Job $kimiWorker -ArgumentList $kimiBin) }
    }

    while (@($workers | Where-Object { $_.Job.State -eq 'Running' }).Count -gt 0) {
        foreach ($w in $workers) { Receive-WorkerOutput $w }
        Start-Sleep -Milliseconds 300
    }
    foreach ($w in $workers) {
        Receive-WorkerOutput $w  # 收尾排空残余输出
        if ($w.Job.State -ne 'Completed') {
            Log "ERROR: [$($w.Tag)] 线程异常结束 (State=$($w.Job.State))"
            foreach ($name in $w.Tools) {
                if (-not $w.Results.Contains($name)) { $w.Results[$name] = 'FAIL' }
            }
        }
        Remove-Job $w.Job
    }

    # 原生安装就绪后，清理 npm 全局残留的旧 kimi 副本，避免双份并存
    if ($kimiTarget -and (Test-Path $kimiBin)) { Remove-NpmKimi $npmExe $npmCache $npmPrefix }

    Update-SessionPath
    foreach ($name in $targets) {
        $expected = if ($name -eq 'kimi') { Split-Path -Parent $kimiBin } else { $npmPrefix }
        Test-CommandShadow $tools[$name].Command $expected
    }

    $failed = @()
    foreach ($w in $workers) {
        foreach ($name in $w.Tools) {
            if ($w.Results[$name] -ne 'OK') { $failed += $name }
        }
    }
    if ($failed.Count -gt 0) {
        Log "=== ai-tools setup done，失败: $($failed -join ', ') ==="
        exit 1
    }
    Log '=== ai-tools setup done ==='
} finally {
    Remove-Item $npmCache -Recurse -Force -ErrorAction SilentlyContinue
}
