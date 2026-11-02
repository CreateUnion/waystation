<#
.SYNOPSIS
    master 提示词同步：把 cc-connect config.toml 各 [projects.agent.options] 段的
    append_system_prompt 值同步为 templates\master-prompt.md 全文（单一权威源）。
.DESCRIPTION
    master 提示词的唯一编辑入口是仓库文件 templates\master-prompt.md；本机 cc-connect
    配置里的注入值由本脚本整体替换为模板全文（setup.ps1 安装注入同样从模板生成，两处
    形态逐字一致）。复用 setup.ps1 的备份+段界防线模式：
      - 段界防线：段内 """ 计数为奇数 = 段界落在三引号多行字符串内部 → 放弃该段并降级
        待手动（退出码 2），文件原样不动。
      - 实际写入前备份（config.toml.bak-sync-<时间戳>）。
      - 写回 UTF8 无 BOM；换行沿用文件既有风格。
    幂等：现值已与模板一致 → 跳过该段；键缺失 → 新增（与 setup.ps1 注入形态逐字一致）。
    退出码：0=同步完成（-DryRun 预览恒 0）；1=致命失败（模板缺失/配置文件不存在/读写失败
    且无备份可依）；2=完成但有待手动段。
    本脚本不改动 allowed_tools 等其余键；不重启任何服务（改完 cc-connect 配置后按需自行
    重启生效）。
.PARAMETER ConfigPath
    cc-connect 配置文件路径（默认 ~\.cc-connect\config.toml）。
.PARAMETER DryRun
    预览模式：逐段打印将新增/替换/跳过/放弃的计划，不备份不写入。
.EXAMPLE
    powershell -File install\sync-master-prompt.ps1 -DryRun
.EXAMPLE
    powershell -File install\sync-master-prompt.ps1
#>
#Requires -Version 5.1
[CmdletBinding()]
param(
    [string]$ConfigPath,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

# PowerShell 5.1 在 stdout 被重定向时按 OEM 码页输出，重定向形态显式置 UTF-8（同 setup.ps1 先例）
if ([Console]::IsOutputRedirected) {
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
}

$RepoRoot = Split-Path -Parent $PSScriptRoot
$TemplatePath = Join-Path $RepoRoot 'templates\master-prompt.md'
if (-not $ConfigPath) {
    $ConfigPath = Join-Path $env:USERPROFILE '.cc-connect\config.toml'
} elseif ($ConfigPath.StartsWith('~')) {
    $ConfigPath = Join-Path $env:USERPROFILE $ConfigPath.TrimStart('~')
}
$script:PendingManual = @()

function Write-Say([string]$Text) { Write-Host $Text }
function Write-Note([string]$Text) { Write-Host "    $Text" }
function Write-Warn([string]$Text) { Write-Host "  ！$Text" -ForegroundColor Yellow }

function Fail([string]$Text) {
    Write-Host "`n错误：$Text" -ForegroundColor Red
    exit 1
}

# 记一条「待手动」事项并把退出码抬到 2（dry-run 下调用方负责不走到这里）。
function Add-Manual([string]$Text) {
    $script:PendingManual += $Text
}

# 读模板正文行数组（去末尾空行）；缺失/不可读/为空返回 $null。
function Read-TemplateLines {
    if (-not (Test-Path $TemplatePath)) { return $null }
    try {
        $raw = [System.IO.File]::ReadAllText($TemplatePath)
    } catch {
        return $null
    }
    $tplLines = @($raw -split "`r?`n")
    while ($tplLines.Count -gt 0 -and $tplLines[$tplLines.Count - 1] -eq '') {
        if ($tplLines.Count -eq 1) { return $null }
        $tplLines = $tplLines[0..($tplLines.Count - 2)]
    }
    if ($tplLines.Count -eq 0) { return $null }
    return $tplLines
}

# 模板正文行 → append_system_prompt 三引号多行串（与 setup.ps1 Get-MasterPromptLines 形态逐字一致）。
function ConvertTo-PromptBlock([string[]]$TplLines) {
    $lines = @('append_system_prompt = """' + $TplLines[0])
    if ($TplLines.Count -gt 2) {
        $lines += $TplLines[1..($TplLines.Count - 2)]
    }
    if ($TplLines.Count -gt 1) {
        $lines += ($TplLines[$TplLines.Count - 1] + '"""')
    } else {
        $lines[0] += '"""'
    }
    return $lines
}

# 逐行精确比较（区分大小写）；行数或任一行不同即不等。
function Test-SameLines([string[]]$A, [string[]]$B) {
    if ($A.Count -ne $B.Count) { return $false }
    for ($i = 0; $i -lt $A.Count; $i++) {
        if ($A[$i] -cne $B[$i]) { return $false }
    }
    return $true
}

# 同步主流程：逐段定位 append_system_prompt 现值 → 与模板比较 → 生成新增/替换计划 →
# 段界防线放行的段按「先备份后整体重写」落盘。返回是否实际写入。
function Sync-CcConfig([string[]]$TplLines, [string[]]$PromptBlock) {
    $backupPath = $null
    try {
        $raw = [System.IO.File]::ReadAllText($ConfigPath)
        $newline = "`r`n"
        if ($raw.IndexOf("`r`n") -lt 0) { $newline = "`n" }
        $lines = $raw -split "`r?`n"
        $sectionIdx = @()
        for ($i = 0; $i -lt $lines.Count; $i++) {
            if ($lines[$i].TrimStart() -match '^\[projects\.agent\.options\]$') { $sectionIdx += $i }
        }
        if ($sectionIdx.Count -eq 0) {
            Write-Warn 'config.toml 中没有 [projects.agent.options] 段（结构未知）——不做同步'
            if (-not $DryRun) {
                Add-Manual '手工把 append_system_prompt（模板全文）加进 cc-connect config.toml 的 [projects.agent.options] 段'
            }
            return $false
        }
        $ops = @()
        $abandoned = 0
        for ($s = 0; $s -lt $sectionIdx.Count; $s++) {
            $start = $sectionIdx[$s]
            $end = $lines.Count
            if ($s -lt $sectionIdx.Count - 1) { $end = $sectionIdx[$s + 1] }
            $quoteCount = 0
            for ($i = $start; $i -lt $end; $i++) {
                $quoteCount += ([regex]::Matches($lines[$i], '"""')).Count
            }
            if ($quoteCount % 2 -eq 1) {
                Write-Warn "第 $($start + 1) 行的 [projects.agent.options] 段含未闭合多行字符串——放弃该段同步"
                if (-not $DryRun) {
                    Add-Manual "第 $($start + 1) 行段的 append_system_prompt 未同步——段界落在未闭合多行字符串内，先手工修正 config.toml 再重跑"
                }
                $abandoned++
                continue
            }
            # 定位 append_system_prompt 键行
            $keyIdx = -1
            for ($i = $start + 1; $i -lt $end; $i++) {
                if ($lines[$i] -match '^\s*append_system_prompt\s*=') { $keyIdx = $i; break }
            }
            if ($keyIdx -lt 0) {
                Write-Note "第 $($start + 1) 行段：append_system_prompt 缺失，将新增（模板全文 $($TplLines.Count) 行）"
                $ops += @{ Start = $start + 1; Span = 0; Lines = $PromptBlock }
                continue
            }
            $keyLine = $lines[$keyIdx]
            if ($keyLine.Contains("'''")) {
                Write-Warn "第 $($start + 1) 行段的 append_system_prompt 为单引号多行串（三单引号形态）——放弃该段自动替换"
                if (-not $DryRun) {
                    Add-Manual "第 $($start + 1) 行段的 append_system_prompt 未同步（三单引号形态）——手工替换为模板全文"
                }
                $abandoned++
                continue
            }
            $keyQuotes = ([regex]::Matches($keyLine, '"""')).Count
            $valueEnd = -1
            if ($keyQuotes -ge 2) {
                $valueEnd = $keyIdx            # 开合都在键行内：append_system_prompt = """…"""
            } elseif ($keyQuotes -eq 1) {
                $seen = 1
                for ($i = $keyIdx + 1; $i -lt $end; $i++) {
                    $seen += ([regex]::Matches($lines[$i], '"""')).Count
                    if ($seen -ge 2) { $valueEnd = $i; break }
                }
                if ($valueEnd -lt 0) {
                    Write-Warn "第 $($start + 1) 行段的 append_system_prompt 找不到闭合三引号——放弃该段同步"
                    if (-not $DryRun) {
                        Add-Manual "第 $($start + 1) 行段的 append_system_prompt 未同步——找不到闭合三引号，手工检查后重跑"
                    }
                    $abandoned++
                    continue
                }
            } else {
                $valueEnd = $keyIdx            # 无三引号的单行值 → 整行替换
            }
            # 提取现值正文行，与模板正文逐行比较（一致 → 幂等跳过）
            $valueLines = @()
            if ($keyQuotes -eq 0) {
                $valueLines += $keyLine
            } else {
                $valueLines += $keyLine.Substring($keyLine.IndexOf('"""') + 3)
                for ($i = $keyIdx + 1; $i -lt $valueEnd; $i++) { $valueLines += $lines[$i] }
                $tail = $lines[$valueEnd]
                $tailCut = $tail.LastIndexOf('"""')
                if ($tailCut -gt 0) {
                    $valueLines += $tail.Substring(0, $tailCut)
                } elseif ($tailCut -eq 0) {
                    $valueLines += ''
                }
            }
            if (Test-SameLines $valueLines $TplLines) {
                Write-Note "第 $($start + 1) 行段：append_system_prompt 已与模板一致，跳过"
                continue
            }
            $verb = '将把 append_system_prompt 替换为模板全文'
            if ($keyIdx -ge 0 -and $keyQuotes -eq 0 -and $keyLine -match '^\s*append_system_prompt\s*=\s*$') { $verb = '将填充空 append_system_prompt 为模板全文' }
            Write-Note "第 $($start + 1) 行段：$verb（$($TplLines.Count) 行）"
            $ops += @{ Start = $keyIdx; Span = ($valueEnd - $keyIdx + 1); Lines = $PromptBlock }
        }
        if ($ops.Count -eq 0) {
            if ($abandoned -eq 0) { Write-Note '全部段落已与模板一致，无需改动' }
            return $false
        }
        if ($DryRun) {
            Write-Note "（dry-run）将备份并同步 config.toml（改动 $($ops.Count) 段，放弃 $abandoned 段），不写入"
            return $false
        }
        $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
        $backupPath = "$ConfigPath.bak-sync-$stamp"
        Copy-Item -Force -Path $ConfigPath -Destination $backupPath
        $out = New-Object 'System.Collections.Generic.List[string]'
        $out.AddRange([string[]]$lines)
        $sorted = @($ops | Sort-Object { $_.Start } -Descending)
        foreach ($op in $sorted) {
            if ($op.Span -gt 0) { $out.RemoveRange([int]$op.Start, [int]$op.Span) }
            $out.InsertRange([int]$op.Start, [string[]]$op.Lines)
        }
        [System.IO.File]::WriteAllText($ConfigPath, ($out -join $newline), (New-Object System.Text.UTF8Encoding($false)))
        Write-Note "已同步并备份：$backupPath"
        return $true
    } catch {
        Write-Warn "config.toml 同步未完成（$($_.Exception.Message)）"
        if (-not $DryRun) {
            if ($backupPath -and (Test-Path $backupPath)) {
                Add-Manual "config.toml 同步写入失败——手工把 append_system_prompt（模板全文）加进其 [projects.agent.options] 段（同步前备份已留在 $backupPath，必要时可据此还原）"
            } else {
                Add-Manual 'config.toml 同步失败（备份亦未生成）——手工把 append_system_prompt（模板全文）加进其 [projects.agent.options] 段'
            }
        }
        return $false
    }
}

# ===== 主流程 =====

Write-Say '=== master 提示词同步（单一权威源：templates\master-prompt.md） ==='
if ($DryRun) { Write-Say '（dry-run：只打印逐段计划，不备份不写入）' }

$tplLines = Read-TemplateLines
if ($null -eq $tplLines) {
    Fail "未找到 master 提示词模板（$TemplatePath）——同步无源，中止（先恢复模板文件）"
}
if (-not (Test-Path $ConfigPath)) {
    Fail "未找到 cc-connect 配置文件（$ConfigPath）——同步无目标，中止"
}

Write-Note "模板：$TemplatePath（$($tplLines.Count) 行）"
Write-Note "配置：$ConfigPath"
$changed = Sync-CcConfig $tplLines (ConvertTo-PromptBlock $tplLines)

if ($script:PendingManual.Count -gt 0) {
    Write-Warn "待手动事项 $($script:PendingManual.Count) 项："
    foreach ($item in $script:PendingManual) { Write-Note "- $item" }
    Write-Say ''
    Write-Say '同步完成（有待手动段）。'
    exit 2
}
Write-Say ''
if ($DryRun) { Write-Say '预览完成（未写入）。' } elseif ($changed) { Write-Say '同步完成。' } else { Write-Say '无需改动。' }
exit 0
