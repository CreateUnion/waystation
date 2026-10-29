#!/usr/bin/env bash
# waystation 安装脚本（Linux）。
#
# 流程（与设计「安装与配置」节一致）：
#   1) 检测 Node（下限实读 package.json 的 engines；缺失时给安装指引，不静默安装）
#   2) 拷贝运行所需文件到 ~/.waystation/app/ 并用 npm ci --omit=dev 就位依赖
#   3) 放置可执行到 ~/.local/bin/waystation（符号链接到安装目录的入口）
#   4) 注册 Claude Code MCP（未装 claude CLI 时打印手工步骤、不视为失败）
#   5) 安装斜杠命令到 ~/.claude/commands/（未装 claude CLI 时打印手工步骤、不视为失败）
#   6) 自检 + 打印防火墙放行指引与会话期首检清单
#
# 特性与边界：
#   - 幂等：重复运行安全（重新拷贝、重装依赖、重新注册）。
#   - --dry-run：只做只读检测并打印将执行的动作，不改动任何文件或系统设置。
#   - 防火墙只打印指引、绝不自动修改。
#   - 卸载：--uninstall（先停核心，再注销 MCP、删斜杠命令、删安装目录与可执行；核心拒绝
#     停止时拒绝卸载并提示）；数据目录默认保留，加 --purge-data 才连数据目录一起删。
#     「waystation uninstall」命令（驿站本体提供：停核 + 注销注册 + 清理 + 数据可选保留）
#     在默认布局下与之等价可选——已装驿站二选一即可；
#     自定义 WAYSTATION_HOME 时以该命令为准（本脚本不读该变量）。
#   - macOS 暂不在支持范围（随公开发布补齐）。
#
# 用法：
#   bash scripts/install.sh                            安装（重复运行安全）
#   bash scripts/install.sh --dry-run                  预览：只检测与打印
#   bash scripts/install.sh --uninstall                卸载（保留数据目录）
#   bash scripts/install.sh --uninstall --purge-data   卸载并删除数据目录

set -eu

DATA_DIR="${HOME}/.waystation"
APP_DIR="${DATA_DIR}/app"
BIN_DIR="${HOME}/.local/bin"
SHIM_PATH="${BIN_DIR}/waystation"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

DRY_RUN=0
UNINSTALL=0
PURGE_DATA=0

ANCHOR_PORT=7321        # 下方 read_port_anchor 会从源码实读覆盖；此处兜底值仅为变量初始化
ANCHOR_FALLBACK=0
PORT_PROBE_OUTPUT=""
TCP_STATE="unknown"
UDP_STATE="unknown"
MCP_TARGET=""
MCP_STATE="pending"
FIREWALL_STATE="unknown"

say() { printf '%s\n' "$*"; }
step() { printf '\n[%s] %s\n' "$1" "$2"; }
note() { printf '    %s\n' "$*"; }
warn() { printf '  ！%s\n' "$*"; }
fail() { printf '\n错误：%s\n' "$*" >&2; exit 1; }
note_lines() {
  # 把斜杠命令模块的 stdout 行按 note 缩进口径逐行转发（空行不打印）
  local line=""
  while IFS= read -r line; do
    if [ -n "$line" ]; then
      note "$line"
    fi
  done <<< "$1"
}

usage() {
  cat <<'EOF'
waystation 安装脚本（Linux）

用法：
  bash scripts/install.sh                            安装（幂等，可重复运行）
  bash scripts/install.sh --dry-run                  预览：只做只读检测并打印将执行的动作
  bash scripts/install.sh --uninstall                卸载（先停核心，再注销 MCP、删斜杠命令、删安装目录与可执行；保留数据目录）
  bash scripts/install.sh --uninstall --purge-data   卸载并删除数据目录（含全部协作数据）
  bash scripts/install.sh --help                     显示本帮助

脚本不会自动安装 Node，也不修改防火墙；缺失/需要放行时只打印指引。
（另有 `waystation uninstall [--purge-data]` 命令，由驿站本体提供：默认布局下与脚本开关等价；
自定义 WAYSTATION_HOME 时以该命令为准——本脚本不读该变量。）
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --uninstall) UNINSTALL=1 ;;
    --purge-data) PURGE_DATA=1 ;;
    -h|--help) usage; exit 0 ;;
    *) fail "未知参数：$1（用 --help 查看用法）" ;;
  esac
  shift
done

if [ "$PURGE_DATA" = 1 ] && [ "$UNINSTALL" != 1 ]; then
  fail "--purge-data 只在 --uninstall 下生效（防止误删数据目录）"
fi

# ---- 只读检测 --------------------------------------------------------------

check_repo_tree() {
  [ -f "${REPO_ROOT}/package.json" ] || fail "本脚本需在仓库内运行：找不到 ${REPO_ROOT}/package.json"
  [ -f "${REPO_ROOT}/package-lock.json" ] || fail "找不到 ${REPO_ROOT}/package-lock.json（依赖就位需要它）"
  [ -f "${REPO_ROOT}/bin/waystation.js" ] || fail "找不到 ${REPO_ROOT}/bin/waystation.js"
  [ -d "${REPO_ROOT}/src" ] || fail "找不到 ${REPO_ROOT}/src"
  [ -d "${REPO_ROOT}/scripts/claude-commands" ] || fail "找不到 ${REPO_ROOT}/scripts/claude-commands"
}

read_engines_node() {
  node -e '
    const fs = require("fs");
    const pkg = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    process.stdout.write((pkg.engines && pkg.engines.node) || "");
  ' "$1"
}

check_node() {
  command -v node >/dev/null 2>&1 || fail "未找到 node。请先安装 Node.js（https://nodejs.org 或发行版包管理器），安装后重跑本脚本。本脚本不会自动安装 Node。"
  NODE_VERSION="$(node -v)" || fail "node -v 执行失败——Node 安装可能损坏，请修复后重跑。"
  REQUIRED_ENGINES="$(read_engines_node "${REPO_ROOT}/package.json" || true)"
  [ -n "$REQUIRED_ENGINES" ] || fail "无法从 package.json 读取 engines.node，不能核对 Node 下限"
  REQUIRED_MAJOR="$(printf '%s' "$REQUIRED_ENGINES" | grep -oE '[0-9]+' | head -n 1 || true)"
  [ -n "$REQUIRED_MAJOR" ] || fail "无法解析 engines.node 的版本下限：${REQUIRED_ENGINES}"
  CURRENT_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
  if [ "$CURRENT_MAJOR" -lt "$REQUIRED_MAJOR" ]; then
    fail "Node 版本过低：当前 ${NODE_VERSION}，要求 ${REQUIRED_ENGINES}（实读自 package.json engines）。请升级 Node 后重跑。"
  fi
  note "Node：${NODE_VERSION}（要求 ${REQUIRED_ENGINES}，实读自 package.json）"
  if command -v npm >/dev/null 2>&1; then
    note "npm：$(npm -v)"
  else
    warn "未找到 npm——依赖就位将失败；请安装随 Node 附带的 npm"
  fi
  if command -v claude >/dev/null 2>&1; then
    note "claude CLI：已找到（将自动注册 MCP）"
  else
    note "claude CLI：未找到（跳过自动注册，改打印手工步骤）"
  fi
}

read_port_anchor() {
  # 端口锚点的唯一权威源是 src/site.js 的导出常量——实读以免脚本里的副本漂移；读不到时退回
  # 内置默认值并在输出里明示（不改脚本行为，只影响打印的指引数字）。单核口径：端口＝config.json
  # 显式值或锚点、无槽位段（槽位已退役，脚本不再读 SLOT_COUNT）。
  local site_file="${REPO_ROOT}/src/site.js"
  local anchor=""
  if [ -f "$site_file" ]; then
    anchor="$(grep -oE 'export const ANCHOR_PORT = [0-9]+' "$site_file" 2>/dev/null | grep -oE '[0-9]+' | head -n 1 || true)"
  fi
  if [ -n "$anchor" ]; then
    ANCHOR_PORT="$anchor"
  else
    ANCHOR_FALLBACK=1
  fi
}

probe_port() {
  # 只读探测：绑定本机全接口的 TCP 与 UDP 同号端口后立刻释放（不改变系统状态）
  node -e '
    const net = require("net");
    const dgram = require("dgram");
    const port = Number(process.argv[1]);
    const tcp = net.createServer();
    tcp.once("error", () => { report("tcp", false); probeUdp(); });
    tcp.listen(port, "0.0.0.0", () => { tcp.close(() => { report("tcp", true); probeUdp(); }); });
    function probeUdp() {
      const udp = dgram.createSocket("udp4");
      udp.once("error", () => { report("udp", false); });
      udp.bind(port, "0.0.0.0", () => { udp.close(() => report("udp", true)); });
    }
    function report(kind, free) { console.log(kind + "=" + (free ? "free" : "occupied")); }
  ' "$1" 2>/dev/null || printf 'tcp=unknown\nudp=unknown\n'
}

check_port() {
  PORT_PROBE_OUTPUT="$(probe_port "$ANCHOR_PORT" || true)"
  TCP_STATE="$(printf '%s\n' "$PORT_PROBE_OUTPUT" | grep '^tcp=' | cut -d= -f2)"
  UDP_STATE="$(printf '%s\n' "$PORT_PROBE_OUTPUT" | grep '^udp=' | cut -d= -f2)"
  [ -n "$TCP_STATE" ] || TCP_STATE="unknown"
  [ -n "$UDP_STATE" ] || UDP_STATE="unknown"
  if [ "$TCP_STATE" = "free" ] && [ "$UDP_STATE" = "free" ]; then
    note "锚点端口 ${ANCHOR_PORT}（TCP+UDP）：当前可绑（未显式配置端口时核心用此端口）"
  elif [ "$TCP_STATE" = "occupied" ] && [ "$UDP_STATE" = "occupied" ]; then
    note "锚点端口 ${ANCHOR_PORT}（TCP+UDP）：已被占用——若本机核心在跑属正常；否则核心启动时会按端口规程处理（占用者分类：降级服务或等待接管）"
  else
    note "锚点端口 ${ANCHOR_PORT}：TCP=${TCP_STATE}、UDP=${UDP_STATE}——核心启动时会按端口规程处理"
  fi
  note "单核端口口径：config.json 显式配置的 port 优先，未配时主根用锚点 ${ANCHOR_PORT}；无槽位段（显式多根须各自配端口）"
  if [ "$ANCHOR_FALLBACK" = 1 ]; then
    warn "未能从 src/site.js 读取端口锚点，以上按内置默认值（${ANCHOR_PORT}）打印"
  fi
}

# ---- 安装 ------------------------------------------------------------------

install_files() {
  step "2/6" "安装运行文件到 ${APP_DIR}"
  if [ "$DRY_RUN" = 1 ]; then
    note "将清理并重新拷贝：bin/ src/ scripts/statusline.js scripts/ws-viewer.js package.json package-lock.json"
    note "将在安装目录执行：npm ci --omit=dev --no-audit --no-fund"
    return 0
  fi
  mkdir -p "$APP_DIR"
  rm -rf "${APP_DIR:?}/bin" "${APP_DIR:?}/src" "${APP_DIR:?}/scripts"
  cp -R "${REPO_ROOT}/bin" "${APP_DIR}/bin"
  cp -R "${REPO_ROOT}/src" "${APP_DIR}/src"
  mkdir -p "${APP_DIR}/scripts"
  cp "${REPO_ROOT}/scripts/statusline.js" "${APP_DIR}/scripts/statusline.js"
  cp "${REPO_ROOT}/scripts/ws-viewer.js" "${APP_DIR}/scripts/ws-viewer.js"
  cp "${REPO_ROOT}/package.json" "${APP_DIR}/package.json"
  cp "${REPO_ROOT}/package-lock.json" "${APP_DIR}/package-lock.json"
  chmod +x "${APP_DIR}/bin/waystation.js"
  command -v npm >/dev/null 2>&1 || fail "未找到 npm（Node 通常随附 npm）；可在安装目录手动执行：cd ${APP_DIR} && npm ci --omit=dev"
  ( cd "$APP_DIR" && npm ci --omit=dev --no-audit --no-fund ) \
    || fail "依赖安装失败（npm ci）。离线环境可在有网络的机器上执行 npm ci 后整体拷贝 node_modules；或在本机手动执行：cd ${APP_DIR} && npm ci --omit=dev"
  note "已安装：${APP_DIR}"
}

place_executable() {
  step "3/6" "放置可执行：${SHIM_PATH}"
  if [ "$DRY_RUN" = 1 ]; then
    note "将创建目录 ${BIN_DIR} 并建立符号链接：${SHIM_PATH} -> ${APP_DIR}/bin/waystation.js"
    return 0
  fi
  mkdir -p "$BIN_DIR"
  ln -sf "${APP_DIR}/bin/waystation.js" "$SHIM_PATH"
  note "已放置：${SHIM_PATH}"
  case ":${PATH}:" in
    *":${BIN_DIR}:"*)
      note "${BIN_DIR} 已在 PATH 中"
      ;;
    *)
      warn "${BIN_DIR} 不在当前 PATH 中；MCP 注册将改用绝对路径（效果相同）"
      note "若还想在终端里直接敲 waystation：在 ~/.profile 加一行 export PATH=\"\$HOME/.local/bin:\$PATH\"，重新登录后生效"
      ;;
  esac
}

register_mcp() {
  step "4/6" "注册 Claude Code MCP（claude mcp add -s user waystation -- ...）"
  # 注册目标 = PATH 上的可执行名，不在 PATH 时退化为绝对路径；两者都是 shebang 脚本，POSIX 下可直接 spawn
  case ":${PATH}:" in
    *":${BIN_DIR}:"*) MCP_TARGET="waystation" ;;
    *) MCP_TARGET="${SHIM_PATH}" ;;
  esac
  if ! command -v claude >/dev/null 2>&1; then
    MCP_STATE="skipped"
    if [ "$DRY_RUN" = 1 ]; then
      note "未找到 claude CLI——真实运行时将跳过自动注册（不视为失败）并打印手工步骤"
    else
      note "未找到 claude CLI——跳过自动注册（不影响安装的其他部分；其他 MCP 客户端同理，按 stdio 配置命令即可）"
    fi
    note "手工步骤（安装 Claude Code 后执行）："
    note "  claude mcp add -s user waystation -- ${MCP_TARGET}"
    return 0
  fi
  if [ "$DRY_RUN" = 1 ]; then
    note "将执行（幂等序列）："
    note "  claude mcp remove -s user waystation   （先清旧注册；未注册时该命令报错，属预期、忽略）"
    note "  claude mcp add -s user waystation -- ${MCP_TARGET}"
    MCP_STATE="dry-run"
    return 0
  fi
  # 同名重复 add 会被 claude CLI 拒绝（already exists），故先静默注销再注册来保证可重跑
  claude mcp remove -s user waystation >/dev/null 2>&1 || true
  if claude mcp add -s user waystation -- "$MCP_TARGET"; then
    MCP_STATE="registered"
    note "注册完成：waystation -> ${MCP_TARGET}"
    note "（此处只写入注册配置；连接与工具可用性在首次会话里用 /mcp 查看——本脚本不做会拉起服务器进程的健康检查）"
  else
    MCP_STATE="failed"
    fail "claude mcp add 失败（注册目标：${MCP_TARGET}）。可手动执行同一命令查看原因；或先跳过注册继续安装（重复本脚本即可重试）"
  fi
}

install_claude_commands() {
  # 受管命令的「哪些文件/怎么判定」全部在 src/claude-commands.js（唯一权威）；本步只调入口并转发输出
  step "5/6" "安装斜杠命令到 ~/.claude/commands/"
  local source_dir="${REPO_ROOT}/scripts/claude-commands"
  if ! command -v claude >/dev/null 2>&1; then
    if [ "$DRY_RUN" = 1 ]; then
      note "未找到 claude CLI——真实运行时将跳过安装（不视为失败）并打印手工步骤"
    else
      note "未找到 claude CLI——跳过安装（不影响安装的其他部分）"
    fi
    note "手工步骤（安装 Claude Code 后执行）："
    note "  把 ${source_dir}/ 下的受管命令文件拷到 ~/.claude/commands/"
    return 0
  fi
  local args=(install --home "$HOME" --source "$source_dir")
  if [ "$DRY_RUN" = 1 ]; then
    args+=(--dry-run)
  fi
  local output=""
  if output="$(node "${REPO_ROOT}/src/claude-commands.js" "${args[@]}" 2>&1)"; then
    note_lines "$output"
  else
    note_lines "$output"
    warn "斜杠命令安装失败（退出码非 0，不中断安装——重跑本脚本即可重试）"
    note "  或手工执行：把 ${source_dir}/ 下的受管命令文件拷到 ~/.claude/commands/"
  fi
}

install_viewer_shims() {
  # 观察窗启动器的「生成什么/放哪里」全部在 src/install-shims.js（唯一权威）；本步只调入口并转发输出。
  # 不随 claude CLI 缺失跳过：启动器与本机 shell 有关、与 Claude Code 无关。
  note "观察窗启动器："
  local args=(install --home "$HOME")
  if [ "$DRY_RUN" = 1 ]; then
    args+=(--dry-run)
  fi
  local output=""
  if output="$(node "${REPO_ROOT}/src/install-shims.js" "${args[@]}" 2>&1)"; then
    note_lines "$output"
  else
    note_lines "$output"
    warn "观察窗启动器安装失败（退出码非 0，不中断安装——重跑本脚本即可重试）"
    note "  或手工执行：node src/install-shims.js install --home <你的家目录>"
  fi
}

self_check() {
  step "6/6" "自检"
  local problems=0
  if [ -f "${APP_DIR}/bin/waystation.js" ]; then
    note "入口就位：${APP_DIR}/bin/waystation.js"
  else
    warn "入口缺失：${APP_DIR}/bin/waystation.js"
    problems=$((problems + 1))
  fi
  if [ -f "${APP_DIR}/node_modules/@modelcontextprotocol/sdk/package.json" ]; then
    note "运行依赖就位：@modelcontextprotocol/sdk"
  else
    warn "运行依赖缺失：${APP_DIR}/node_modules/@modelcontextprotocol/sdk"
    problems=$((problems + 1))
  fi
  if [ -x "$SHIM_PATH" ]; then
    note "可执行就位且可执行：${SHIM_PATH}"
  elif [ -e "$SHIM_PATH" ]; then
    warn "可执行存在但不可执行：${SHIM_PATH}"
    problems=$((problems + 1))
  else
    warn "可执行缺失：${SHIM_PATH}"
    problems=$((problems + 1))
  fi
  if [ -f "${APP_DIR}/scripts/statusline.js" ]; then
    note "状态栏脚本就位：${APP_DIR}/scripts/statusline.js"
  else
    warn "状态栏脚本缺失：${APP_DIR}/scripts/statusline.js"
    problems=$((problems + 1))
  fi
  # 只核对源集合文件名就位（不判受管标记——标记判定属模块单一权威，不在脚本里复刻）
  local cmd_src="" cmd_name=""
  if command -v claude >/dev/null 2>&1; then
    for cmd_src in "${REPO_ROOT}"/scripts/claude-commands/*.md; do
      # 源目录为空时 glob 保留字面量 *.md，跳过以免把通配符当文件名误报（与 ps1 臂的 -Filter 零迭代对齐）
      [ -e "$cmd_src" ] || continue
      cmd_name="$(basename "$cmd_src")"
      if [ -f "${HOME}/.claude/commands/${cmd_name}" ]; then
        note "斜杠命令就位：${cmd_name}"
      else
        warn "斜杠命令缺失：${HOME}/.claude/commands/${cmd_name}"
        problems=$((problems + 1))
      fi
    done
  else
    note "斜杠命令：跳过（未装 claude CLI）"
  fi
  case "$MCP_STATE" in
    registered) note "MCP 注册：已写入（claude mcp add 退出码 0）" ;;
    skipped) note "MCP 注册：跳过（未装 claude CLI；手工步骤见上）" ;;
    *) note "MCP 注册：${MCP_STATE}" ;;
  esac
  if [ "$problems" -gt 0 ]; then
    warn "自检有 ${problems} 项未通过——请先解决再进会话"
  else
    note "自检通过"
  fi
}

# ---- 指引 ------------------------------------------------------------------

detect_firewall_state() {
  # 免 root 的只读检测：ufw 的启用态看配置文件（ufw status 需要 root，非 root 必失败）；
  # firewalld 看服务运行态；都判读不了按 unknown——只影响提示文案，绝不修改任何规则。
  FIREWALL_STATE="unknown"
  if [ -r /etc/ufw/ufw.conf ]; then
    enabled_line="$(grep -E '^ENABLED=' /etc/ufw/ufw.conf 2>/dev/null || true)"
    case "$enabled_line" in
      *yes*) FIREWALL_STATE="ufw-active" ;;
      *no*) FIREWALL_STATE="ufw-inactive" ;;
      *) FIREWALL_STATE="ufw-unknown" ;;
    esac
    return 0
  fi
  if command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet firewalld 2>/dev/null; then
    FIREWALL_STATE="firewalld-active"
    return 0
  fi
  if command -v ufw >/dev/null 2>&1 || command -v firewall-cmd >/dev/null 2>&1; then
    FIREWALL_STATE="firewall-present-unknown"
  fi
}

show_firewall_guidance() {
  step "指引" "防火墙放行指引（只提示，不自动修改）"
  detect_firewall_state
  case "$FIREWALL_STATE" in
    ufw-active) note "检测到 ufw 已启用（/etc/ufw/ufw.conf：ENABLED=yes）——需要以下放行：" ;;
    ufw-inactive) note "检测到 ufw 已安装但未启用（ENABLED=no）——当前无需放行；若日后启用，参考如下：" ;;
    firewalld-active) note "检测到 firewalld 正在运行——请做等效放行：" ;;
    *) note "未检测到可判读的防火墙状态（ufw / firewalld 均不可判读）——请自行确认；放行参考如下：" ;;
  esac
  note "驿站需要入站 TCP 与 UDP 同号端口（发现走 UDP、消息走 TCP）——端口＝config.json 显式配置的 port，缺省为主根锚点 ${ANCHOR_PORT}（单核：无槽位段）；显式改过端口的站点按实际端口放行。"
  note "使用 ufw（Ubuntu/Debian 等）："
  note "  sudo ufw allow ${ANCHOR_PORT}/tcp"
  note "  sudo ufw allow ${ANCHOR_PORT}/udp"
  note "使用 firewalld（示例）："
  note "  sudo firewall-cmd --permanent --add-port=${ANCHOR_PORT}/tcp"
  note "  sudo firewall-cmd --permanent --add-port=${ANCHOR_PORT}/udp && sudo firewall-cmd --reload"
  note "nftables 等直配置场景请做等效放行。"
  note "出站方向默认放行即可，无需额外规则。"
}

show_session_checklist() {
  step "指引" "会话期首检清单（脚本期无法代验，需在 Claude Code 会话里做）"
  note "1) 新开一个会话（会话启动时拉起会话桥；驿站核心按需自动启动）"
  note "2) 查看 MCP 连接：会话里执行 /mcp，waystation 应显示已连接"
  note "3) 让 Claude 调用驿站工具：ws_status 应返回本站点状态；ws_list_hosts 应能扫到局域网在线站点；ws_list_collabs 应返回空清单（新装）——工具面共 23 项"
  note "4) 单核：同机多终端共用一个核心（不再按终端分配端口/槽位）；跨机互扫用同一端口（缺省锚点 ${ANCHOR_PORT}）"
  note "5) 两台机器互扫可见后，再按设计验收场景走「建立协作」流程"
  note "6)（可选）状态栏「协作中」指示：把 ${APP_DIR}/scripts/statusline.js 配为 statusLine 命令（见 README 状态栏节）；进入协作后应显示「协作中：⋯」"
  note "7) 身份名默认为机器名：首个会话会提示一次；可用数据目录 config.json 的 identityName 自定义（下次会话生效）"
  note "8) 升级（重跑本脚本覆盖安装）：升级后重开会话即自动换代（老核退场、新核启动）——推荐顺序「关全部旧会话 → 重装 → 重开」；升级期间避免新建会话 / 开观察窗（文件替换窗口）"
}

show_client_snippets() {
  step "指引" "其他 MCP 客户端（stdio 形态，以 opencode 为例）"
  note "在 opencode 配置文件（opencode.json）的 mcp 段加入："
  note "  {"
  note "    \"mcp\": {"
  note "      \"waystation\": {"
  note "        \"type\": \"local\","
  note "        \"command\": [\"node\", \"${APP_DIR}/bin/waystation.js\"],"
  note "        \"enabled\": true"
  note "      }"
  note "    }"
  note "  }"
  note "字段：type=local 为本地进程型；command 为命令数组（示例 = node + 安装目录入口的绝对路径）；不同客户端字段名不同，按其文档对应填写。"
  note "（示例依据 opencode 官方文档 mcp-servers 页，2026-10-13 核对；客户端版本演进可能变化。）"
}

# ---- 卸载 ------------------------------------------------------------------

run_stop_entry() {
  # stdin 接 /dev/null（不给「误把子命令当服务拉起」的入口留交互读流的机会）；有 timeout 就加 30s 上限
  # （124＝超时，由调用方按失败处置——停核失败＝拒绝卸载，绝不假绿）。
  if command -v timeout >/dev/null 2>&1; then
    timeout 30 node "$1" core stop </dev/null
  else
    node "$1" core stop </dev/null
  fi
}

stop_core_for_uninstall() {
  # 先停核心再删文件：残留 detached 核心会持有已删目录（与观察窗启动器残留同族）。
  # 入口按「脚本自身树优先」解析（沿本文件 claude-commands / install-shims 调用的同一先例）：
  # 安装副本可能是旧版、不理解 core 子命令——会把整套服务误拉起（交互下挂起；stdin EOF 下假成功，
  # 恰是「旧驿站仍持有已删目录」的假绿）。停核判据全在 CLI 模块（src/core-cli.js，唯一权威）。
  # 范围边界：只管单核形态的核心；升级窗口里旧版「每会话站点」进程不在本步骤内。
  step "1/6" "停止核心"
  if [ "$DRY_RUN" = 1 ]; then
    note "将停止核心（若在运行）：node <脚本树入口> core stop（无核心时跳过；核心拒绝停止时将拒绝卸载）"
    note "（范围＝单核形态；旧版「每会话站点」进程请先关闭旧会话）"
    return 0
  fi
  if ! command -v node >/dev/null 2>&1; then
    warn "未找到 node——跳过自动停止核心；若有核心在跑，请先手动执行 waystation core stop 后重跑本脚本"
    return 0
  fi
  local entry="${REPO_ROOT}/bin/waystation.js"
  [ -f "$entry" ] || entry="${APP_DIR}/bin/waystation.js"
  if [ ! -f "$entry" ]; then
    warn "找不到停核入口（${REPO_ROOT}/bin/waystation.js）；跳过自动停止核心"
    return 0
  fi
  local output=""
  local exit_code=0
  output="$(run_stop_entry "$entry" 2>&1)" || exit_code=$?
  note_lines "$output"
  if [ "$exit_code" -eq 124 ]; then
    fail "停核调用超时（30s 未返回）——核心可能仍在运行；请人工处理（waystation core stop --force）后重跑卸载"
  fi
  if [ "$exit_code" -ne 0 ]; then
    fail "核心拒绝停止（原因见上）——请先处理（waystation core stop --force 可强制处理）后重跑卸载；未做任何改动"
  fi
}

remove_claude_commands() {
  # 只删受管文件（标记判定在 src/claude-commands.js 模块内）；node 缺失或入口失败只提示手工删除，不中断卸载
  step "3/6" "删除斜杠命令"
  if ! command -v node >/dev/null 2>&1; then
    warn "未找到 node——跳过自动删除（不中断卸载）"
    note "手工删除：删除 ~/.claude/commands/ 下带 <!-- waystation-managed-command --> 标记的文件"
    return 0
  fi
  local args=(remove --home "$HOME")
  if [ "$DRY_RUN" = 1 ]; then
    args+=(--dry-run)
  fi
  local output=""
  if output="$(node "${REPO_ROOT}/src/claude-commands.js" "${args[@]}" 2>&1)"; then
    note_lines "$output"
  else
    note_lines "$output"
    warn "斜杠命令删除失败（不中断卸载）"
    note "手工删除：删除 ~/.claude/commands/ 下带 <!-- waystation-managed-command --> 标记的文件"
  fi
}

remove_viewer_shims() {
  # 观察窗三件套（ws-view.cmd / ws-view.vbs / ~/.local/bin/ws-view）：移除规格与安装面同一权威
  # （src/install-shims.js 的 remove）；node 缺失或模块失败只提示手工删除，不中断卸载。
  if ! command -v node >/dev/null 2>&1; then
    warn "未找到 node——跳过观察窗启动器删除（不中断卸载）"
    note "手工删除：~/.waystation/bin/ws-view.cmd、~/.waystation/bin/ws-view.vbs、~/.local/bin/ws-view"
    return 0
  fi
  local args=(remove --home "$HOME")
  if [ "$DRY_RUN" = 1 ]; then
    args+=(--dry-run)
  fi
  local output=""
  if output="$(node "${REPO_ROOT}/src/install-shims.js" "${args[@]}" 2>&1)"; then
    note_lines "$output"
  else
    note_lines "$output"
    warn "观察窗启动器删除失败（不中断卸载）"
    note "手工删除：~/.waystation/bin/ws-view.cmd、~/.waystation/bin/ws-view.vbs、~/.local/bin/ws-view"
  fi
}

do_uninstall() {
  local title="=== waystation 卸载 ==="
  if [ "$DRY_RUN" = 1 ]; then
    title="=== waystation 卸载（dry-run：只打印，不改动）==="
  fi
  say "$title"

  stop_core_for_uninstall

  step "2/6" "注销 MCP 注册"
  if [ "$DRY_RUN" = 1 ]; then
    note "将执行：claude mcp remove -s user waystation（未注册时该命令报错，属预期；未安装 claude CLI 时改为提示手工步骤）"
  elif command -v claude >/dev/null 2>&1; then
    if remove_output="$(claude mcp remove -s user waystation 2>&1)"; then
      note "已注销：waystation"
    else
      note "未注销（多为本来就没注册）：${remove_output}"
    fi
  else
    note "未找到 claude CLI；如以后需要，可手工执行：claude mcp remove -s user waystation"
  fi

  remove_claude_commands

  step "4/6" "删除可执行"
  if [ "$DRY_RUN" = 1 ]; then
    note "将删除：${SHIM_PATH}"
  elif [ -e "$SHIM_PATH" ]; then
    rm -f "$SHIM_PATH"
    note "已删除：${SHIM_PATH}"
  else
    note "不存在，跳过：${SHIM_PATH}"
  fi
  remove_viewer_shims

  step "5/6" "删除安装目录"
  if [ "$DRY_RUN" = 1 ]; then
    note "将删除：${APP_DIR}"
  elif [ -d "$APP_DIR" ]; then
    rm -rf "$APP_DIR"
    note "已删除：${APP_DIR}"
  else
    note "不存在，跳过：${APP_DIR}"
  fi

  step "6/6" "数据目录"
  if [ "$PURGE_DATA" = 1 ]; then
    # 数据目录位置由 HOME 派生、不接受参数覆盖——这才是防护的真正来源；本守卫只作纵深防御
    case "$DATA_DIR" in
      */.waystation) ;;
      *) fail "数据目录路径异常，拒绝删除：${DATA_DIR}" ;;
    esac
    if [ "$DRY_RUN" = 1 ]; then
      note "将删除：${DATA_DIR}（含全部协作数据）"
    elif [ -d "$DATA_DIR" ]; then
      rm -rf "$DATA_DIR"
      note "已删除：${DATA_DIR}（含全部协作数据）"
    else
      note "不存在，跳过：${DATA_DIR}"
    fi
  else
    note "按默认保留（含协作数据）：${DATA_DIR}"
    note "如确认不再需要，加 --purge-data 重跑卸载即可删除"
  fi

  if [ "$DRY_RUN" = 1 ]; then
    say $'\n（dry-run 结束：未改动任何文件或系统设置）'
  else
    say $'\n卸载完成。'
  fi
}

# ---- 主流程 ----------------------------------------------------------------

if [ "$UNINSTALL" = 1 ]; then
  do_uninstall
  exit 0
fi

if [ "$DRY_RUN" = 1 ]; then
  say "=== waystation 安装（dry-run：只做只读检测并打印将执行的动作，不改动任何文件或系统设置）==="
else
  say "=== waystation 安装 ==="
fi

check_repo_tree

step "1/6" "环境检测"
check_node
read_port_anchor
check_port

install_files
place_executable
register_mcp
install_claude_commands
install_viewer_shims
if [ "$DRY_RUN" = 1 ]; then
  note "（dry-run：自检从略——真实运行时将核对入口、运行依赖、可执行、状态栏脚本、斜杠命令与 MCP 注册六项）"
else
  self_check
fi

show_firewall_guidance
show_session_checklist
show_client_snippets

if [ "$DRY_RUN" = 1 ]; then
  say $'\n（dry-run 结束：以上为将执行的动作清单与指引；未改动任何文件或系统设置）'
else
  say $'\n安装完成。下一步：按上方指引放行防火墙（如需要），然后到 Claude Code 会话里做首检。'
  say '提示：刚安装或升级过 Node 时，请重启 Claude Code 与终端让 PATH 生效，再进会话首检。'
fi
