<#
.SYNOPSIS
    waystation 安装脚本（Windows）。

.DESCRIPTION
    流程（与设计「安装与配置」节一致）：
      1) 检测 Node（下限实读 package.json 的 engines；缺失时给安装指引，不静默安装）
      2) 拷贝运行所需文件到 %USERPROFILE%\.waystation\app\ 并用 npm ci --omit=dev 就位依赖
      3) 放置可执行 %USERPROFILE%\.waystation\bin\waystation.cmd
      4) 注册 Claude Code MCP（未装 claude CLI 时打印手工步骤、不视为失败）
      5) 安装斜杠命令到 ~/.claude/commands/（未装 claude CLI 时打印手工步骤、不视为失败）
      6) 自检 + 打印防火墙放行指引与会话期首检清单

    特性与边界：
      - 幂等：重复运行安全（重新拷贝、重装依赖、重新注册）。
      - -DryRun：只做只读检测并打印将执行的动作，不改动任何文件或系统设置。
      - 防火墙只打印指引、绝不自动修改。
      - 卸载：-Uninstall（先停核心，再注销 MCP、删斜杠命令、删安装目录与可执行；核心拒绝
        停止时拒绝卸载并提示）；数据目录默认保留，加 -PurgeData 才连数据目录一起删。
        「waystation uninstall」命令（驿站本体提供：停核 + 注销注册 + 清理 + 数据可选保留）
        在默认布局下与之等价可选——已装驿站二选一即可；
        自定义 WAYSTATION_HOME 时以该命令为准（本脚本不读该变量）。

.PARAMETER DryRun
    预览模式：只做只读检测并打印将执行的动作，不改动任何文件或系统设置。

.PARAMETER Uninstall
    卸载模式：注销 MCP、删斜杠命令、删安装目录与可执行；数据目录默认保留。

.PARAMETER PurgeData
    仅与 -Uninstall 连用：连数据目录（含全部协作数据）一起删除。

.EXAMPLE
    powershell -File scripts\install.ps1
.EXAMPLE
    powershell -File scripts\install.ps1 -DryRun
.EXAMPLE
    powershell -File scripts\install.ps1 -Uninstall
    （若本机脚本执行策略拦截，按你的安全策略处理后再运行；脚本可全文审读。
      另有 waystation uninstall 命令（由驿站本体提供）：默认布局下与脚本开关等价，
      自定义 WAYSTATION_HOME 时以该命令为准——本脚本不读该变量）
#>
#Requires -Version 5.1
[CmdletBinding()]
param(
    [switch]$DryRun,
    [switch]$Uninstall,
    [switch]$PurgeData
)

$ErrorActionPreference = 'Stop'

# PowerShell 5.1 在 stdout 被重定向/管道时按系统 OEM 码页（中文环境 CP936）编码输出，用 UTF-8
# 工具查看会乱码；仅在重定向形态下显式置 UTF-8，让留档/CI 日志可读（交互式控制台零影响）。
if ([Console]::IsOutputRedirected) {
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
}

$DataDir = Join-Path $HOME '.waystation'
$AppDir = Join-Path $DataDir 'app'
$BinDir = Join-Path $DataDir 'bin'
$ShimPath = Join-Path $BinDir 'waystation.cmd'
$RepoRoot = Split-Path -Parent $PSScriptRoot

$script:AnchorPort = 7321    # Read-PortAnchor 会从源码实读覆盖；此处兜底值仅为变量初始化
$script:AnchorFallback = $false
$script:McpState = 'pending'
$script:McpCommandArgs = @()

function Write-Say([string]$Text) { Write-Host $Text }
function Write-Step([string]$Index, [string]$Text) { Write-Host "`n[$Index] $Text" -ForegroundColor Cyan }
function Write-Note([string]$Text) { Write-Host "    $Text" }
function Write-Warn([string]$Text) { Write-Host "  ！$Text" -ForegroundColor Yellow }
function Fail([string]$Text) {
    Write-Host "`n错误：$Text" -ForegroundColor Red
    exit 1
}

function Invoke-Native {
    # 原生命令（node/npm/claude）统一经此执行：不同 PowerShell 版本对「原生命令非零退出」的行为
    # 不一致（7.4+ 在 ErrorActionPreference=Stop 下会抛错），这里统一兜住，结果只以退出码与输出为准
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

function Assert-RepoTree {
    foreach ($rel in @('package.json', 'package-lock.json')) {
        $path = Join-Path $RepoRoot $rel
        if (-not (Test-Path $path)) {
            Fail "本脚本需在仓库内运行：找不到 $path"
        }
    }
    $entry = Join-Path $RepoRoot 'bin\waystation.js'
    if (-not (Test-Path $entry)) {
        Fail "找不到 $entry"
    }
    if (-not (Test-Path (Join-Path $RepoRoot 'src'))) {
        Fail "找不到 $(Join-Path $RepoRoot 'src')"
    }
    $commandsDir = Join-Path $RepoRoot 'scripts\claude-commands'
    if (-not (Test-Path $commandsDir)) {
        Fail "找不到 $commandsDir"
    }
}

function Get-RequiredEngines {
    $pkgPath = Join-Path $RepoRoot 'package.json'
    # -Encoding UTF8 必须显式给出：Windows PowerShell 5.1 的 Get-Content 缺省按系统 ANSI 码页读，
    # 会把 UTF-8 的 package.json 解成乱码，随后 ConvertFrom-Json 直接失败
    $pkg = Get-Content -Raw -Encoding UTF8 -Path $pkgPath | ConvertFrom-Json
    if (-not $pkg.engines -or -not $pkg.engines.node) {
        Fail 'package.json 未声明 engines.node，不能核对 Node 下限'
    }
    return $pkg.engines.node
}

function Assert-Node {
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
        Fail '未找到 node。请先安装 Node.js（https://nodejs.org），安装后重跑本脚本。本脚本不会自动安装 Node。'
    }
    $nodeProbe = Invoke-Native -Command 'node' -CommandArgs @('-v')
    $version = ([string]($nodeProbe.Output | Select-Object -First 1)).Trim()
    if ($nodeProbe.ExitCode -ne 0 -or $version -eq '') {
        Fail 'node -v 执行失败——Node 安装可能损坏，请修复后重跑。'
    }
    $engines = Get-RequiredEngines
    $required = [int]([regex]::Match($engines, '\d+').Value)
    $current = [int](($version.TrimStart('v') -split '\.')[0])
    if ($current -lt $required) {
        Fail "Node 版本过低：当前 $version，要求 $engines（实读自 package.json engines）。请升级 Node 后重跑。"
    }
    Write-Note "Node：$version（要求 $engines，实读自 package.json）"
    if (Get-Command npm -ErrorAction SilentlyContinue) {
        $npmProbe = Invoke-Native -Command 'npm' -CommandArgs @('-v')
        Write-Note "npm：$(($npmProbe.Output | Select-Object -First 1))"
    } else {
        Write-Warn '未找到 npm——依赖就位将失败；请安装随 Node 附带的 npm'
    }
    if (Get-Command claude -ErrorAction SilentlyContinue) {
        Write-Note 'claude CLI：已找到（将自动注册 MCP）'
    } else {
        Write-Note 'claude CLI：未找到（跳过自动注册，改打印手工步骤）'
    }
}

function Read-PortAnchor {
    # 端口锚点的唯一权威源是 src/site.js 的导出常量——实读以免脚本里的副本漂移；读不到时退回内置
    # 默认值并在输出里明示（只影响打印的指引数字，不改脚本行为）。单核口径：端口＝config.json 显式值
    # 或锚点、无槽位段（槽位已退役，脚本不再读 SLOT_COUNT）。
    $siteFile = Join-Path $RepoRoot 'src\site.js'
    $text = ''
    if (Test-Path $siteFile) {
        $text = Get-Content -Raw -Encoding UTF8 -Path $siteFile
    }
    $anchor = [regex]::Match($text, 'export const ANCHOR_PORT = (\d+)')
    if ($anchor.Success) {
        $script:AnchorPort = [int]$anchor.Groups[1].Value
    } else {
        $script:AnchorFallback = $true
    }
}

function Get-PortState([int]$Port) {
    # 只读探测：绑定本机全接口的 TCP 与 UDP 同号端口后立刻释放（不改变系统状态）
    $tcpFree = $true
    $udpFree = $true
    try {
        $listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Any, $Port)
        $listener.Start()
        $listener.Stop()
    } catch {
        $tcpFree = $false
    }
    try {
        $udp = New-Object System.Net.Sockets.UdpClient($Port)
        $udp.Close()
    } catch {
        $udpFree = $false
    }
    return @{ TcpFree = $tcpFree; UdpFree = $udpFree }
}

function Test-PortAvailability {
    $state = Get-PortState -Port $script:AnchorPort
    if ($state.TcpFree -and $state.UdpFree) {
        Write-Note "锚点端口 $($script:AnchorPort)（TCP+UDP）：当前可绑（未显式配置端口时核心用此端口）"
    } elseif (-not $state.TcpFree -and -not $state.UdpFree) {
        Write-Note "锚点端口 $($script:AnchorPort)（TCP+UDP）：已被占用——若本机核心在跑属正常；否则核心启动时会按端口规程处理（占用者分类：降级服务或等待接管）"
    } else {
        $tcpText = '可绑'
        if (-not $state.TcpFree) { $tcpText = '被占用' }
        $udpText = '可绑'
        if (-not $state.UdpFree) { $udpText = '被占用' }
        Write-Note "锚点端口 $($script:AnchorPort)：TCP=$tcpText、UDP=$udpText——核心启动时会按端口规程处理"
    }
    Write-Note "单核端口口径：config.json 显式配置的 port 优先，未配时主根用锚点 $($script:AnchorPort)；无槽位段（显式多根须各自配端口）"
    if ($script:AnchorFallback) {
        Write-Warn "未能从 src/site.js 读取端口锚点，以上按内置默认值（$($script:AnchorPort)）打印"
    }
}

function Test-PathOnPath([string]$Dir) {
    $normalized = $Dir.TrimEnd('\')
    foreach ($entry in ($env:Path -split ';')) {
        if ($entry -ne '' -and $entry.TrimEnd('\') -ieq $normalized) {
            return $true
        }
    }
    return $false
}

function Install-Files {
    Write-Step '2/6' "安装运行文件到 $AppDir"
    if ($DryRun) {
        Write-Note '将清理并重新拷贝：bin\ src\ scripts\statusline.js scripts\ws-viewer.js package.json package-lock.json'
        Write-Note '将在安装目录执行：npm ci --omit=dev --no-audit --no-fund'
        return
    }
    New-Item -ItemType Directory -Force -Path $AppDir | Out-Null
    foreach ($sub in @('bin', 'src', 'scripts')) {
        $target = Join-Path $AppDir $sub
        if (Test-Path $target) {
            Remove-Item -Recurse -Force $target
        }
    }
    foreach ($sub in @('bin', 'src')) {
        Copy-Item -Recurse -Force -Path (Join-Path $RepoRoot $sub) -Destination (Join-Path $AppDir $sub)
    }
    New-Item -ItemType Directory -Force -Path (Join-Path $AppDir 'scripts') | Out-Null
    Copy-Item -Force -Path (Join-Path $RepoRoot 'scripts\statusline.js') -Destination (Join-Path $AppDir 'scripts')
    Copy-Item -Force -Path (Join-Path $RepoRoot 'scripts\ws-viewer.js') -Destination (Join-Path $AppDir 'scripts')
    Copy-Item -Force -Path (Join-Path $RepoRoot 'package.json') -Destination $AppDir
    Copy-Item -Force -Path (Join-Path $RepoRoot 'package-lock.json') -Destination $AppDir
    if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
        Fail "未找到 npm（Node 通常随附 npm）；可在安装目录手动执行：cd $AppDir; npm ci --omit=dev"
    }
    Push-Location $AppDir
    try {
        $npmRun = Invoke-Native -Command 'npm' -CommandArgs @('ci', '--omit=dev', '--no-audit', '--no-fund')
    } finally {
        Pop-Location
    }
    if ($npmRun.ExitCode -ne 0) {
        foreach ($line in $npmRun.Output) {
            Write-Host "    $line"
        }
        Fail "依赖安装失败（npm ci）。离线环境可在有网络的机器上执行 npm ci 后整体拷贝 node_modules；或在本机手动执行：cd $AppDir; npm ci --omit=dev"
    }
    Write-Note "已安装：$AppDir"
}

function Install-Shim {
    Write-Step '3/6' "放置可执行：$ShimPath"
    if ($DryRun) {
        Write-Note "将写入 $ShimPath（内容：调用 node 运行 $AppDir\bin\waystation.js）"
        return
    }
    New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
    # %~dp0 = 本 .cmd 所在目录（含尾反斜杠）——相对指向安装目录，避免把主目录路径写死在文件里；
    # @echo off 必须保留：否则 cmd 会把命令行回显到 stdout，污染 MCP 的 stdio 通道
    $lines = @(
        '@echo off',
        'node "%~dp0..\app\bin\waystation.js" %*'
    )
    Set-Content -Path $ShimPath -Value $lines -Encoding ASCII
    Write-Note "已放置：$ShimPath（供人工在终端使用；MCP 注册见下一步，不依赖 PATH）"
    if (-not (Test-PathOnPath $BinDir)) {
        Write-Note "若想在终端里直接敲 waystation：把 $BinDir 加入用户 PATH（系统设置 → 环境变量）后重开终端"
    }
}

function Register-Mcp {
    Write-Step '4/6' '注册 Claude Code MCP（claude mcp add -s user waystation -- ...）'
    # Windows 上注册命令用 node + 入口 .js 的绝对路径：Claude Code 以 shell:false 直接 spawn MCP 子进程，
    # .cmd shim 不经 shell 不可靠（本机 CLI 内嵌实现证实）；旁边的 .cmd 只供人工在终端使用。
    $script:McpCommandArgs = @('node', (Join-Path $AppDir 'bin\waystation.js'))
    $targetText = "node `"$($script:McpCommandArgs[1])`""
    if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
        $script:McpState = 'skipped'
        if ($DryRun) {
            Write-Note '未找到 claude CLI——真实运行时将跳过自动注册（不视为失败）并打印手工步骤'
        } else {
            Write-Note '未找到 claude CLI——跳过自动注册（不影响安装的其他部分；其他 MCP 客户端同理，按 stdio 配置命令即可）'
        }
        Write-Note '手工步骤（安装 Claude Code 后执行）：'
        Write-Note "  claude mcp add -s user waystation -- $targetText"
        return
    }
    if ($DryRun) {
        Write-Note '将执行（幂等序列）：'
        Write-Note '  claude mcp remove -s user waystation   （先清旧注册；未注册时该命令报错，属预期、忽略）'
        Write-Note "  claude mcp add -s user waystation -- $targetText"
        $script:McpState = 'dry-run'
        return
    }
    # 同名重复 add 会被 claude CLI 拒绝（already exists），故先静默注销再注册来保证可重跑
    $null = Invoke-Native -Command 'claude' -CommandArgs @('mcp', 'remove', '-s', 'user', 'waystation')
    $addRun = Invoke-Native -Command 'claude' -CommandArgs (@('mcp', 'add', '-s', 'user', 'waystation', '--') + $script:McpCommandArgs)
    if ($addRun.ExitCode -eq 0) {
        $script:McpState = 'registered'
        Write-Note "注册完成：waystation -> $targetText"
        Write-Note '（此处只写入注册配置；连接与工具可用性在首次会话里用 /mcp 查看——本脚本不做会拉起服务器进程的健康检查）'
    } else {
        $script:McpState = 'failed'
        foreach ($line in $addRun.Output) {
            Write-Host "    $line"
        }
        Fail "claude mcp add 失败（注册目标：$targetText）。可手动执行同一命令查看原因；或先跳过注册继续安装（重复本脚本即可重试）"
    }
}

function Install-ClaudeCommands {
    # 受管命令的「哪些文件/怎么判定」全部在 src/claude-commands.js（唯一权威）；本步只调入口并转发输出
    Write-Step '5/6' '安装斜杠命令到 ~/.claude/commands/'
    $commandsSourceDir = Join-Path $RepoRoot 'scripts\claude-commands'
    if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
        if ($DryRun) {
            Write-Note '未找到 claude CLI——真实运行时将跳过安装（不视为失败）并打印手工步骤'
        } else {
            Write-Note '未找到 claude CLI——跳过安装（不影响安装的其他部分）'
        }
        Write-Note '手工步骤（安装 Claude Code 后执行）：'
        Write-Note "  把 $commandsSourceDir 下的受管命令文件拷到 ~\.claude\commands\"
        return
    }
    $modulePath = Join-Path $RepoRoot 'src\claude-commands.js'
    $commandArgs = @($modulePath, 'install', '--home', $HOME, '--source', $commandsSourceDir)
    if ($DryRun) {
        $commandArgs += '--dry-run'
    }
    $run = Invoke-Native -Command 'node' -CommandArgs $commandArgs
    foreach ($line in $run.Output) {
        Write-Note "$line"
    }
    if ($run.ExitCode -ne 0) {
        Write-Warn '斜杠命令安装失败（退出码非 0，不中断安装——重跑本脚本即可重试）'
        Write-Note "  或手工执行：把 $commandsSourceDir 下的受管命令文件拷到 ~\.claude\commands\"
    }
}

function Install-ViewerShims {
    # 观察窗启动器的「生成什么/放哪里」全部在 src/install-shims.js（唯一权威）；本步只调入口并转发输出。
    # 不随 claude CLI 缺失跳过：启动器与本机 shell 有关、与 Claude Code 无关。
    Write-Note '观察窗启动器：'
    $shimModulePath = Join-Path $RepoRoot 'src\install-shims.js'
    $shimArgs = @($shimModulePath, 'install', '--home', $HOME)
    if ($DryRun) {
        $shimArgs += '--dry-run'
    }
    $shimRun = Invoke-Native -Command 'node' -CommandArgs $shimArgs
    foreach ($line in $shimRun.Output) {
        Write-Note "$line"
    }
    if ($shimRun.ExitCode -ne 0) {
        Write-Warn '观察窗启动器安装失败（退出码非 0，不中断安装——重跑本脚本即可重试）'
        Write-Note '  或手工执行：node src\install-shims.js install --home <你的家目录>'
    }
}

function Invoke-SelfCheck {
    Write-Step '6/6' '自检'
    $problems = 0
    $entry = Join-Path $AppDir 'bin\waystation.js'
    if (Test-Path $entry) {
        Write-Note "入口就位：$entry"
    } else {
        Write-Warn "入口缺失：$entry"
        $problems++
    }
    $sdk = Join-Path $AppDir 'node_modules\@modelcontextprotocol\sdk\package.json'
    if (Test-Path $sdk) {
        Write-Note '运行依赖就位：@modelcontextprotocol/sdk'
    } else {
        Write-Warn "运行依赖缺失：$sdk"
        $problems++
    }
    if (Test-Path $ShimPath) {
        Write-Note "可执行就位：$ShimPath"
    } else {
        Write-Warn "可执行缺失：$ShimPath"
        $problems++
    }
    $statusline = Join-Path $AppDir 'scripts\statusline.js'
    if (Test-Path $statusline) {
        Write-Note "状态栏脚本就位：$statusline"
    } else {
        Write-Warn "状态栏脚本缺失：$statusline"
        $problems++
    }
    # 只核对源集合文件名就位（不判受管标记——标记判定属模块单一权威，不在脚本里复刻）
    if (Get-Command claude -ErrorAction SilentlyContinue) {
        $commandsSourceDir = Join-Path $RepoRoot 'scripts\claude-commands'
        foreach ($sourceFile in (Get-ChildItem -Path $commandsSourceDir -Filter '*.md' -File)) {
            $commandTarget = Join-Path (Join-Path $HOME '.claude\commands') $sourceFile.Name
            if (Test-Path $commandTarget) {
                Write-Note "斜杠命令就位：$($sourceFile.Name)"
            } else {
                Write-Warn "斜杠命令缺失：$commandTarget"
                $problems++
            }
        }
    } else {
        Write-Note '斜杠命令：跳过（未装 claude CLI）'
    }
    switch ($script:McpState) {
        'registered' { Write-Note 'MCP 注册：已写入（claude mcp add 退出码 0）' }
        'skipped' { Write-Note 'MCP 注册：跳过（未装 claude CLI；手工步骤见上）' }
        default { Write-Note "MCP 注册：$($script:McpState)" }
    }
    if ($problems -gt 0) {
        Write-Warn "自检有 $problems 项未通过——请先解决再进会话"
    } else {
        Write-Note '自检通过'
    }
}

function Show-FirewallGuidance {
    Write-Step '指引' '防火墙放行指引（只提示，不自动修改）'
    $profiles = $null
    try {
        $profiles = Get-NetFirewallProfile -ErrorAction Stop
    } catch {
        $profiles = $null
    }
    if ($profiles) {
        $anyEnabled = $false
        foreach ($p in $profiles) {
            $stateText = '已关闭'
            if ($p.Enabled) {
                $stateText = '已启用'
                $anyEnabled = $true
            }
            Write-Note "防火墙配置 $($p.Name)：$stateText"
        }
        if ($anyEnabled) {
            Write-Note '有启用的入站防火墙——通常需要以下放行规则（在管理员 PowerShell 中执行，示例）：'
        } else {
            Write-Note '当前各防火墙配置均未启用——无需放行规则；若日后开启，参考以下示例：'
        }
    } else {
        Write-Warn '无法读取防火墙状态（无 NetSecurity 模块或权限不足），请自行检查；放行规则参考如下：'
    }
    Write-Note "  New-NetFirewallRule -DisplayName 'waystation LAN (TCP)' -Direction Inbound -Action Allow -Protocol TCP -LocalPort $($script:AnchorPort) -Profile Any"
    Write-Note "  New-NetFirewallRule -DisplayName 'waystation LAN (UDP)' -Direction Inbound -Action Allow -Protocol UDP -LocalPort $($script:AnchorPort) -Profile Any"
    Write-Note "端口＝config.json 显式配置的 port，缺省为主根锚点 $($script:AnchorPort)（单核：无槽位段）；显式改过端口的站点按实际端口放行；-Profile 可按需收窄（如 Private）。"
    Write-Note '注：Windows 防火墙开启场景的规则形态尚未实测验收——若放行后仍互扫/投递不通，请回报。'
}

function Show-SessionChecklist {
    Write-Step '指引' '会话期首检清单（脚本期无法代验，需在 Claude Code 会话里做）'
    Write-Note '1) 新开一个会话（会话启动时拉起会话桥；驿站核心按需自动启动）'
    Write-Note '2) 查看 MCP 连接：会话里执行 /mcp，waystation 应显示已连接'
    Write-Note '3) 让 Claude 调用驿站工具：ws_status 应返回本站点状态；ws_list_hosts 应能扫到局域网在线站点；ws_list_collabs 应返回空清单（新装）——工具面共 27 项'
    Write-Note "4) 单核：同机多终端共用一个核心（不再按终端分配端口/槽位）；跨机互扫用同一端口（缺省锚点 $($script:AnchorPort)）"
    Write-Note '5) 两台机器互扫可见后，再按设计验收场景走「建立协作」流程'
    Write-Note "6)（可选）状态栏「协作中」指示：把 $AppDir\scripts\statusline.js 配为 statusLine 命令（见 README 状态栏节）；进入协作后应显示「协作中：⋯」"
    Write-Note '7) 身份名默认为机器名：首个会话会提示一次；可用数据目录 config.json 的 identityName 自定义（下次会话生效）'
    Write-Note '8) 升级（重跑本脚本覆盖安装）：升级后重开会话即自动换代（老核退场、新核启动）——推荐顺序「关全部旧会话 → 重装 → 重开」；升级期间避免新建会话 / 开观察窗（文件替换窗口）'
}

function Show-ClientSnippets {
    Write-Step '指引' '其他 MCP 客户端（stdio 形态，以 opencode 为例）'
    Write-Note '在 opencode 配置文件（opencode.json）的 mcp 段加入：'
    # 片段逐行拼装（路径折成正斜杠——直接手拼 "C:\Users\…" 在 JSON 里是非法转义（\U 等），
    # 且 \b 一类会把路径静默损坏）并回读 ConvertFrom-Json 自校验，未过则退单行形态
    $commandPath = ($AppDir -replace '\\', '/') + '/bin/waystation.js'
    $snippet = @(
        '  {',
        '    "mcp": {',
        '      "waystation": {',
        '        "type": "local",',
        ('        "command": ["node", "' + $commandPath + '"],'),
        '        "enabled": true',
        '      }',
        '    }',
        '  }'
    ) -join "`n"
    try {
        $null = $snippet | ConvertFrom-Json
    } catch {
        $snippet = '{"mcp":{"waystation":{"type":"local","command":["node","' + $commandPath + '"],"enabled":true}}}'
        Write-Warn 'MCP 客户端片段 JSON 自校验未过，已改用单行形态输出；请按文档手工填写。'
    }
    foreach ($line in ($snippet -split "`n")) {
        Write-Note "  $line"
    }
    Write-Note '字段：type=local 为本地进程型；command 为命令数组（示例 = node + 安装目录入口的绝对路径）；不同客户端字段名不同，按其文档对应填写。'
    Write-Note '（示例依据 opencode 官方文档 mcp-servers 页，2026-10-13 核对；客户端版本演进可能变化。）'
}

function Remove-ViewerShims {
    # 观察窗三件套（ws-view.cmd / ws-view.vbs / ~/.local/bin/ws-view）：移除规格与安装面同一权威
    # （src/install-shims.js 的 remove）；node 缺失或模块失败只提示手工删除，不中断卸载。
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
        Write-Warn '未找到 node——跳过观察窗启动器删除（不中断卸载）'
        Write-Note '手工删除：~\.waystation\bin\ws-view.cmd、~\.waystation\bin\ws-view.vbs、~\.local\bin\ws-view'
        return
    }
    $shimModulePath = Join-Path $RepoRoot 'src\install-shims.js'
    $shimArgs = @($shimModulePath, 'remove', '--home', $HOME)
    if ($DryRun) {
        $shimArgs += '--dry-run'
    }
    $shimRun = Invoke-Native -Command 'node' -CommandArgs $shimArgs
    foreach ($line in $shimRun.Output) {
        Write-Note "$line"
    }
    if ($shimRun.ExitCode -ne 0) {
        Write-Warn '观察窗启动器删除失败（不中断卸载）'
        Write-Note '手工删除：~\.waystation\bin\ws-view.cmd、~\.waystation\bin\ws-view.vbs、~\.local\bin\ws-view'
    }
}

function Resolve-StopEntry {
    # 停核入口按「脚本自身树优先」解析（沿本脚本 claude-commands / install-shims 调用的同一先例）：
    # 安装副本可能是旧版、不理解 core 子命令——会把整套服务误拉起（交互下挂起；stdin EOF 下假成功，
    # 恰是「旧驿站仍持有已删目录」的假绿）。两处都找不到时返回空串（调用方按跳过＋告警处置）。
    $repoEntry = Join-Path $RepoRoot 'bin\waystation.js'
    if (Test-Path $repoEntry) {
        return $repoEntry
    }
    $appEntry = Join-Path $AppDir 'bin\waystation.js'
    if (Test-Path $appEntry) {
        return $appEntry
    }
    return ''
}

function Invoke-StopCoreEntry([string]$Entry) {
    # 经 .NET Process 调用：stdin 立即关闭（＝ sh 臂的 </dev/null，不给误拉服务的入口留交互读流）；
    # 30s 未退即强杀并按失败处置——停核失败＝拒绝卸载，绝不假绿。
    $info = New-Object System.Diagnostics.ProcessStartInfo
    $info.FileName = 'node'
    $info.Arguments = "`"$Entry`" core stop"
    $info.UseShellExecute = $false
    $info.RedirectStandardInput = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $proc = [System.Diagnostics.Process]::Start($info)
    $proc.StandardInput.Close()
    $timedOut = -not $proc.WaitForExit(30000)
    if ($timedOut) {
        $proc.Kill()
        $proc.WaitForExit()
    }
    $text = $proc.StandardOutput.ReadToEnd() + $proc.StandardError.ReadToEnd()
    $lines = @($text -split "`r?`n" | Where-Object { $_ -ne '' })
    return [pscustomobject]@{ ExitCode = $proc.ExitCode; TimedOut = $timedOut; Output = $lines }
}

function Stop-CoreForUninstall {
    # 先停核心再删文件：残留 detached 核心会持有已删目录（与观察窗启动器残留同族）。
    # 停核判据全在 CLI 模块（src/core-cli.js，唯一权威）——本步骤只调入口并按退出码决定去留；
    # node 缺失时无法停核（核心也是 node 进程，无 node 时先人工处理）。
    # 范围边界：只管单核形态的核心；升级窗口里旧版「每会话站点」进程不在本步骤内。
    Write-Step '1/6' '停止核心'
    if ($DryRun) {
        Write-Note '将停止核心（若在运行）：node <脚本树入口> core stop（无核心时跳过；核心拒绝停止时将拒绝卸载）'
        Write-Note '（范围＝单核形态；旧版「每会话站点」进程请先关闭旧会话）'
        return
    }
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
        Write-Warn '未找到 node——跳过自动停止核心；若有核心在跑，请先手动执行 waystation core stop 后重跑本脚本'
        return
    }
    $entry = Resolve-StopEntry
    if ($entry -eq '') {
        Write-Warn "找不到停核入口（$(Join-Path $RepoRoot 'bin\waystation.js')）；跳过自动停止核心"
        return
    }
    $stopRun = Invoke-StopCoreEntry -Entry $entry
    foreach ($line in $stopRun.Output) {
        Write-Note "$line"
    }
    if ($stopRun.TimedOut) {
        Fail '停核调用超时（30s 未返回）——核心可能仍在运行；请人工处理（waystation core stop --force）后重跑卸载'
    }
    if ($stopRun.ExitCode -ne 0) {
        Fail '核心拒绝停止（原因见上）——请先处理（waystation core stop --force 可强制处理）后重跑卸载；未做任何改动'
    }
}

function Invoke-Uninstall {
    if ($DryRun) {
        Write-Say '=== waystation 卸载（dry-run：只打印，不改动）==='
    } else {
        Write-Say '=== waystation 卸载 ==='
    }

    Stop-CoreForUninstall

    Write-Step '2/6' '注销 MCP 注册'
    if ($DryRun) {
        Write-Note '将执行：claude mcp remove -s user waystation（未注册时该命令报错，属预期；未安装 claude CLI 时改为提示手工步骤）'
    } elseif (Get-Command claude -ErrorAction SilentlyContinue) {
        $removeRun = Invoke-Native -Command 'claude' -CommandArgs @('mcp', 'remove', '-s', 'user', 'waystation')
        if ($removeRun.ExitCode -eq 0) {
            Write-Note '已注销：waystation'
        } else {
            Write-Note "未注销（多为本来就没注册）：$(($removeRun.Output | Select-Object -First 1))"
        }
    } else {
        Write-Note '未找到 claude CLI；如以后需要，可手工执行：claude mcp remove -s user waystation'
    }

    # 只删受管文件（标记判定在 src/claude-commands.js 模块内）；node 缺失或入口失败只提示手工删除，不中断卸载
    Write-Step '3/6' '删除斜杠命令'
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
        Write-Warn '未找到 node——跳过自动删除（不中断卸载）'
        Write-Note '手工删除：删除 ~\.claude\commands\ 下带 <!-- waystation-managed-command --> 标记的文件'
    } else {
        $modulePath = Join-Path $RepoRoot 'src\claude-commands.js'
        $commandArgs = @($modulePath, 'remove', '--home', $HOME)
        if ($DryRun) {
            $commandArgs += '--dry-run'
        }
        $run = Invoke-Native -Command 'node' -CommandArgs $commandArgs
        foreach ($line in $run.Output) {
            Write-Note "$line"
        }
        if ($run.ExitCode -ne 0) {
            Write-Warn '斜杠命令删除失败（不中断卸载）'
            Write-Note '手工删除：删除 ~\.claude\commands\ 下带 <!-- waystation-managed-command --> 标记的文件'
        }
    }

    Write-Step '4/6' '删除可执行'
    if ($DryRun) {
        Write-Note "将删除：$ShimPath"
    } elseif (Test-Path $ShimPath) {
        Remove-Item -Force $ShimPath
        Write-Note "已删除：$ShimPath"
    } else {
        Write-Note "不存在，跳过：$ShimPath"
    }
    Remove-ViewerShims

    Write-Step '5/6' '删除安装目录'
    if ($DryRun) {
        Write-Note "将删除：$AppDir"
    } elseif (Test-Path $AppDir) {
        Remove-Item -Recurse -Force $AppDir
        Write-Note "已删除：$AppDir"
    } else {
        Write-Note "不存在，跳过：$AppDir"
    }

    Write-Step '6/6' '数据目录'
    if ($PurgeData) {
        # 数据目录位置由 HOME 派生、不接受参数覆盖——这才是防护的真正来源；本守卫只作纵深防御
        if ((Split-Path -Leaf $DataDir) -ne '.waystation') {
            Fail "数据目录路径异常，拒绝删除：$DataDir"
        }
        if ($DryRun) {
            Write-Note "将删除：$DataDir（含全部协作数据）"
        } elseif (Test-Path $DataDir) {
            Remove-Item -Recurse -Force $DataDir
            Write-Note "已删除：$DataDir（含全部协作数据）"
        } else {
            Write-Note "不存在，跳过：$DataDir"
        }
    } else {
        Write-Note "按默认保留（含协作数据）：$DataDir"
        Write-Note '如确认不再需要，加 -PurgeData 重跑卸载即可删除'
    }

    if ($DryRun) {
        Write-Say "`n（dry-run 结束：未改动任何文件或系统设置）"
    } else {
        Write-Say "`n卸载完成。"
    }
}

if ($PurgeData -and -not $Uninstall) {
    Fail '-PurgeData 只在 -Uninstall 下生效（防止误删数据目录）'
}

if ($Uninstall) {
    Invoke-Uninstall
    exit 0
}

if ($DryRun) {
    Write-Say '=== waystation 安装（dry-run：只做只读检测并打印将执行的动作，不改动任何文件或系统设置）==='
} else {
    Write-Say '=== waystation 安装 ==='
}

Assert-RepoTree

Write-Step '1/6' '环境检测'
Assert-Node
Read-PortAnchor
Test-PortAvailability

Install-Files
Install-Shim
Register-Mcp
Install-ClaudeCommands
Install-ViewerShims
if ($DryRun) {
    Write-Note '（dry-run：自检从略——真实运行时将核对入口、运行依赖、可执行、状态栏脚本、斜杠命令与 MCP 注册六项）'
} else {
    Invoke-SelfCheck
}

Show-FirewallGuidance
Show-SessionChecklist
Show-ClientSnippets

if ($DryRun) {
    Write-Say "`n（dry-run 结束：以上为将执行的动作清单与指引；未改动任何文件或系统设置）"
} else {
    Write-Say "`n安装完成。下一步：按上方指引放行防火墙（如需要），然后到 Claude Code 会话里做首检。"
    Write-Say '提示：刚安装或升级过 Node 时，请重启 Claude Code 与终端让 PATH 生效，再进会话首检。'
}
