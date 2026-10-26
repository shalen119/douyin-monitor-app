$ErrorActionPreference = 'Stop'
$appRoot = $PSScriptRoot
$runtimeRoot = Join-Path $appRoot '.runtime'
$nodeVersion = '24.22.1'

function Get-UsableNode {
    $globalNode = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($globalNode) {
        try {
            $reported = (& $globalNode.Source --version).Trim()
            if ([version]($reported.TrimStart('v')) -ge [version]'24.0.0') {
                return @{ Node = $globalNode.Source; Npm = (Get-Command npm.cmd -ErrorAction Stop).Source; Version = $reported }
            }
        } catch { }
    }
    return $null
}

function Get-EdgePath {
    $paths = @(
        (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'),
        (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe'),
        (Join-Path $env:LOCALAPPDATA 'Microsoft\Edge\Application\msedge.exe')
    )
    foreach ($candidate in $paths) {
        if ($candidate -and (Test-Path -LiteralPath $candidate)) { return $candidate }
    }
    $edge = Get-Command msedge.exe -ErrorAction SilentlyContinue
    if ($edge) { return $edge.Source }
    return $null
}

try {
    if ($env:OS -ne 'Windows_NT') { throw '此安装脚本目前只支持 Windows。' }
    Write-Host '正在检查 Node.js 和 Microsoft Edge...'
    $runtime = Get-UsableNode
    if (-not $runtime) {
        $architecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()
        if ($architecture -notin @('x64', 'arm64')) { throw "暂不支持 $architecture 架构；需要 Windows x64 或 ARM64。" }
        $folder = "node-v$nodeVersion-win-$architecture"
        $nodeDir = Join-Path $runtimeRoot $folder
        $nodePath = Join-Path $nodeDir 'node.exe'
        if (-not (Test-Path -LiteralPath $nodePath)) {
            New-Item -ItemType Directory -Path $runtimeRoot -Force | Out-Null
            $archiveName = "$folder.zip"
            $archivePath = Join-Path $runtimeRoot $archiveName
            $base = "https://nodejs.org/dist/v$nodeVersion"
            $checksumPath = Join-Path $runtimeRoot 'SHASUMS256.txt'
            Write-Host "正在从 Node.js 官网下载 $archiveName（约 38 MB）..."
            Invoke-WebRequest -Uri "$base/$archiveName" -OutFile $archivePath -UseBasicParsing -TimeoutSec 300
            Invoke-WebRequest -Uri "$base/SHASUMS256.txt" -OutFile $checksumPath -UseBasicParsing -TimeoutSec 60
            $line = Get-Content -LiteralPath $checksumPath | Where-Object { $_ -match "\s$([regex]::Escape($archiveName))$" } | Select-Object -First 1
            if (-not $line) { throw '无法从官方校验文件找到 Node.js 安装包。' }
            $expected = ($line -split '\s+')[0]
            $actual = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash
            if ($actual -ne $expected) { throw 'Node.js 下载文件的 SHA-256 校验失败；请重试。' }
            Write-Host '校验通过，正在解压本地 Node.js...'
            Expand-Archive -LiteralPath $archivePath -DestinationPath $runtimeRoot -Force
            Remove-Item -LiteralPath $archivePath, $checksumPath -Force
        }
        if (-not (Test-Path -LiteralPath $nodePath)) { throw 'Node.js 解压后未找到 node.exe。' }
        $runtime = @{ Node = $nodePath; Npm = (Join-Path $nodeDir 'npm.cmd'); Version = (& $nodePath --version).Trim() }
    }
    Write-Host "Node.js $($runtime.Version) 已就绪。"

    if (-not (Get-EdgePath)) {
        $winget = Get-Command winget.exe -ErrorAction SilentlyContinue
        if (-not $winget) { throw '未找到 Microsoft Edge，且系统没有 winget。请从 https://www.microsoft.com/edge/download 安装 Edge 后重试。' }
        Write-Host '未找到 Microsoft Edge，正在通过 Windows 包管理器安装...'
        & $winget.Source install --id Microsoft.Edge --exact --source winget --silent --accept-package-agreements --accept-source-agreements
        if ($LASTEXITCODE -ne 0 -or -not (Get-EdgePath)) {
            throw 'Edge 自动安装未完成。请从 https://www.microsoft.com/edge/download 安装后重试。'
        }
    }
    Write-Host 'Microsoft Edge 已就绪。'

    if (-not (Test-Path -LiteralPath $runtime.Npm)) { throw '未找到 npm.cmd；请重新运行环境安装。' }
    Write-Host '正在安装项目依赖（首次需联网）...'
    Push-Location $appRoot
    try {
        & $runtime.Npm ci --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { throw "npm ci 失败，退出码 $LASTEXITCODE。" }
    } finally { Pop-Location }
    if (-not (Test-Path -LiteralPath (Join-Path $appRoot 'node_modules\playwright-core'))) { throw '依赖安装后未找到 playwright-core。' }
    Write-Host '环境安装完成。请双击“启动抖音监测.cmd”。'
    exit 0
} catch {
    Write-Host "安装失败：$($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
