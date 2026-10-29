<#
.SYNOPSIS
    waystation 智能安装入口（Windows）。
.DESCRIPTION
    流程（设计 2026-10-30，docs/superpowers/specs/2026-10-30-waystation-setup-installer-design.md）：
      1) 检测已装 waystation（~\.waystation\app\package.json 的 version）与安装包（仓库）版本：
         未安装→全新安装；已装更低→询问更新（默认 Y）；同版或更高→跳过；版本不可解析→询问重装（默认 Y）。
         全新安装/更新都委托 scripts\install.ps1（本脚本不改它的行为）。
      2) 检测 cc-connect（服务 / ~\.cc-connect\config.toml / PATH 或 npm 全局目录，任一命中即存在）：
         不存在→提醒无法自动配置多会话控制；存在→全自动配置 dispatch master 自动化（本骨架后续版本实现）。
    特性与边界：
      - 幂等：重复运行安全。
      - -DryRun：只读检测并打印计划，零写入；询问转为打印决策；退出码恒 0。
      - 非交互 stdin：「是否更新/重装」按默认 Y。
      - 退出码：0=全部完成；2=完成但有待手动项；1=致命失败。
      - 测试缝：环境变量 WAYSTATION_TEST_SETUP=1 视 cc-connect 服务为不存在；=nocc 强制
        cc-connect 判定为不存在。仅自动化测试使用。
.PARAMETER DryRun
    预览模式：只做只读检测并打印将执行的动作，不改动任何文件或系统设置。
.PARAMETER HomeDir
    家目录根（默认 $env:USERPROFILE）。waystation 安装目录与 cc-connect 配置均按其解析；
    供测试隔离与自定义布局使用，一般无需指定。
.EXAMPLE
    powershell -File scripts\setup.ps1
.EXAMPLE
    powershell -File scripts\setup.ps1 -DryRun
#>
#Requires -Version 5.1
[CmdletBinding()]
param(
    [switch]$DryRun,
    [string]$HomeDir
)

$ErrorActionPreference = 'Stop'

# PowerShell 5.1 在 stdout 被重定向时按 OEM 码页输出，重定向形态显式置 UTF-8（同 install.ps1 先例）
if ([Console]::IsOutputRedirected) {
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
}

$RepoRoot = Split-Path -Parent $PSScriptRoot
$script:ExitCode = 0
$script:PendingManual = @()

$script:TestSeam = $env:WAYSTATION_TEST_SETUP
if ($script:TestSeam -ne '1' -and $script:TestSeam -ne 'nocc') { $script:TestSeam = '' }
$script:AssumeNoService = ($script:TestSeam -eq '1' -or $script:TestSeam -eq 'nocc')

function Write-Say([string]$Text) { Write-Host $Text }
function Write-Step([string]$Index, [string]$Text) { Write-Host "`n[$Index] $Text" -ForegroundColor Cyan }
function Write-Note([string]$Text) { Write-Host "    $Text" }
function Write-Warn([string]$Text) { Write-Host "  ！$Text" -ForegroundColor Yellow }

function Fail([string]$Text) {
    Write-Host "`n错误：$Text" -ForegroundColor Red
    exit 1
}

# 记一条「待手动」事项并把退出码抬到 2（dry-run 下调用方负责不走到这里）。
function Add-Manual([string]$Text) {
    $script:PendingManual += $Text
    if ($script:ExitCode -eq 0) { $script:ExitCode = 2 }
}

# 原生命令统一经此执行（PS 5.1/7 对「非零退出」行为不一致，结果只以退出码与输出为准；同 install.ps1）。
function Invoke-Native {
    param([string]$Command, [string[]]$CommandArgs)
    $exitCode = 0
    $output = @()
    try {
        $output = @(& $Command @CommandArgs 2>&1)
        $exitCode = $LASTEXITCODE
    } catch {
        $exitCode = -1
        $output = @($_.Exception.Message)
    }
    return [pscustomobject]@{ ExitCode = $exitCode; Output = $output }
}

# 读 package.json 的 version；文件缺失/不可解析/缺字段一律返回 $null（调用方区分「缺失」与「损坏」）。
function Get-PkgVersion([string]$Path) {
    if (-not (Test-Path $Path)) { return $null }
    try {
        $pkg = Get-Content -Raw -Encoding UTF8 -Path $Path | ConvertFrom-Json
        if ($pkg -and ($pkg.version -is [string]) -and $pkg.version -ne '') { return $pkg.version }
        return $null
    } catch {
        return $null
    }
}

# 语义版本逐段数值比较（段数不足按 0 补齐）；任一侧不可解析返回 $null。
# 局部变量名不得与参数同名异 casing：PowerShell 变量名大小写不敏感（$a 与 $A 同一存储），
# 且参数 [string] 约束持续生效——`$a = $null` 会被强转成 ''，既骗过 $null 判定又让
# 「补段 while」退化成字符串拼接死循环（setup 测试实测）。故用独立命名的 $aSegs/$bSegs。
function Compare-Versions([string]$A, [string]$B) {
    $aSegs = $null
    $bSegs = $null
    if ($A -match '^\d+(\.\d+)*$') { $aSegs = @($A -split '\.' | ForEach-Object { [int]$_ }) }
    if ($B -match '^\d+(\.\d+)*$') { $bSegs = @($B -split '\.' | ForEach-Object { [int]$_ }) }
    if ($null -eq $aSegs -or $null -eq $bSegs) { return $null }
    while ($aSegs.Count -lt 3) { $aSegs += 0 }
    while ($bSegs.Count -lt 3) { $bSegs += 0 }
    for ($i = 0; $i -lt 3; $i++) {
        if ($aSegs[$i] -lt $bSegs[$i]) { return -1 }
        if ($aSegs[$i] -gt $bSegs[$i]) { return 1 }
    }
    return 0
}

# 询问 Y/N：dry-run 打印决策不阻塞；非交互 stdin 按默认；空输入/其他输入按默认。
function Ask-YesNo([string]$Question, [bool]$DefaultYes) {
    $defaultText = 'Y'
    if (-not $DefaultYes) { $defaultText = 'N' }
    if ($DryRun) {
        Write-Note "（dry-run）将询问：「$Question」默认 $defaultText"
        return $DefaultYes
    }
    if ([Console]::IsInputRedirected) {
        Write-Note "（非交互）「$Question」按默认 $defaultText"
        return $DefaultYes
    }
    $answer = Read-Host "$Question（Y/n，默认 $defaultText）"
    if ($answer -eq '') { return $DefaultYes }
    if ($answer -match '^[yY]') { return $true }
    if ($answer -match '^[nN]') { return $false }
    return $DefaultYes
}

# 真正的文件安装/升级全部由 install.ps1 承担；它失败 = 致命失败（不再继续后续步骤）。
function Invoke-Install {
    if ($DryRun) {
        Write-Note '（dry-run）将执行：powershell -NoProfile -File scripts\install.ps1'
        return
    }
    Write-Note '执行全量安装脚本（install.ps1）……'
    $run = Invoke-Native -Command 'powershell' -CommandArgs @('-NoProfile', '-File', (Join-Path $RepoRoot 'scripts\install.ps1'))
    if ($run.ExitCode -ne 0) {
        Fail "install.ps1 退出码 $($run.ExitCode)——安装未完成，中止智能安装"
    }
}

# cc-connect 存在性判定（任一命中即存在）：
#   Windows 服务 cc-connect（测试缝 =1/nocc 时跳过本信号）→ ~\.cc-connect\config.toml →
#   PATH 上的 cc-connect 命令 → npm 全局目录下 node_modules\cc-connect。
function Test-CcConnectExists {
    if ($script:TestSeam -eq 'nocc') { return $false }
    if (-not $script:AssumeNoService) {
        $svc = Get-Service -Name 'cc-connect' -ErrorAction SilentlyContinue
        if ($svc) { return $true }
    }
    if (Test-Path (Join-Path $HomeDir '.cc-connect\config.toml')) { return $true }
    $cmd = Get-Command 'cc-connect' -ErrorAction SilentlyContinue
    if ($cmd) { return $true }
    $npm = Invoke-Native -Command 'npm' -CommandArgs @('prefix', '-g')
    if ($npm.ExitCode -eq 0) {
        $prefix = ([string]($npm.Output | Select-Object -First 1)).Trim()
        if ($prefix -ne '' -and (Test-Path (Join-Path $prefix 'node_modules\cc-connect'))) { return $true }
    }
    return $false
}

# ===== 主流程 =====

if (-not (Test-Path (Join-Path $RepoRoot 'package.json')) -or -not (Test-Path (Join-Path $RepoRoot 'scripts\install.ps1'))) {
    Fail '本脚本需在完整仓库内运行（缺 package.json 或 scripts\install.ps1）'
}
if (-not $HomeDir) { $HomeDir = $env:USERPROFILE }

Write-Say '=== waystation 智能安装 ==='
if ($DryRun) { Write-Say '（dry-run：只做只读检测并打印计划，不改动任何文件或系统设置）' }

Write-Step '1/3' 'waystation 安装检测'
$bundledVersion = Get-PkgVersion (Join-Path $RepoRoot 'package.json')
if ($null -eq $bundledVersion) { Fail '仓库 package.json 缺 version 字段或不可解析——安装包损坏' }
$installedPkgPath = Join-Path $HomeDir '.waystation\app\package.json'
$installedFileExists = Test-Path $installedPkgPath
$installedVersion = Get-PkgVersion $installedPkgPath
$wsStatusLine = ''
if (-not $installedFileExists) {
    Write-Note "未检测到已安装的 waystation——将执行全新安装（安装包 v$bundledVersion）"
    Invoke-Install
    if ($DryRun) { $wsStatusLine = '计划：全新安装' } else { $wsStatusLine = "全新安装 v$bundledVersion" }
} elseif ($null -eq $installedVersion) {
    Write-Note "已安装但版本不可解析（$installedPkgPath）——视为未知状态"
    if (Ask-YesNo '无法确认已装版本，是否重装？' $true) {
        Invoke-Install
        if ($DryRun) { $wsStatusLine = '计划：重装' } else { $wsStatusLine = "重装 v$bundledVersion" }
    } else {
        $wsStatusLine = '保留（版本未知，未重装）'
        Write-Note '保留现状，跳过安装'
    }
} else {
    $cmp = Compare-Versions $installedVersion $bundledVersion
    if ($null -eq $cmp) {
        Write-Note "已装版本「$installedVersion」与安装包版本「$bundledVersion」均无法比较——视为未知状态"
        if (Ask-YesNo '无法比较版本，是否重装？' $true) {
            Invoke-Install
            if ($DryRun) { $wsStatusLine = '计划：重装' } else { $wsStatusLine = "重装 v$bundledVersion" }
        } else {
            $wsStatusLine = "保留 v$installedVersion（版本不可比较，未重装）"
            Write-Note '保留现状，跳过安装'
        }
    } elseif ($cmp -lt 0) {
        Write-Note "已安装 v$installedVersion，安装包 v$bundledVersion——已装版本较低"
        if (Ask-YesNo "已装 v$installedVersion，安装包 v$bundledVersion，是否更新？" $true) {
            Invoke-Install
            if ($DryRun) { $wsStatusLine = "计划：更新 v$installedVersion → v$bundledVersion" } else { $wsStatusLine = "已更新 v$installedVersion → v$bundledVersion" }
        } else {
            $wsStatusLine = "保留 v$installedVersion（低于安装包，用户选择不更新）"
            Write-Note '保留当前版本，跳过安装'
        }
    } else {
        $wsStatusLine = "已是最新（v$installedVersion）"
        Write-Note "已是最新（v$installedVersion ≥ 安装包 v$bundledVersion），跳过安装"
    }
}

Write-Step '2/3' 'cc-connect 检测'
$ccExists = Test-CcConnectExists
$ccStatusLine = ''
if (-not $ccExists) {
    Write-Warn '未检测到 cc-connect——waystation 本体（局域网协作）不受影响；但无法自动配置微信/QQ 多会话控制（dispatch master 入口）。'
    Write-Note '如需该能力：安装 cc-connect 并完成平台对接后重跑本脚本即可补配。'
    $ccStatusLine = '未检测到'
} else {
    Write-Note '已检测到 cc-connect'
    $ccStatusLine = '已检测到'
}

Write-Step '3/3' '自检汇总'
Write-Note "waystation：$wsStatusLine"
Write-Note "cc-connect：$ccStatusLine"
if ($script:PendingManual.Count -gt 0) {
    Write-Warn "待手动事项 $($script:PendingManual.Count) 项："
    foreach ($item in $script:PendingManual) { Write-Note "- $item" }
    Write-Say ''
    Write-Say '智能安装完成（有待手动项）。'
} else {
    Write-Say ''
    Write-Say '智能安装完成。'
}
exit $script:ExitCode
