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

# —— cc-connect 注入内容（与 2026-10-30 已验证配置逐字一致；唯一权威在本文件） ——
$script:AllowedToolsLines = @(
    'allowed_tools = ['
    '  "mcp__waystation__ws_status",'
    '  "mcp__waystation__ws_list_collabs",'
    '  "mcp__waystation__ws_create_collab",'
    '  "mcp__waystation__ws_dispatch_scan",'
    '  "mcp__waystation__ws_dispatch_claim",'
    '  "mcp__waystation__ws_dispatch_release",'
    '  "mcp__waystation__ws_send_message",'
    '  "mcp__waystation__ws_end_collab",'
    ']'
)
$script:AppendPromptLines = @(
    'append_system_prompt = """你是 waystation dispatch master：启动环境已带 WAYSTATION_ROLE=master，可把任务分派给本机其他 Claude Code 会话并行执行。'
    '需要多会话作业时：1) ws_create_collab {name, mode: dispatch} 创建（一个核心同时只允许一个）；2) ws_dispatch_scan 查看本机在线会话，ws_dispatch_claim 收编目标；交互式会话返回 pending 属正常，等对方用户确认，不要催促或重复发起；3) ws_send_message {collabId, type: task, toSessionIds, taskId} 下发任务，收 progress/result，type 只用 task/progress/result/error；4) 结束用 ws_dispatch_release 释放单个或 ws_end_collab 整体结束。'
    '纪律：dispatch 消息只走本机核心不占微信额度；给用户的回复合并为一条汇总，不要逐条转发 slave 消息；slave 的 result 已含结论时不要重复追问；dispatch 是纯内存的，核心或 cc-connect 重启后需重建。"""'
)

# 文本级合并：对每个 [projects.agent.options] 段插入缺失键；返回实际发生合并的段数（dry-run 恒 0）。
# 段界防线：候选段范围内 """ 计数为奇数 = 段界落在多行字符串内部 → 该段放弃自动合并并降级手动。
# 写回用 UTF8Encoding($false)（无 BOM）；换行沿用文件既有风格；备份仅在实际合并时创建。
function Merge-CcConfig([string]$ConfigPath) {
    if (-not (Test-Path $ConfigPath)) {
        Write-Warn '未找到 cc-connect 配置文件（config.toml）——cc-connect 可能尚未初始化'
        if (-not $DryRun) {
            Add-Manual '先完成 cc-connect 自身配置（平台对接），再重跑本脚本完成注入'
        }
        return 0
    }
    $raw = [System.IO.File]::ReadAllText($ConfigPath)
    $newline = "`r`n"
    if ($raw.IndexOf("`r`n") -lt 0) { $newline = "`n" }
    $lines = $raw -split "`r?`n"
    $sectionIdx = @()
    for ($i = 0; $i -lt $lines.Count; $i++) {
        if ($lines[$i].TrimStart() -match '^\[projects\.agent\.options\]$') { $sectionIdx += $i }
    }
    if ($sectionIdx.Count -eq 0) {
        Write-Warn 'config.toml 中没有 [projects.agent.options] 段（结构未知）——不做自动合并'
        if (-not $DryRun) {
            Add-Manual '手工把 allowed_tools 与 append_system_prompt 加进 cc-connect config.toml 的 [projects.agent.options] 段'
        }
        return 0
    }
    $insertBlocks = @()
    $changedSections = 0
    for ($s = 0; $s -lt $sectionIdx.Count; $s++) {
        $start = $sectionIdx[$s]
        $end = $lines.Count
        if ($s -lt $sectionIdx.Count - 1) { $end = $sectionIdx[$s + 1] }
        $quoteCount = 0
        for ($i = $start; $i -lt $end; $i++) {
            $quoteCount += ([regex]::Matches($lines[$i], '"""')).Count
        }
        if ($quoteCount % 2 -eq 1) {
            Write-Warn "第 $($start + 1) 行的 [projects.agent.options] 段含未闭合多行字符串——放弃该段自动合并"
            if (-not $DryRun) {
                Add-Manual '手工检查 config.toml 中未闭合的多行字符串后重跑，或手工注入 allowed_tools 与 append_system_prompt'
            }
            continue
        }
        $body = @()
        for ($i = $start + 1; $i -lt $end; $i++) { $body += $lines[$i] }
        $needTools = $null -eq ($body | Where-Object { $_ -match '^\s*allowed_tools\s*=' })
        $needPrompt = $null -eq ($body | Where-Object { $_ -match '^\s*append_system_prompt\s*=' })
        if (-not $needTools -and -not $needPrompt) {
            Write-Note "第 $($start + 1) 行的 dispatch 配置：已配置，跳过"
            continue
        }
        $insert = @()
        if ($needTools) {
            $insert += $script:AllowedToolsLines
            Write-Note "第 $($start + 1) 行段：将注入 allowed_tools（8 项白名单）"
        }
        if ($needPrompt) {
            $insert += $script:AppendPromptLines
            Write-Note "第 $($start + 1) 行段：将注入 append_system_prompt（dispatch master 规则）"
        }
        $insertBlocks += @{ At = $start + 1; Lines = $insert }
        $changedSections++
    }
    if ($changedSections -eq 0) { return 0 }
    if ($DryRun) {
        Write-Note "（dry-run）将备份并合并 config.toml（共 $changedSections 段），不写入"
        return 0
    }
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $backupPath = "$ConfigPath.bak-setup-$stamp"
    Copy-Item -Force -Path $ConfigPath -Destination $backupPath
    $out = New-Object 'System.Collections.Generic.List[string]'
    $out.AddRange([string[]]$lines)
    $sorted = @($insertBlocks | Sort-Object { $_.At } -Descending)
    foreach ($block in $sorted) {
        $out.InsertRange([int]$block.At, [string[]]$block.Lines)
    }
    [System.IO.File]::WriteAllText($ConfigPath, ($out -join $newline), (New-Object System.Text.UTF8Encoding($false)))
    Write-Note "已注入并备份：$backupPath"
    return $changedSections
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
$mergeChanged = 0
if (-not $ccExists) {
    Write-Warn '未检测到 cc-connect——waystation 本体（局域网协作）不受影响；但无法自动配置微信/QQ 多会话控制（dispatch master 入口）。'
    Write-Note '如需该能力：安装 cc-connect 并完成平台对接后重跑本脚本即可补配。'
    $ccStatusLine = '未检测到'
} else {
    Write-Note '已检测到 cc-connect'
    $ccStatusLine = '已检测到'
    $configPath = Join-Path $HomeDir '.cc-connect\config.toml'
    $mergeChanged = Merge-CcConfig $configPath
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
