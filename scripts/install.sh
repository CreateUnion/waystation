#!/usr/bin/env bash
# waystation 安装脚本（Linux）。
#
# 流程（与设计「安装与配置」节一致）：
#   1) 检测 Node（下限实读 package.json 的 engines；缺失时给安装指引，不静默安装）
#   2) 拷贝运行所需文件到 ~/.waystation/app/ 并用 npm ci --omit=dev 就位依赖
#   3) 放置可执行到 ~/.local/bin/waystation（符号链接到安装目录的入口）
#   4) 注册 Claude Code MCP（未装 claude CLI 时打印手工步骤、不视为失败）
#   5) 自检 + 打印防火墙放行指引与会话期首检清单
#
# 特性与边界：
#   - 幂等：重复运行安全（重新拷贝、重装依赖、重新注册）。
#   - --dry-run：只做只读检测并打印将执行的动作，不改动任何文件或系统设置。
#   - 防火墙只打印指引、绝不自动修改。
#   - 卸载：--uninstall（注销 MCP、删安装目录与可执行）；数据目录默认保留，
#     加 --purge-data 才连数据目录一起删。「waystation uninstall」命令（驿站本体提供：
#     注销注册 + 清理 + 数据可选保留）在默认布局下与之等价可选——已装驿站二选一即可；
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

usage() {
  cat <<'EOF'
waystation 安装脚本（Linux）

用法：
  bash scripts/install.sh                            安装（幂等，可重复运行）
  bash scripts/install.sh --dry-run                  预览：只做只读检测并打印将执行的动作
  bash scripts/install.sh --uninstall                卸载（注销 MCP、删安装目录与可执行；保留数据目录）
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
  # 端口锚点与槽位数的唯一权威源是 src/site.js 的导出常量——实读以免脚本里的副本漂移；
  # 读不到时退回内置默认值并在输出里明示（不改脚本行为，只影响打印的指引数字）
  local site_file="${REPO_ROOT}/src/site.js"
  local anchor=""
  local slots=""
  if [ -f "$site_file" ]; then
    anchor="$(grep -oE 'export const ANCHOR_PORT = [0-9]+' "$site_file" 2>/dev/null | grep -oE '[0-9]+' | head -n 1 || true)"
    slots="$(grep -oE 'export const SLOT_COUNT = [0-9]+' "$site_file" 2>/dev/null | grep -oE '[0-9]+' | head -n 1 || true)"
  fi
  if [ -n "$anchor" ] && [ -n "$slots" ]; then
    ANCHOR_PORT="$anchor"
    SLOT_COUNT="$slots"
  else
    SLOT_COUNT=8
    ANCHOR_FALLBACK=1
  fi
  SEGMENT_END=$((ANCHOR_PORT + SLOT_COUNT - 1))
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
    note "默认端口 ${ANCHOR_PORT}（TCP+UDP）：当前可绑（槽位 1 可用）"
  elif [ "$TCP_STATE" = "occupied" ] && [ "$UDP_STATE" = "occupied" ]; then
    note "默认端口 ${ANCHOR_PORT}（TCP+UDP）：已被占用——若本机已有驿站会话在跑属正常；否则驿站启动时会按端口规程处理（占用者分类、降级指引）"
  else
    note "默认端口 ${ANCHOR_PORT}：TCP=${TCP_STATE}、UDP=${UDP_STATE}——驿站启动时会按端口规程处理"
  fi
  if [ "$ANCHOR_FALLBACK" = 1 ]; then
    warn "未能从 src/site.js 读取端口锚点，以上按内置默认值（${ANCHOR_PORT}）打印"
  fi
}

# ---- 安装 ------------------------------------------------------------------

install_files() {
  step "2/5" "安装运行文件到 ${APP_DIR}"
  if [ "$DRY_RUN" = 1 ]; then
    note "将清理并重新拷贝：bin/ src/ scripts/statusline.js package.json package-lock.json"
    note "将在安装目录执行：npm ci --omit=dev --no-audit --no-fund"
    return 0
  fi
  mkdir -p "$APP_DIR"
  rm -rf "${APP_DIR:?}/bin" "${APP_DIR:?}/src" "${APP_DIR:?}/scripts"
  cp -R "${REPO_ROOT}/bin" "${APP_DIR}/bin"
  cp -R "${REPO_ROOT}/src" "${APP_DIR}/src"
  mkdir -p "${APP_DIR}/scripts"
  cp "${REPO_ROOT}/scripts/statusline.js" "${APP_DIR}/scripts/statusline.js"
  cp "${REPO_ROOT}/package.json" "${APP_DIR}/package.json"
  cp "${REPO_ROOT}/package-lock.json" "${APP_DIR}/package-lock.json"
  chmod +x "${APP_DIR}/bin/waystation.js"
  command -v npm >/dev/null 2>&1 || fail "未找到 npm（Node 通常随附 npm）；可在安装目录手动执行：cd ${APP_DIR} && npm ci --omit=dev"
  ( cd "$APP_DIR" && npm ci --omit=dev --no-audit --no-fund ) \
    || fail "依赖安装失败（npm ci）。离线环境可在有网络的机器上执行 npm ci 后整体拷贝 node_modules；或在本机手动执行：cd ${APP_DIR} && npm ci --omit=dev"
  note "已安装：${APP_DIR}"
}

place_executable() {
  step "3/5" "放置可执行：${SHIM_PATH}"
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
  step "4/5" "注册 Claude Code MCP（claude mcp add -s user waystation -- ...）"
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

self_check() {
  step "5/5" "自检"
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
  note "驿站需要入站 TCP 与 UDP 同号端口（发现走 UDP、消息走 TCP），默认端口段 ${ANCHOR_PORT}–${SEGMENT_END}（${SLOT_COUNT} 个槽位）；显式改过端口的站点按实际端口放行。"
  note "使用 ufw（Ubuntu/Debian 等）："
  note "  sudo ufw allow ${ANCHOR_PORT}:${SEGMENT_END}/tcp"
  note "  sudo ufw allow ${ANCHOR_PORT}:${SEGMENT_END}/udp"
  note "使用 firewalld（示例）："
  note "  sudo firewall-cmd --permanent --add-port=${ANCHOR_PORT}-${SEGMENT_END}/tcp"
  note "  sudo firewall-cmd --permanent --add-port=${ANCHOR_PORT}-${SEGMENT_END}/udp && sudo firewall-cmd --reload"
  note "nftables 等直配置场景请做等效放行。"
  note "出站方向默认放行即可，无需额外规则。"
}

show_session_checklist() {
  step "指引" "会话期首检清单（脚本期无法代验，需在 Claude Code 会话里做）"
  note "1) 新开一个会话（会话启动时会拉起驿站进程）"
  note "2) 查看 MCP 连接：会话里执行 /mcp，waystation 应显示已连接"
  note "3) 让 Claude 调用驿站工具：ws_status 应返回本站点状态；ws_list_hosts 应能扫到局域网在线站点；ws_list_collabs 应返回空清单（新装）——工具面共 16 项"
  note "4) 同机多终端时端口自动落在槽位段 ${ANCHOR_PORT}–${SEGMENT_END}（首终端用 ${ANCHOR_PORT}）；跨机互扫端口段覆盖"
  note "5) 两台机器互扫可见后，再按设计验收场景走「建立协作」流程"
  note "6)（可选）状态栏「协作中」指示：把 ${APP_DIR}/scripts/statusline.js 配为 statusLine 命令（见 README 状态栏节）；进入协作后应显示「协作中：⋯」"
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

do_uninstall() {
  local title="=== waystation 卸载 ==="
  if [ "$DRY_RUN" = 1 ]; then
    title="=== waystation 卸载（dry-run：只打印，不改动）==="
  fi
  say "$title"

  step "1/4" "注销 MCP 注册"
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

  step "2/4" "删除可执行"
  if [ "$DRY_RUN" = 1 ]; then
    note "将删除：${SHIM_PATH}"
  elif [ -e "$SHIM_PATH" ]; then
    rm -f "$SHIM_PATH"
    note "已删除：${SHIM_PATH}"
  else
    note "不存在，跳过：${SHIM_PATH}"
  fi

  step "3/4" "删除安装目录"
  if [ "$DRY_RUN" = 1 ]; then
    note "将删除：${APP_DIR}"
  elif [ -d "$APP_DIR" ]; then
    rm -rf "$APP_DIR"
    note "已删除：${APP_DIR}"
  else
    note "不存在，跳过：${APP_DIR}"
  fi

  step "4/4" "数据目录"
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

step "1/5" "环境检测"
check_node
read_port_anchor
check_port

install_files
place_executable
register_mcp
if [ "$DRY_RUN" = 1 ]; then
  note "（dry-run：自检从略——真实运行时将核对入口、运行依赖、可执行、状态栏脚本与 MCP 注册五项）"
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
