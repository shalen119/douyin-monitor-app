$ErrorActionPreference = 'Stop'
$appRoot = $PSScriptRoot
$runtimeRoot = Join-Path $appRoot '.runtime'

function Test-PortOpen([int]$port) {
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $pending = $client.BeginConnect('127.0.0.1', $port, $null, $null)
        if (-not $pending.AsyncWaitHandle.WaitOne(500)) { return $false }
        $client.EndConnect($pending)
        return $true
    } catch { return $false }
    finally { $client.Close() }
}

try {
    $port = if ($env:PORT) { [int]$env:PORT } else { 4318 }
    if ($port -lt 1 -or $port -gt 65535) { throw '端口号须为 1–65535。' }
    $url = "http://127.0.0.1:$port/"
    if (Test-PortOpen $port) {
        try { $state = Invoke-RestMethod -Uri "${url}api/state" -TimeoutSec 3 }
        catch { throw "端口 $port 已被其他程序占用。请关闭占用程序后重试。" }
        if ($null -eq $state.runtime -or $null -eq $state.videos) {
            throw "端口 $port 已被其他程序占用。请关闭占用程序后重试。"
        }
        Start-Process -FilePath $url
        Write-Host "监测服务已在运行，已打开 $url"
        exit 0
    }

    $node = $null
    if (Test-Path -LiteralPath $runtimeRoot) {
        $node = Get-ChildItem -LiteralPath $runtimeRoot -Filter node.exe -File -Recurse |
            Where-Object { $_.Directory.Name -like 'node-v*-win-*' } |
            Select-Object -First 1 -ExpandProperty FullName
    }
    if (-not $node) {
        $candidate = Get-Command node.exe -ErrorAction SilentlyContinue
        if ($candidate) { $node = $candidate.Source }
    }
    if (-not $node) { throw '未找到 Node.js。请先双击“双击安装环境.cmd”。' }
    $version = (& $node --version).Trim()
    if ([version]($version.TrimStart('v')) -lt [version]'24.0.0') { throw ('Node.js ' + $version + ' 版本过低。请先双击 双击安装环境.cmd。') }
    if (-not (Test-Path -LiteralPath (Join-Path $appRoot 'node_modules\playwright-core'))) {
        throw '项目依赖尚未安装。请先双击“双击安装环境.cmd”。'
    }
    $serverProcess = $null
    try {
        Write-Host '监测服务启动中。运行期间请保持本窗口打开。'
        $serverProcess = Start-Process -FilePath $node -ArgumentList 'src/server.js' -WorkingDirectory $appRoot -NoNewWindow -PassThru
        $ready = $false
        for ($attempt = 0; $attempt -lt 60; $attempt++) {
            if ($serverProcess.HasExited) { throw "监测服务提前退出，代码 $($serverProcess.ExitCode)。" }
            try {
                $state = Invoke-RestMethod -Uri "${url}api/state" -TimeoutSec 2
                if ($null -ne $state.runtime -and $null -ne $state.videos) { $ready = $true; break }
            } catch { }
            Start-Sleep -Milliseconds 250
        }
        if (-not $ready) { throw "监测服务未能在 15 秒内启动。请检查端口 $port。" }
        Start-Process -FilePath $url
        Write-Host "已打开监测页面：$url"
        $serverProcess.WaitForExit()
        if ($serverProcess.ExitCode -ne 0) { throw "监测服务退出，代码 $($serverProcess.ExitCode)。" }
        exit 0
    } finally {
        if ($serverProcess -and -not $serverProcess.HasExited) { Stop-Process -Id $serverProcess.Id -Force }
    }
} catch {
    Write-Host "启动失败：$($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
