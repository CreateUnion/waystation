# waystation 故障排查手册

本文面向现场操作者，按「症状 → 诊断步骤 → 修复动作 → 预防」组织。原理不在这里重复：
涉及进程模型、启动序、重生流、调度持久化与投递语义时，请对照
[`ARCHITECTURE.md`](./ARCHITECTURE.md) 的对应章节（§2.1、§3.1–§3.5、§4.3、§5.3–§5.4、§6.3、§8）。

**适用版本：0.2.6**（以安装树 `package.json` 为准）。更早版本的行为差异在 §0.5 单独列出；
没有实测依据的结论在全文中标注「待验证」。

约定：

- Windows 命令默认在 **PowerShell** 中执行；POSIX 命令默认在 **bash** 中执行。
- `%USERPROFILE%` 对应 POSIX 的 `$HOME`；默认数据根为 `~/.waystation`。
- 工具调用写成 `ws_xxx { ... }`；工具名与参数以 MCP 客户端实际返回的 schema 为准。
- `WAYSTATION_HOME` 自定义数据根时，**核心、桥、CLI、状态栏必须使用同一个值**；只在某一处设置会造成「看错数据根」的假象。

---

## 0. 快速分诊

### 0.1 先看桥还能不能和核心说上话

调用：

```text
ws_status {}
```

- **成功**：返回 `core.pid`、`core.app`、`core.endpoint`、`net`、`dispatch` 等字段，说明本会话的桥已经连上核心。
- **失败**：返回

  ```json
  {
    "core": { "available": false, "reason": "……" },
    "bridge": { "version": "0.2.6", "app": "……" }
  }
  ```

  `reason` 是桥侧的分类文案（核心启动失败原因、等待接管说明、冷启配额说明等），**原文优先看它**。
  详细原理见 [`ARCHITECTURE.md` §3.3](ARCHITECTURE.md#33-桥的探测与四态判定)。

注意两条边界：

1. 核心不可达时，MCP 的 `tools/list` 仍然正常（桥不依赖核心即答工具目录），只是**调用**失败。
2. `ws_status` 是唯一由桥合成的差错载荷；其他 `ws_*` 工具此时只会返回错误文本。
3. 如果 `ws_status` 也调用不到，说明 MCP 桥本身没有起来/已退出，先检查该会话的 MCP 注册与进程（见 §2）。

### 0.2 看核心状态

```powershell
# Windows（PATH 里有 waystation.cmd 时）
waystation core status
# 或使用安装目录入口
node "$env:USERPROFILE\.waystation\app\bin\waystation.js" core status
```

```bash
# POSIX
waystation core status
# 或
node ~/.waystation/app/bin/waystation.js core status
```

自定义数据根时先设置同一个环境变量：

```powershell
$env:WAYSTATION_HOME = 'D:\waystation-data'; waystation core status
```

```bash
WAYSTATION_HOME=/data/waystation waystation core status
```

`core status` 的五种结论：

| 结论 | 含义 | 处置入口 |
| --- | --- | --- |
| 未运行（无 `run/core.json`） | 没有核心，或描述符已被正常删除 | §1.3 A |
| 运行中（`status=starting/ready`） | 核心进程活着 | 若工具仍失败，按 §1.3 D/E 查连接与桥 |
| 等待接管（`status=waiting`） | 同根旧站点仍在线，新核不监听 IPC、数据面零写、不写日志 | §1.3 F |
| 异常（残留描述符：pid 已不在） | `run/core.json` 是陈旧锁 | §1.3 B |
| 异常（疑似僵尸：进程存活、心跳停） | 事件循环可能卡死 | §1.3 C |
| 异常（描述符不可解析/形态不合） | `run/core.json` 损坏 | §1.3 G |

`core status` 只读描述符，**不能代替实际连接测试**。在 Session 0/命名管道 ACL 这类历史问题里，
它可能显示「运行中」，但用户会话的桥仍拨不进去；0.2.5 起改用 TCP 环回后该限制已消除（见 §0.5）。

### 0.3 看日志

核心日志默认在 `<数据根>/logs/waystation.log`（`config.logDir` 可改；`ws_status` 成功时返回 `logDir`）。
日志是**一行一个 JSON 对象**。

```powershell
Get-Content "$env:USERPROFILE\.waystation\logs\waystation.log" -Tail 100
# 只看关键行
Get-Content "$env:USERPROFILE\.waystation\logs\waystation.log" -Tail 300 |
  Select-String -Pattern '启动|注册|席位|dispatch|保留期清理|错误|warn'
```

```bash
tail -n 100 ~/.waystation/logs/waystation.log
grep -E '启动|注册|席位|dispatch|保留期清理|错误|warn' ~/.waystation/logs/waystation.log | tail -n 100
```

桥**不写文件日志**，它的诊断在 Claude Code 的 MCP stderr/调试输出里；`waystation.log` 只有核心侧记录。
所以「核心日志干净但工具失败」是可能的，不要只凭核心日志下结论。

### 0.4 数据布局（排障最常用的几项）

| 路径 | 内容 | 排障用途 |
| --- | --- | --- |
| `config.json` | 身份名、端口、`dispatch.*`、`retention.*`、日志参数 | 查持久化/保留期配置是否生效 |
| `run/core.json` | pid、状态、心跳、端点、token、`startupError` | 核心是否活着、为什么启动失败 |
| `run/core-stop.json` | 核心正常退出时的本机席位快照 | 重启对账；一般不用手工改 |
| `sessions/<sessionId>.json` | 核心为已注册桥写的会话状态文件（`pid` 是**核心** pid） | 判断某会话是否被核心看见 |
| `dispatch/state.json` | 调度编排状态（`dispatch.persist=false` 时不产生） | 调度能否恢复；损坏时会被隔离 |
| `collabs/` | 协作目录（台账、席位、收发件等） | 保留期清理对象；活跃协作不应手工删 |
| `archive/collabs/` | 已结束协作的 gzip 归档清单 | 清理后的审计依据；当前没有恢复 CLI |
| `logs/waystation.log` | 核心文件日志（按大小轮转） | 启动失败、恢复、清理的唯一文件证据 |
| `dispatch-rules.md` | 调度纪律单一权威源 | 收编通知实时读取；与排障关联较小 |
| `known-hosts.json` | 发现辅助的已知主机清单 | 局域网发现异常时查看 |

**安全提醒**：`run/core.json` 含核心 token，等同本机工具面的凭据。不要把该文件内容贴到聊天、工单或公开日志里；
POSIX 下 `run/` 应为 `0700`、套接字文件为 `0600`。原理见 [`ARCHITECTURE.md` §2.1](ARCHITECTURE.md#21-本机-ipc) 与 §7。

### 0.5 版本差异（排障前先确认在哪个版本上）

| 版本 | 与本手册相关的行为 |
| --- | --- |
| ≤0.2.4 | Windows 有「服务上下文（Session 0）冷启守卫」：桥在 Session 0 拒绝冷启核心，报「核心冷启被拒：服务上下文」。需要在用户会话里先拉起核心。 |
| 0.2.5 | 改用 TCP 环回（`run/core.json` 的 `ipc.tcp`），移除 Session 0 守卫；桥仍依赖断连后的重生流/慢速重试，多桥并发冷启时可能长时间不重注册；调度仍是纯内存；`ws_send_message` 没有 `delivery` 增量字段。 |
| 0.2.6 | 桥常驻心跳（默认 10s 探测、30s 超时）自动重连并重注册；调度编排状态默认持久化；`ws_send_message` 增加 `delivery` 与 `requireAck`；保留期清理；扫描/状态计划提供稳定会话短码（若构建尚未包含该字段，以完整 `sessionId` 为准）。 |

查看安装树版本：

```powershell
Get-Content "$env:USERPROFILE\.waystation\app\package.json" | Select-String '"version"'
```

```bash
grep '"version"' ~/.waystation/app/package.json | head -1
```

---

## 1. 核心没有起来

### 症状

- 所有 `ws_*` 工具调用失败；`ws_status` 返回 `core.available=false`，`reason` 为下面之一：
  - `核心无应答（……）`
  - `核心连接失败（内部错误：……）`
  - `核心启动失败：<startupError>`
  - `核心启动失败：启动超时（10 秒内未就绪）`
  - `冷启尝试超过上界（3 次/10 分钟）——等待窗口滑过后自动重试`
  - `核心无应答：已尝试重启核心（硬杀防护链未通过：……）`
- 旧版（≤0.2.4）还可能看到：

  ```text
  核心冷启被拒：当前环境为服务上下文（Session 0）：在此冷启的核心，其管道会拒绝用户会话桥连接（EPERM）。
  请先在任一用户会话中把核心启动起来（任意 Claude 会话调用任一 ws_* 工具即可触发冷启），本桥随后自动附着
  ```

- `waystation core status` 显示未运行、残留描述符、疑似僵尸、等待接管或描述符不可解析。

### 诊断步骤

**第 1 步：把 `ws_status.reason` 原文记下来。**

它是桥的分类结论，已经比「工具全挂了」多一层信息。不要把 `reason` 改写成自己的猜测。

**第 2 步：运行 `core status`，按 §0.2 的表定位状态。**

**第 3 步：直接读 `run/core.json`，看 pid、心跳与 `startupError`。**

```powershell
$core = Get-Content "$env:USERPROFILE\.waystation\run\core.json" -Raw | ConvertFrom-Json
$core | Select-Object pid,status,statusDetail,startupError,heartbeatAt,startedAt,appVersion,ipcV,endpoint
```

```bash
jq '{pid,status,statusDetail,startupError,heartbeatAt,startedAt,appVersion,ipcV,endpoint}' \
  ~/.waystation/run/core.json
# 没有 jq 时：
python3 -m json.tool ~/.waystation/run/core.json
```

判读：

- `startupError` 非空：核心启动时主动拒绝服务，原因就在这句话里。
- `pid` 对应进程不存在：陈旧描述符。
- `pid` 存在、`heartbeatAt` 很旧：疑似僵尸。
- `status=waiting`：不是崩溃，是等待同根旧站点退场；见 §1.3 F。
- 文件不可解析：描述符损坏；见 §1.3 G。

**第 4 步：看核心日志的最后 100–300 行。**

重点搜索：

```text
启动失败|拒绝服务|自检|不可用|配置|端口|EPERM|EACCES|startupError|等待接管|保留期清理
```

常见 `startupError` 与处置：

| `startupError` 原文（示例） | 含义 | 处置 |
| --- | --- | --- |
| `显式数据根未显式配置端口——拒绝启动：请在 <数据根>/config.json 中设置 port` | 用了自定义 `WAYSTATION_HOME`，但配置里没有显式端口 | 在 `config.json` 写入 `port`（7321–7328 之一），重启 |
| `数据目录不可用：……——启动自检失败，拒绝服务` / `日志目录不可用：……` / `协作目录不可用：……` | 数据根/日志/协作目录不可写 | 修权限/磁盘空间；确保运行账户可写 |
| `启动自检失败，拒绝服务：……` | 写盘探针失败（磁盘满、只读、ACL） | 释放空间、修 ACL；POSIX 检查 `run/` 是否为 `0700` |
| `EPERM: operation not permitted, rename '...run\core.json.<uuid>.tmp' -> '...run\core.json'` | 0.2.5 多桥并发冷启时 Windows 并发读+原子替换竞态 | 升级 0.2.6（已对 `EPERM/EACCES/EBUSY` 做小步重试）；旧版等待或重启会话 |
| `核心进程已退出（退出码 N）——原因不可得` | `run/` 不可写，连 `startupError` 都写不进 | 先修 `run/` 权限/磁盘，再重试 |
| `启动超时（10 秒内未就绪）` | 核心在首调用等待预算内没 ready | 看日志是否卡在自检/注册表加载；检查磁盘、端口、杀毒软件拦截 |

**第 5 步：确认进程与会话号。**

```powershell
# 核心进程是否还活着；SessionId=0 表示服务上下文
$core = Get-Content "$env:USERPROFILE\.waystation\run\core.json" -Raw | ConvertFrom-Json
Get-Process -Id $core.pid -ErrorAction SilentlyContinue | Select-Object Id,SessionId,StartTime
```

```bash
ps -p <pid> -o pid,ppid,sid,etime,cmd
```

**第 6 步：确认数据根一致、端口可用、磁盘有空间。**

- `WAYSTATION_HOME` 在核心、桥、CLI 三处一致（见 §0）。
- 局域网端口 7321–7328 被占**不会**让核心拒绝启动，只会进入 LAN 降级服务：
  `ws_status` 的 `core.degraded`/`net` 会体现，本地工具仍可用。这是「本地能用、局域网工具报降级」的常见原因。
- IPC 端点（Windows 命名管道 / POSIX `run/core.sock`，以及 `ipc.tcp`）不可用会让核心启动失败或桥连不上。
- 磁盘满、只读、ACL 变化都会让自检失败。

### 修复动作

#### A. `core status` 显示「未运行（无 run/core.json）」

1. **从用户会话触发冷启**：在任意已注册 waystation MCP 的 Claude Code 会话里调用一次 `ws_status` 或任意 `ws_*` 工具。
   桥会按 `ARCHITECTURE.md` §3.3 的四态判定冷启核心。
2. 再看 `core status` 与 `waystation.log`。如果仍然未运行，读取 `startupError` 按上面的表处理。
3. 需要看前台 stderr 时，可临时手工启动（仅诊断，确认后 `Ctrl+C`）：

   ```powershell
   node "$env:USERPROFILE\.waystation\app\bin\waystation-core.js"
   ```

   ```bash
   node ~/.waystation/app/bin/waystation-core.js
   ```

   前台启动会按正常启动序取锁；已有核心在服务时它会按仲裁让位退出。生产环境不要长期手工前台运行。

#### B. `core status` 显示「残留运行描述符：pid 已不在」

这是**陈旧锁**，不是运行中的核心。处理顺序：

1. 先确认该 pid 确实不存在（`Get-Process -Id <pid>` / `ps -p <pid>`）。
2. 不需要手工删除 `run/core.json`；下一次桥冷启时，核心的取锁仲裁会判陈旧并隔离锁文件
   （[`ARCHITECTURE.md` §3.1](ARCHITECTURE.md#31-核心启动序)）。
3. 触发一次冷启（任意 `ws_*` 工具），然后重新 `core status`。
4. 如果桥持续报 `startupError`，先看 `startupError` 是否来自一个**仍存活**的失败进程：
   - 0.2.6：失败进程已死/心跳已停时，桥会按陈旧失败记录重新冷启（日志会出现
     `发现陈旧启动失败记录（失败进程已退出/心跳已停）——按陈旧处理并重新冷启`）。
   - 0.2.5 及更早：可能一直按启动失败收口、拒绝再冷启；升级 0.2.6，或等进程退出后重启会话。
5. **最后手段**（确认没有核心进程、也没有活跃会话在跑时）：

   ```powershell
   Rename-Item "$env:USERPROFILE\.waystation\run\core.json" "core.json.bak-$(Get-Date -Format yyyyMMdd-HHmmss)"
   ```

   ```bash
   mv ~/.waystation/run/core.json ~/.waystation/run/core.json.bak-$(date +%Y%m%d-%H%M%S)
   ```

   然后触发冷启。**绝不能在核心还活着时改名/删除**；token、端点、锁都在这个文件里。

#### C. `core status` 显示「疑似僵尸：进程存活、心跳停」

1. 优先用有序停止：

   ```powershell
   waystation core stop
   ```

   ```bash
   waystation core stop
   ```

2. 如果 IPC 无应答，`core stop` 会自动落硬杀防护链；仍不成功时显式授权：

   ```powershell
   waystation core stop --force
   ```

   ```bash
   waystation core stop --force
   ```

3. 停止后触发一次冷启，确认 `core status` 变为运行中。
4. 若防护链返回「校验不过」「已尝试过一次」等结论，**不要绕过防护链手工杀进程**；先保留现场，
   查看 `waystation.log` 与桥 stderr。宁可不杀，也不要误杀继任核心。

#### D. `core status` 运行中，但 `ws_*` 仍失败

按「桥 → 核心」的连接面排查：

1. 确认本会话的桥进程还在：见 §2 的进程列表命令。桥不在时，Claude Code 会在下次工具调用时重新 spawn。
2. 确认 `run/core.json` 的 `endpoint` 与 `ipc.tcp` 存在且形态合法；token 不应手工修改。
3. 尝试强制旧传输，判断是否 TCP 环回问题：

   ```powershell
   $env:WAYSTATION_IPC_TRANSPORT = 'pipe'; # 仅当前进程/会话生效
   ```

   ```bash
   export WAYSTATION_IPC_TRANSPORT=pipe
   ```

   重启该会话后重试。`auto`（缺省）会优先 TCP、失败回退旧端点；`pipe` 用于整体回滚，`tcp` 只走 TCP。
   原理见 [`ARCHITECTURE.md` §2.2](ARCHITECTURE.md#22-传输选择与回滚)。
4. 0.2.6 桥有心跳监督，断连后通常会在秒级重连；若仍不连，查看该会话的 MCP stderr 中是否有
   `核心连接断开（重生流：判陈旧后冷启）`、`核心不可达` 等行。
5. 若日志出现鉴权类失败（认证固定回执，不区分错 token/缺 token），通常是描述符被手工改过或
   核心刚换代；不要复用旧 token，触发冷启/换代后重试。

#### E. 服务上下文（Session 0）历史问题

只在 **≤0.2.4** 出现：

1. 找到核心 pid（`run/core.json`），确认它的 Windows 会话号：

   ```powershell
   Get-Process -Id <pid> | Select-Object Id,SessionId
   ```

2. 如果核心由 cc-connect 服务树里的桥冷启，`SessionId=0`，其命名管道 ACL 会拒绝用户会话桥。
   处理：**先在用户桌面会话里调用任意 `ws_*` 工具**，让用户会话桥冷启核心；服务会话的桥随后附着。
3. 推荐直接升级 **0.2.5+**：TCP 环回 `127.0.0.1` 不受跨 Session 命名管道 ACL 限制，守卫已移除。
   如果升级后仍看到这条旧文案，说明 Claude Code 的 MCP 仍指向旧安装树/旧桥，检查 `claude mcp` 注册路径。

#### F. `core status` 显示「等待接管（status=waiting）」

这是**正常过渡态**，不是崩溃：同根旧站点仍在运行，新核不监听 IPC、不写数据面、不写日志，
只保留 `run/`（[`ARCHITECTURE.md` §3.2](ARCHITECTURE.md#32-等待接管态)）。

1. 关闭同根的旧版/旧安装会话；旧站点退场后新核会自动迁出并接管。
2. 等待态有 60 分钟寿命上界；到期自行退出，桥再到达时会重新探测。
3. 如果确认旧站点已不存在但状态仍卡住：

   ```powershell
   waystation core stop --force
   ```

   ```bash
   waystation core stop --force
   ```

4. 不要通过删除 `run/core.json` 来「解决」等待态；等待态的核心不监听 IPC，删描述符只会让状态更混乱。

#### G. `core status` 显示描述符不可解析/形态不合

1. 备份并检查原文件：

   ```powershell
   Copy-Item "$env:USERPROFILE\.waystation\run\core.json" "$env:USERPROFILE\.waystation\run\core.json.bad"
   Get-Content "$env:USERPROFILE\.waystation\run\core.json" -Raw
   ```

   ```bash
   cp ~/.waystation/run/core.json ~/.waystation/run/core.json.bad
   cat ~/.waystation/run/core.json
   ```

2. 确认没有核心进程在跑后，把坏文件改名移走，再触发冷启（核心会用独占创建重新生成描述符）。
3. 若是磁盘写坏/断电导致，检查文件系统与磁盘健康；不要手工拼一个带旧 token 的 `core.json`。

### 预防

- 升级到 **0.2.6**，保留桥常驻心跳（不要设置 `WAYSTATION_BRIDGE_HEARTBEAT=0`）。
- 首次冷启尽量在**用户桌面会话**里触发；不要在 ≤0.2.4 上让服务会话冷启核心。
- 数据根放在本地可写磁盘，避免网络盘/同步盘；定期检查磁盘空间与 ACL。
- 自定义 `WAYSTATION_HOME` 时，在 `config.json` 显式配置 `port`，并在所有入口使用同一个数据根。
- 升级按 README 的「关旧会话 → 重跑安装脚本 → 重开会话」顺序，避免新旧核长期并存。
- 不要手工编辑 `run/core.json`；需要清理陈旧锁时先确认 pid 已死。

---

## 2. 核心重启后会话不可见（scan 为空、claim 报「不在线或不可见」）

### 症状

- 调度长调用 `ws_dispatch_scan` 返回：

  ```json
  { "ok": true, "dispatchId": "……", "sessions": [] }
  ```

- 手工收编返回：

  ```text
  本机会话不在线或不可见
  ```

- 目标会话的 Claude Code 进程还活着、transcript 还在更新，但 `ws_status`/`ws_dispatch_scan` 看不到它。
- 常见于**核心重启/换代之后**：调度长自己的桥已连上新核（所以 `ws_status` 成功），
  其他会话的桥仍挂在旧连接上（stale），既不重连也不报错。
- 2026-11-01 实例：核心重启后三个交互会话的桥 stale，`scan` 为空、`claim` 报「本机会话不在线或不可见」，
  最终通过**杀掉目标会话的桥进程，让 Claude Code 在下次工具调用时重新 spawn** 恢复。

### 诊断步骤

**第 1 步：确认核心确实重启过。**

```text
ws_status {}
```

看 `core.pid`、`startedAt`、`core.endpoint`，并与故障开始时间对照。再看 `ws_list_collabs` 中的调度条目
（若有）是否处于 `pending-takeover`。原理：核心换代会让旧桥连接失效，桥需要重新 `hello` 注册
（[`ARCHITECTURE.md` §3.5](ARCHITECTURE.md#35-重生流与换代)）。

**第 2 步：隔 10–30 秒重复 `ws_dispatch_scan`。**

0.2.6 桥心跳默认 10s 一拍；核心重启后应自动重连并重注册。第一次 scan 为空可能只是还没到重连拍，
不要把它当最终名单。

**第 3 步：确认目标会话进程与 transcript 是否还活着。**

```powershell
Get-Process claude -ErrorAction SilentlyContinue | Select-Object Id,SessionId,StartTime
Get-ChildItem "$env:USERPROFILE\.claude\projects" -Recurse -Filter '*.jsonl' |
  Sort-Object LastWriteTime -Descending | Select-Object -First 5 FullName,LastWriteTime
```

```bash
ps -eo pid,ppid,sid,etime,cmd | grep -E 'claude' | grep -v grep
find ~/.claude/projects -name '*.jsonl' -printf '%TY-%Tm-%Td %TH:%TM %p\n' | sort -r | head -5
```

也可以让调度长使用 Claude Code 的 `ListAgents` 看本机 peer 会话；它显示的是 Claude Code 的会话名/短码，
与 waystation 的 `sessionId` 不是同一套显示口径（见 §6）。

**第 4 步：列出桥进程，区分「核心」与「桥」。**

```powershell
Get-CimInstance Win32_Process |
  Where-Object { $_.CommandLine -like '*waystation.js*' -and $_.CommandLine -notlike '*waystation-core.js*' } |
  Select-Object ProcessId,ParentProcessId,CreationDate,CommandLine |
  Format-List
```

```bash
ps -eo pid,ppid,etime,args | grep 'bin/waystation.js' | grep -v 'waystation-core' | grep -v grep
```

- `waystation-core.js` 是核心，**不要杀**。
- `bin/waystation.js`（MCP 桥）是每会话一条，可以按目标会话杀掉后让 Claude Code 重 spawn。
- 桥的父进程通常是 `cmd`/`sh`，再往上是 `claude` 进程。可用父 pid 逐级确认它属于哪个会话：

  ```powershell
  $p = Get-CimInstance Win32_Process -Filter "ProcessId=<桥 pid>"
  $p.ParentProcessId
  Get-CimInstance Win32_Process -Filter "ProcessId=$($p.ParentProcessId)" |
    Select-Object ProcessId,Name,CreationDate,CommandLine
  ```

  进程树与 Claude Code 会话的映射在不同启动器下可能不同；2026-11-01 实例是按进程启动时间与
  `ListAgents` 的 `started ... ago` 对照定位的。**待验证**：其他启动器/终端下的父子链是否一致。

**第 5 步：看核心日志的注册/对账记录。**

```powershell
Get-Content "$env:USERPROFILE\.waystation\logs\waystation.log" -Tail 500 |
  Select-String -Pattern '核心重启对账|重绑|重新注册|桥无会话标识|席位'
```

```bash
grep -E '核心重启对账|重绑|重新注册|桥无会话标识|席位' ~/.waystation/logs/waystation.log | tail -n 50
```

核心正常重启时会写 `核心重启对账`；宽限期（默认 60 秒）内重绑的席位视为未离席。
如果日志显示对账完成但目标会话没有重绑，说明它的桥没有重新注册。

### 修复动作

**0.2.6 起应自动恢复（前提是桥进程还活着，只是连接 stale）。** 桥常驻心跳会在未注册态每拍调用
既有 `ensureCore`，断连后强制重连；重连成功即重新注册（seat rebind）并补发会话元数据。
先等待 10–30 秒并重复 scan；通常不需要手工杀桥。如果桥进程已经退出，Claude Code 只在该会话下次调用
工具时重新 spawn 桥，仍需目标会话动一下（调用任意 `ws_*` 工具）。若仍不恢复，再按下面手动路径处置。

**手动路径（0.2.5 及更早，或 0.2.6 心跳被关闭/仍失败时）：**

1. **只杀目标会话的桥进程**，不要杀调度长自己的桥，也不要杀核心：

   ```powershell
   Stop-Process -Id <目标桥 pid> -Force
   ```

   ```bash
   kill -9 <目标桥 pid>
   ```

2. **让目标会话调用一次任意 `ws_*` 工具**（例如 `ws_status`）。Claude Code 会在工具调用时重新 spawn 桥，
   新桥连上新核心并注册。无法直接操作目标窗口时，可用 Claude Code 的跨会话消息/用户转达：
   「请调一次 `ws_status`」。注意跨会话消息也可能被权限模式挂起（见 §4.2）。
3. 重新 `ws_dispatch_scan`；如启用 `autoClaim`，新会话会被自动收编；否则用完整 `sessionId` 手工收编：

   ```text
   ws_dispatch_claim { "sessionIds": ["<完整 sessionId>", "……"] }
   ```

   `ws_dispatch_claim` 按完整 `sessionId` 精确匹配，**不要传显示名，也不要传短码**（当前实现是精确全等）。

4. 目标会话若始终没有 `CLAUDE_CODE_SESSION_ID`（非 Claude Code 客户端/部分子代理桥），核心无法把它
   当作可收编会话；改用带会话标识的正常会话，或给无头 worker 显式设置环境。

**cc-connect 场景的额外注意：**

- 调度长自己的桥可能就在 cc-connect 服务树里。**不要杀它**；否则会连同当前调度长会话一起失去连接。
- 重启 cc-connect 会树杀核心、调度长桥与 agent（见 §5）；这类故障优先按 §3/§5 处理，而不是只杀目标桥。

### 预防

- 升级 0.2.6 并保持桥心跳开启；不要把 `WAYSTATION_BRIDGE_HEARTBEAT` 设为 `0`，除非你明确要用旧重连路径。
- 核心重启/部署后，调度长先等一轮心跳再 scan；把「第一次 scan 为空」当作暂时态，不要立刻重建 dispatch。
- 无头组员的 `--allowed-tools` 必须包含 `ws_status`、`ws_send_message`、`ws_check_inbox`、`ws_leave_collab` 等
  回执/重连所需工具；否则它在 `dontAsk` 下无法调用工具，也就不会触发桥注册。
- 避免在长任务期间频繁重启核心/cc-connect；需要重启时先让组员进入可恢复点。

---

## 3. 调度丢失：核心或 cc-connect 重启后编排域为空

### 症状

- `ws_dispatch_scan` 返回：

  ```json
  { "ok": false, "code": "dispatch-lost", "message": "dispatch 不存在（可能已结束或核心已重启）——请重新创建" }
  ```

- `ws_status` 的 `dispatch` 为 `null`；`ws_list_collabs` 里没有 `mode: "dispatch"` 的条目。
- 或 `ws_list_collabs` 中调度条目的 `status` 为 `pending-takeover`，`masterSessionId` 指向旧调度长。
- 典型触发：核心重启、cc-connect 重启/升级、部署换代。2026-11-01 及更早的实例中，调度是纯内存，
  核心重启后必须重建并重新收编。

### 诊断步骤

**第 1 步：区分「彻底丢失」与「待接管」。**

```text
ws_status {}
ws_list_collabs {}
```

- `ws_status.dispatch === null` 且 `ws_list_collabs` 无调度条目：彻底丢失（或还没创建）。
- `ws_list_collabs` 有调度条目但 `status: "pending-takeover"`：编排状态还在，等调度长恢复或新调度长接管。
- `ws_list_collabs` 的调度条目带 `persisted: true`：本进程内持久化生效；`persisted: false` 表示
  `dispatch.persist=false` 或写盘失败已降级纯内存。

注意：`ws_status.dispatch` 只给 `status/masterSessionId/masterLastSeenAt/slaves/taskCount`，
**不提供 `persisted`**；持久化状态看 `ws_list_collabs` 的条目或 `dispatch/state.json`。

**第 2 步：确认核心是否重启过。**

```powershell
waystation core status
```

看 `startedAt`、pid 是否变化。若是 cc-connect 重启，通常核心、调度长桥、agent 会一起被杀（见 §5）。

**第 3 步：读 `dispatch/state.json`。**

默认路径 `<数据根>/dispatch/state.json`；`config.dispatch.state_path` 可改相对/绝对路径。
只读以下字段，不要手工改：

```powershell
$p = "$env:USERPROFILE\.waystation\dispatch\state.json"
$s = Get-Content $p -Raw | ConvertFrom-Json
$s | Select-Object v,savedAt,
  @{n='status';e={$_.dispatch.status}},
  @{n='master';e={$_.dispatch.masterSessionId}},
  @{n='lastSeen';e={$_.dispatch.masterLastSeenAt}},
  @{n='slaves';e={$_.dispatch.slaves.Count}},
  @{n='tasks';e={$_.dispatch.tasks.Count}}
```

```bash
jq '{v,savedAt,status:.dispatch.status,master:.dispatch.masterSessionId,
     lastSeen:.dispatch.masterLastSeenAt,
     slaves:(.dispatch.slaves|length),tasks:(.dispatch.tasks|length)}' \
  ~/.waystation/dispatch/state.json
```

**第 4 步：看日志。**

```powershell
Get-Content "$env:USERPROFILE\.waystation\logs\waystation.log" -Tail 300 |
  Select-String -Pattern 'dispatch|调度|持久化|状态文件|保留期'
```

```bash
grep -E 'dispatch|调度|持久化|状态文件|保留期' ~/.waystation/logs/waystation.log | tail -n 100
```

重点日志：

| 日志 | 含义 |
| --- | --- |
| `调度状态文件损坏——按无状态启动` | 文件被隔离为 `.corrupt-<ts>`，本次启动没有恢复；见 §7.1 |
| `调度状态持久化失败——本进程内降级为纯内存（编排继续）` | 写盘失败，本进程内不再持久化；见 §7.1 |
| `调度状态残留超期（待接管且心跳超过保留期）——已删除，不恢复` | `pending-takeover` 超过 `retention.dispatch_hours`，启动时被清理 |
| `dispatch「…」已恢复（调度长：…）；组员与任务表保留` | 持久化恢复且调度长在线 |
| `dispatch「…」已恢复为待接管：调度长「…」当前不在线；组员与任务表保留，新调度长可接管` | 持久化恢复但调度长未在线 |
| `调度长「…」已恢复心跳——dispatch「…」继续执行（组员与任务表保留）` | 待接管期间旧调度长恢复调用 |

### 修复动作

#### A. 0.2.6 持久化恢复（推荐路径）

1. 让**调度长会话**调用任意 `ws_*` 工具（例如 `ws_status`）。核心会刷新调度长心跳；
   若状态是 `pending-takeover`，会广播「调度已恢复」并回到 `active`。
2. 重新 `ws_dispatch_scan`；`autoClaim` 开启时会自动补收组员，否则手工 `ws_dispatch_claim`。
3. 用 `ws_list_collabs` 确认调度条目 `status: "active"`、`slaveCount`/`taskCount` 与预期一致。
4. 若调度长已换会话（新 `sessionId`），见下面的 B。

#### B. 待接管：新调度长接管

1. 确认新会话的启动环境带 `WAYSTATION_ROLE=master`（角色只认启动期环境变量，工具参数不能声明）。
2. 等待旧调度长心跳超时，默认 `dispatch.master_timeout_ms = 180000`（3 分钟）。
   未到时间时 `ws_create_collab` 会返回：

   ```text
   现有 dispatch 的调度长「…」仍活跃（心跳超时还需约 Ns）——不能接管
   ```

   按返回的剩余秒数等待，不要反复猛试。
3. 超时后调用：

   ```text
   ws_create_collab { "mode": "dispatch", "name": "<原名称>", "autoClaim": true }
   ```

   成功时返回 `takeover: true`、`previousMasterSessionId`、`slaveCount`、`taskCount`；
   `collabId`、组员与任务表原样移交。
4. 旧调度长恢复后，任何调度操作会得到 `dispatch-taken-over`，这是预期行为，不要让它再建一个 dispatch。
5. 新调度长重新 `ws_dispatch_scan` 并确认组员；缺的用完整 `sessionId` 收编。

#### C. 彻底丢失：重建 + 重新收编（旧版本或持久化不可用）

1. 创建调度（带自动收编）：

   ```text
   ws_create_collab { "mode": "dispatch", "name": "AI-dispatch", "autoClaim": true }
   ```

2. `ws_dispatch_scan` 查看可收编会话；等 10–30 秒再扫一次，排除桥重连的暂时态（§2）。
3. 对未自动入编的会话：

   ```text
   ws_dispatch_claim { "sessionIds": ["<完整 sessionId>", "……"] }
   ```

4. 重新下发任务。任务表已丢失时，`taskId` 可以复用；重新发 `task` 会重建任务状态。
5. 消息流水/台账/收件历史本来就不持久化，不能恢复；需要历史请从各会话 transcript 或本地记录人工汇总。

#### D. cc-connect 重启后的恢复

cc-connect 重启会树杀核心、调度长桥与 agent；用户发一条消息后 cc-connect 才会拉起新的 agent 会话。
新会话可能是同一 transcript 的 resume，也可能是新 `sessionId`：

- 同一 `sessionId` resume：调度长调用任意 `ws_*` 工具即可让持久化状态回到 `active`。
- 新 `sessionId`：旧调度长永远离线，走 B 的接管路径；若 `dispatch.persist=false`，走 C 重建。

### 预防

- 保持 `dispatch.persist=true`（默认），并把 `dispatch.state_path` 放在持久本地磁盘；不要指向临时目录。
- 不要在任务进行中手工删除 `dispatch/state.json`；正常结束用 `ws_end_collab`，它会删除状态文件。
- 升级/部署尽量凑批，避免一天内多次重启核心；升级前让调度长记录当前任务表。
- 开启 `autoClaim`，让核心节拍自动补收新会话。
- 注意持久化边界：`pendingAcks`、补投队列截止等仍是内存态，核心重启会丢；关键任务在重启后重新发
  `requireAck` 的 `task`（见 §4.1 与 [`ARCHITECTURE.md` §8](ARCHITECTURE.md#8-已知限制)）。
- `pending-takeover` 超过 `retention.dispatch_hours`（默认 24h）会在下次核心启动时被清理；长期停摆的
  调度要先恢复调度长或及时接管。

---

## 4. 消息发不出去 / 收不到

先区分三类问题：**队列/链路未送达**、**已注入但目标没处理（权限模式）**、**QQ 平台去重**。
三者症状相似，处置完全不同。

### 4.1 `ws_send_message` 返回 ok 但对方没收到

#### 症状

- 0.2.5 及更早：`ws_send_message` 返回 `ok: true`，但目标会话没有收到/没有处理。
- 0.2.6：返回里带 `delivery`，可能是 `queued`、`failed`、`partial`；或者 `delivered` 但目标仍未处理。
- `ws_status` 的 `net.dispatch.counters` 中 `deliveryFailures`、`directUndelivered` 很高。
  2026-11-01 实例：`deliveryFailures: 455`、`directUndelivered: 518`，同时调度消息大量未达。

#### 诊断步骤

**第 1 步：看 `delivery` 增量字段（0.2.6）。**

```json
"delivery": {
  "state": "delivered | queued | failed | partial",
  "delivered": 1, "queued": 1, "failed": 0,
  "targets": [
    { "sessionId": "…", "status": "delivered", "msgId": "…" },
    { "sessionId": "…", "status": "queued", "msgId": "…", "queuedUntil": "2026-…Z" },
    { "sessionId": "…", "status": "failed", "msgId": "…", "reason": "…" }
  ]
}
```

- `delivered`：已投进目标会话（不等于目标模型已读/已执行）。
- `queued`：已受理、暂存待补投；看 `queuedUntil` 与目标是否在宽限内重连。
- `failed`：未受理或必然投不到；看 `reason`。
- `state=partial`：部分目标成功、部分失败；按 `targets` 逐个处理。
- 旧桥/旧核心混配时 `delivery` 可能缺省；不要拿旧版返回的 `ok: true` 当送达证明。

**第 2 步：查投递账（仅 managed/forum）。**

```text
ws_delivery_status { "msgId": "<消息标识>" }
```

- 机器级状态：「已排队」「已到对方驿站」「已投进对方会话」「未达」；「已投进会话」不等于已读。
- 本机接收侧另有逐席位明细；远端只有机器级。
- **dispatch 没有持久投递账**：对 dispatch 的 `collabId` 查询会返回空并明确说明
  `dispatch 无持久投递账（纯内存模式）`。调度消息只能看 `delivery`、`ack` 或让组员回执。

**第 3 步：看计数器。**

```text
ws_status {}
```

路径：`net.dispatch.counters.deliveryFailures` / `net.dispatch.counters.directUndelivered`。

- `deliveryFailures`：拨号/写帧失败累计（包含重试），不是「每条消息失败一次」。
- `directUndelivered`：直投记录在等待窗内未确认、最终标记未达的累计。
- 两个计数都是**核心进程内累计**，核心重启归零；高计数只能证明链路有过问题，不能单独证明某条消息失败。
- 具体某条消息以 `delivery` / `ws_delivery_status` / `ack` 为准。

**第 4 步：确认目标是否在编、在线、可见。**

```text
ws_dispatch_scan {}
ws_status {}
ws_list_hosts {}
```

- dispatch：目标必须在 `record.slaves` 里；`toSessionIds` 只接受**完整 sessionId**，不接受显示名/短码。
  目标不在 dispatch 内会返回 `目标会话不在本 dispatch 内：<id>`。
- managed/forum：目标会话必须在场/在席；离线时按暂存/过期语义处理。
- `ws_list_hosts.self.sessions` 可看核心当前注册的会话短码（发现面口径）。
- `sessions/<sessionId>.json` 的 mtime 可辅助判断桥是否还在注册（`pid` 是核心 pid，不是桥 pid）。

**第 5 步：确认是否被静音/冻结/未验证。**

- 静音是席位级纯本机开关：实时内容不注入本会话，但落盘与机器级确认照旧。目标被静音时
  `delivery` 可能显示 `failed`/`reason` 含静音；由目标会话自己调用 `ws_set_mute { muted: false }` 解除。
- managed 冻结期只允许读台账、裁定、退出与终止；非治理消息会被丢弃。
- `joining`（两段式入席未完成）可收注入但禁发消息；等确认完成。

**第 6 步：看核心日志与目标会话 transcript。**

```powershell
Get-Content "$env:USERPROFILE\.waystation\logs\waystation.log" -Tail 300 |
  Select-String -Pattern '投递|未入队|队列|超时|ack|补投|静音|冻结'
```

```bash
grep -E '投递|未入队|队列|超时|ack|补投|静音|冻结' ~/.waystation/logs/waystation.log | tail -n 100
```

目标 transcript 是否在收到消息后继续推进，是区分「没送达」与「送达但没处理」的关键。

#### 修复动作

先分清载体：**dispatch 的 `delivery` 只会给 `delivered` 或 `queued`**（目标在发前已校验过）；
目标不在 dispatch、非成员、任务表满等会直接以顶层 `ok: false` + `message` 返回，不走 `delivery.failed`。
managed 的本机旁路与远端机器才可能出现 `delivery.failed`。按实际返回分支：

| 返回形态 | 动作 |
| --- | --- |
| `delivery.state=delivered` 但目标没反应 | 目标可能停在权限提示/回合未继续；按 §4.2 处理，不要重复轰炸 |
| `delivery.state=queued` | 等 `queuedUntil`；让目标会话调用任意 `ws_*` 工具触发桥重连/补投。目标已离席则过期，重新收编后再发 |
| 顶层 `ok:false`：`目标会话不在本 dispatch 内：<id>` | 用 `ws_dispatch_scan` 取完整 `sessionId`；`ws_dispatch_claim` 收编后按完整 ID 重发 |
| 顶层 `ok:false`：`本会话不是该 dispatch 的成员` | 发送会话本身未收编；让调度长收编它，或从调度长会话发送 |
| 顶层 `ok:false`：`dispatch 不存在（可能已结束或核心已重启）` | 按 §3 恢复/重建调度，再发 |
| 顶层 `ok:false`：`任务表已满（上限 1000）` | 完成/清理在途任务，或换新 `taskId`；未完成任务不会被自动裁剪 |
| 收编结果里出现 `本机会话不在线或不可见` | 这是收编判定，不是发送结果；先按 §2 恢复桥注册，再收编/重发 |
| `delivery.failed`（managed 本机旁路/远端） | 看 `reason`：席位静音由目标会话自行取消；注入失败/离席/队列拒绝按原因恢复目标后重发 |
| `ok:true` 但无 `delivery`（旧版） | 升级 0.2.6；升级前 `requireAck` 不可用，只能让目标回执/查收件 |

对关键任务：

```text
ws_send_message {
  "collabId": "<调度标识>",
  "type": "task",
  "toSessionIds": ["<完整 sessionId>"],
  "taskId": "t1",
  "requireAck": true,
  "text": "……"
}
```

- 目标收到后回执：

  ```text
  ws_send_message { "collabId": "<调度标识>", "ackFor": "<msgId>", "text": "收到" }
  ```

- 调度长会另收 `dispatch-ack` 通知；`delivery.ack = { required: true, state: "pending", pending: [...] }`
  表示「已投递但待确认」。
- 待确认默认 10 分钟超时；超时/目标离席/队列溢出会向调度长回报 `dispatch-ack-timeout`，不会静默挂起。
- 核心重启会丢 `pendingAcks`（内存态），重启后需要重新发 `requireAck` 的任务。

#### 预防

- 升级 0.2.6，使用 `delivery` 与 `requireAck`；不要以 `ok: true` 作为送达依据。
- 关键任务用 `requireAck`，并在超时后主动重发/换目标。
- 组员保持桥在线；无头 worker 的 `--allowed-tools` 包含回执工具。
- 不要对组员设置静音；调度消息是实时内容，静音会抑制注入。
- 定期看 `deliveryFailures`/`directUndelivered` 趋势；异常增长时先查网络/目标桥，而不是盲目重发。

### 4.2 跨会话消息被挂起（权限模式）

#### 症状

- `ws_send_message` 返回成功（或 Claude Code 的跨会话 `SendMessage` 返回 success），但目标会话没有处理。
- Claude Code 跨会话消息的返回可能带类似提示：

  ```text
  in that session's inbox, not yet read by its Claude — a [Cross-session delivery notice] follows
  if that session holds it (usually a different permission mode) or refuses it
  ```

- 目标窗口停在权限确认（permission prompt），或目标以不同 permission mode 运行。
- 2026-11-01 实例中，调度长用跨会话通道联系组员时，多次出现「消息已送达 inbox 但未被读取」，
  目标会话同时卡在权限确认/不同权限模式上。

#### 诊断步骤

1. **看目标会话窗口**：是否有待批准的权限提示（工具调用、文件写入、跨会话消息批准）。
2. **看目标 transcript 是否在收到消息后继续产生新条目**；只有用户消息/tool 结果才算推进。
3. **看 cc-connect 日志**（如果目标是 cc-connect 拉起的）：

   ```powershell
   Get-Content "$env:USERPROFILE\.cc-connect\logs\cc-connect.log" -Tail 100 |
     Select-String -Pattern 'permission request|message received|processing message|agent_session'
   ```

4. **区分通道**：
   - waystation 的注入：`delivery=delivered` 只代表文本已写进目标会话的注入口，不代表模型已读/已执行。
   - Claude Code 的跨会话 `SendMessage`：返回 success 也只代表进入对方 inbox；对方权限模式/未读状态会挂起。
   - 两者都不是「已读回执」。

#### 修复动作

1. **在目标会话本机处理权限提示**。权限类允许/拒绝必须由本机用户操作，不能由调度长远程代批。
2. 让目标会话调用一次 `ws_status` / `ws_check_inbox`（managed）或任意 `ws_*` 工具，推进回合并触发桥注册。
3. 对无头/服务拉起的组员，启动参数应显式放行所需工具，例如：

   ```bash
   WAYSTATION_ROLE=slave WAYSTATION_MASTER=master claude --name worker-1 \
     -p --input-format stream-json --output-format stream-json --verbose \
     --permission-mode dontAsk \
     --allowed-tools "Read Grep Glob Bash Edit Write mcp__waystation__ws_send_message mcp__waystation__ws_check_inbox mcp__waystation__ws_status mcp__waystation__ws_leave_collab"
   ```

4. 目标确实卡死时，重启目标会话/worker；重启后重新收编并重发任务。调度长自己的会话不要重启，
   除非按 §5 处理。
5. 关键任务使用 `requireAck`；不要把「注入成功」当成「已执行」。

#### 预防

- 无头组员使用 `--permission-mode dontAsk` 并在 `--allowed-tools` 中包含全部需要的 `ws_*` 工具。
- 不要把无人值守的 dispatch 组员跑在会弹权限确认的交互模式里。
- 调度长的重要指令要求回执；长时间无回执按 §4.1/§5 排查，而不是连续重发。
- **待验证**：不同 Claude Code 版本/权限模式下，注入消息被挂起的精确触发条件与恢复时点；
  本文只记录 2026-11-01 实例观察到的「inbox 未读 + 权限模式」现象。

### 4.3 QQ `msgseq` 去重（cc-connect）

#### 症状

- QQ 侧收不到 cc-connect 的回复；Claude 会话 transcript 里明明生成了回复。
- cc-connect 日志出现：

  ```text
  platform send failed ... returned 400: {"message":"消息被去重，请检查请求msgseq","code":40054005,...}
  ```

- 1.5.0 的典型原因：同一入站 `msg_id` 的多次回复没有递增 `msg_seq`，QQ 按重复消息丢弃，
  可能整回合回复都丢。2026-11-01 实例中该问题与 cc-connect 1.5.0 相关，升级 1.5.1-beta.4 后
  回复路径已恢复；但 **2026-11-02 实例仍在主动推送（unsolicited）路径看到 40054005**，见下方说明。

#### 诊断步骤

1. 查安装版本：

   ```powershell
   npm ls -g cc-connect --depth=0
   ```

   预期看到 `cc-connect@1.5.1-beta.4`（或更高）。

2. 查日志：

   ```powershell
   Get-Content "$env:USERPROFILE\.cc-connect\logs\cc-connect.log" -Tail 200 |
     Select-String -Pattern '40054005|msgseq|platform send failed|unsolicited'
   ```

3. 区分消息类型：
   - **回复**（有入站 `msg_id`，reply context）：1.5.0 的已知缺陷；升级后应恢复。
   - **主动推送**（`unsolicited events detected, relaying to platform`）：2026-11-02 本机实例在
     1.5.1-beta.4 上仍观察到 40054005；是否为同一缺陷、是否已在上游更高版本修复，**待验证/待上游确认**。
4. 确认服务是否真的重启并加载了新二进制：`Get-Service cc-connect` 的启动时间、日志里的 `config loaded`
   与 `qqbot ... ready`。

#### 修复动作

1. **升级到 1.5.1-beta.4 或更高**：

   ```powershell
   # 管理员 PowerShell；升级过程可能停掉服务并替换 exe
   npm install -g cc-connect@1.5.1-beta.4
   Start-Service cc-connect
   Get-Service cc-connect
   ```

   升级后服务可能处于 `STOPPED`（正常 shutdown，不是崩溃），必须管理员 `Start-Service` 拉起。
2. **验证**：日志出现 `config loaded`、`qqbot: ... ready`，且没有 config parse 错误。
3. **1.5.0 上的临时缓解**：约束「每条入站消息只回一次」；把多条回复合并为一条，避免同一 `msg_id`
   多次发送。这只能降低触发概率，不能根治。
4. **升级后仍有 40054005（主动推送路径）**：
   - 减少主动推送频率，合并为单条；
   - 关键进度走 waystation 调度内部通道，QQ 只发最终汇总；
   - 保留日志中的 `trace_id` 与版本号，交上游确认；不要假定「升级即全部修复」。

#### 预防

- 固定并记录 cc-connect 版本；升级后必须重启服务并检查日志首屏。
- 不要让调度长对同一条入站消息连续多次回复；把回复合并。
- 高频/中间进度留在 waystation dispatch（本机、不占 QQ 额度），QQ 只承担对用户的最终汇报。
- 微信侧另有 `context_token` 与 24h 额度限制，与 QQ `msgseq` 不是同一问题；本文不展开。

---

## 5. 调度长（master）会话被杀：cc-connect 重启/升级后

### 症状

- QQ/微信发消息没有回复；cc-connect 服务可能刚重启/升级过。
- `ListAgents` 显示本机出现新的 Claude 会话，旧调度长会话不在。
- `ws_status`/`ws_dispatch_scan` 显示调度丢失或 `pending-takeover`。
- cc-connect 日志可能只有服务启动，没有 `message received`/`processing message`。

### 诊断步骤

**第 1 步：看 cc-connect 服务状态。**

```powershell
Get-Service cc-connect | Select-Object Name,Status,StartType
Get-CimInstance Win32_Process -Filter "Name='cc-connect.exe'" |
  Select-Object ProcessId,CreationDate,ExecutablePath
```

**第 2 步：看 cc-connect 日志。**

```powershell
Get-Content "$env:USERPROFILE\.cc-connect\logs\cc-connect.log" -Tail 100
Get-Content "$env:USERPROFILE\.cc-connect\logs\cc-connect.log" -Tail 300 |
  Select-String -Pattern 'config loaded|message received|processing message|agent_session|permission request|ERROR|parse'
```

最近一次服务启动的 `service-stderr-*.log` 也要看（config 解析错误通常只在这里）：

```powershell
Get-ChildItem "$env:USERPROFILE\.cc-connect\logs\service-stderr-*.log" |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1 |
  Get-Content -Tail 80
```

**第 3 步：确认 agent 是否被拉起。**

- cc-connect **只在收到消息时拉起 agent**；仅重启服务本身不会产生新的调度长会话。
- 日志出现 `message received` → `processing message` 才说明入站消息已进入 agent。
- 若只有 `config loaded` 没有 `message received`，是平台侧/桥侧未收到消息，不是 waystation 调度问题。

**第 4 步：确认核心与调度状态。**

```powershell
waystation core status
```

```text
ws_status {}
ws_list_collabs {}
```

cc-connect 重启通常是**树杀**：核心、调度长桥、agent 一起退出。核心是否被重新拉起，取决于之后是否有
会话调用 `ws_*`（0.2.5+ 允许服务上下文通过 TCP 环回冷启核心；≤0.2.4 需要用户会话）。

**第 5 步：确认新旧调度长会话标识。**

- 同一 transcript 的 resume 通常沿用原 `sessionId`；cc-connect 可能以 `--resume` 恢复，也可能新建会话。
- 若 `ws_list_collabs` 的调度条目 `masterSessionId` 与新会话的 `sessionId` 不同，旧调度长已不可恢复，
  需要按 §3 B 接管。

### 修复动作

**A. 服务未运行：**

```powershell
# 管理员 PowerShell
Start-Service cc-connect
Get-Service cc-connect
```

**B. 服务运行但没有 agent：**

1. 从 QQ/微信给 bot 发一条任意消息（例如「在吗」），触发 cc-connect 拉起 agent。
2. 看日志是否出现 `message received` → `processing message`。
3. 新会话起来后，让它调用 `ws_status`；若核心不在，0.2.6 桥会冷启核心。
4. 调度按 §3 恢复：
   - 同一 `sessionId`：任意 `ws_*` 调用刷新心跳，`pending-takeover` → `active`。
   - 新 `sessionId`：等 `master_timeout_ms`（默认 3 分钟）后 `ws_create_collab { mode:'dispatch', name:'…' }` 接管；
     若 `dispatch.persist=false` 或状态文件丢失，按 §3 C 重建。

**C. 服务崩溃循环（config 解析失败）：**

1. 看 `service-stderr-*.log`，典型错误是 TOML 解析失败（例如 Windows 路径 `C:\Users\...` 在
   三引号字符串里被当成 `\U` unicode 转义）。
2. 恢复最近的备份：

   ```powershell
   Copy-Item "$env:USERPROFILE\.cc-connect\config.toml.bak-<时间戳>" `
             "$env:USERPROFILE\.cc-connect\config.toml" -Force
   ```

3. 修正路径写法：TOML 内 Windows 路径用正斜杠 `C:/Users/...`，或把每个反斜杠双写为 `C:\\Users\\...`。
4. 重启服务并验证：

   ```powershell
   Restart-Service cc-connect -Force
   Get-Service cc-connect
   Get-Content "$env:USERPROFILE\.cc-connect\logs\cc-connect.log" -Tail 30
   ```

   必须看到 `config loaded`，且 stderr 没有 parse 错误。

**D. 调度长角色丢失：**

- 确认 cc-connect 服务环境里有 `WAYSTATION_ROLE=master`（启动期环境变量；工具参数不能声明角色）。
- 修改服务环境/配置后必须重启 cc-connect 才生效；它只在启动时读配置。
- 重启后按 B 唤醒 agent，再按 §3 恢复调度。

**E. 核心没起来：**

- 按 §1 处理。0.2.5+ 可以从服务上下文冷启核心（TCP 环回）；≤0.2.4 需要用户桌面会话先拉起核心。

### 预防

- 升级/重启 cc-connect 安排在空闲窗口；重启前让调度长记录任务表，重启后按 §3 恢复。
- 修改 `config.toml` 前备份；Windows 路径一律正斜杠或双反斜杠；改完先看 `service-stderr` 再重启服务。
- 保持服务环境 `WAYSTATION_ROLE=master`；不要让被接管的会话以 master 身份复活（启动命令先清理
  `WAYSTATION_ROLE`/`WAYSTATION_MASTER`，再按需设置）。
- cc-connect 只在收到消息时拉起 agent：升级后如果没有新消息，不要误判为调度长崩溃。
- 日志里记录服务启动时间与版本；升级后核对 `config loaded`、平台 `ready`、`message received` 三项。

---

## 6. 派发踩错对象：会话名会变，以 `sessionId` 短码为准

### 症状

- 调度长按会话名派发，任务发给了没有该项目上下文的会话；对方拒收/答非所问。
- `ws_status`/`ws_dispatch_scan` 里的名字与实际会话错位（例如显示成另一个会话名）。
- 会话名会自己变化（Claude Code 重命名、重启、resume 导致）。
- 2026-11-01 实例：`ai-63 → ai-5b`、`waystation-71 → waystation-26` 等名字变化；按名字派发把
  MCU 页面复核清单发给了没有上下文的会话。

### 诊断步骤

**第 1 步：以扫描结果的 `sessionId` 为准，不要以 `name` 为准。**

```text
ws_dispatch_scan {}
```

返回的每个会话包含：

```json
{
  "sessionId": "<完整会话标识>",
  "name": "<Claude Code 显示名，可能变化>",
  "kind": "interactive | bg | unknown",
  "entrypoint": "…",
  "role": "master | slave | none",
  "status": "…",
  "claimedBy": "…",
  "claimable": true
}
```

`name` 只是显示提示；`sessionId` 才是稳定键。

**第 2 步：交叉核对多个面。**

| 面 | 字段 | 口径 |
| --- | --- | --- |
| `ws_dispatch_scan` | `sessions[].sessionId` | 完整 `sessionId`；当前 `ws_dispatch_claim` 必须用它 |
| `ws_status.dispatch` | `slaves[].sessionId` | 完整 `sessionId` |
| `ws_list_collabs` | 调度条目 `masterSessionId`、`slaveCount` | 完整 `sessionId` |
| `ws_list_hosts` | `self.sessions` | **短码**（会话标识前 8 字符） |
| 会话状态文件 | `sessions/<完整 sessionId>.json` | 文件名是完整 `sessionId`；文件内 `pid` 是核心 pid |
| Claude Code `ListAgents` | 会话名 + `[短码]` | Claude Code 自己的显示名与短码，可能与 waystation 不同步 |

**第 3 步：识别名字错位的根因。**

- Claude Code 改名/重启会改变 `name`；旧名字可能仍留在某些缓存/显示面。
- 同名/近名会话可能同时存在；按名字匹配必然有歧义。
- 不同机器/不同数据根的显示面可能不同；以本机核心的 `sessionId` 为准。

### 修复动作

1. **立即停止按名字派发**。在调度笔记里维护「任务 → 完整 sessionId / 短码 → 名称」映射。
2. 用完整 `sessionId` 重新派发：

   ```text
   ws_send_message {
     "collabId": "<调度标识>",
     "type": "task",
     "toSessionIds": ["<完整 sessionId>"],
     "taskId": "t1",
     "text": "……"
   }
   ```

3. 发错的目标若已被收编，先释放：

   ```text
   ws_dispatch_release { "sessionId": "<完整 sessionId>" }
   ```

   再收编正确目标：

   ```text
   ws_dispatch_claim { "sessionIds": ["<正确完整 sessionId>"] }
   ```

4. 同一个 `taskId` 重新发给正确目标会重建/改派任务；如果旧任务已经污染，换新 `taskId` 并说明。
5. 0.2.6 起扫描/状态计划返回稳定会话短码；以短码做人工核对，但**收编与 dispatch 定向仍使用完整
   `sessionId`**（当前 `ws_dispatch_claim` / `toSessionIds` 都是精确全等，不接受短码）。
   若当前构建的返回里还没有短码字段，取 `sessionId` 前 8 字符人工比对。

### 预防

- 派发只用完整 `sessionId` 或经版本确认支持的短码；**永远不要用会话名做路由键**。
- 每次核心重启/cc-connect 重启后重新 `ws_dispatch_scan`，不要复用旧名单。
- 收编后核对返回的 `sessionId` 与目标会话自报的 `sessionId`（让目标调用 `ws_status` 自证）。
- 在任务笔记里记录短码与任务上下文，避免「名字变了就找不到人」。
- 升级到 0.2.6 的会话身份修复；**待验证**：短码字段名与 `ws_dispatch_claim` 是否接受短码以实际版本为准。

---

## 7. 数据目录异常

### 7.1 `dispatch/state.json` 损坏 / 写不进去

#### 症状

- 核心重启后调度丢失，但 `dispatch.persist` 是开启的。
- 日志出现：

  ```text
  调度状态文件损坏——按无状态启动
  ```

  或

  ```text
  调度状态持久化失败——本进程内降级为纯内存（编排继续）
  ```

- 目录里出现 `state.json.corrupt-<时间戳>`。
- `ws_list_collabs` 的调度条目 `persisted: false`（写失败降级时）。

#### 诊断步骤

1. 确认文件与隔离副本：

   ```powershell
   Get-ChildItem "$env:USERPROFILE\.waystation\dispatch" | Select-Object Name,Length,LastWriteTime
   ```

   ```bash
   ls -l ~/.waystation/dispatch/
   ```

2. 看日志中的 `reason`（JSON 解析失败、字段形态不符、不可读、写盘失败等）。
3. 读状态文件头部，确认版本与关键字段：

   ```powershell
   Get-Content "$env:USERPROFILE\.waystation\dispatch\state.json" -Raw | ConvertFrom-Json |
     Select-Object v,savedAt,@{n='status';e={$_.dispatch.status}}
   ```

   ```bash
   jq '{v,savedAt,status:.dispatch.status}' ~/.waystation/dispatch/state.json
   ```

4. 确认磁盘可写、没有满、ACL 没变；`dispatch.state_path` 指向的父目录是否可创建。
5. 若 `dispatch.persist=false`：本来就没有状态文件，重启丢失是预期行为，不是损坏。

#### 修复动作

1. **损坏隔离后按无状态启动是设计行为**：核心不会部分恢复坏文件；不要手工把 `.corrupt-*` 改回
   `state.json` 继续用。
2. 重建调度并按 §3 C 重新收编、重发任务。
3. 需要分析损坏原因时，保留 `.corrupt-<ts>` 与日志；可用 `jq`/文本编辑器只读查看，但不要写回。
4. **写失败降级**：
   - 修磁盘/权限/路径；
   - 当前核心进程已降级纯内存，不会自动恢复持久化；重启核心后重新读取配置并尝试写盘；
   - 重启前先让调度长记录任务表，避免丢失。
5. 如果确认不再需要持久化，可显式设置：

   ```json
   { "dispatch": { "persist": false } }
   ```

   但这会让核心重启后必定重建，仅适合短生命周期编排。

#### 预防

- `dispatch.state_path` 放在本地持久磁盘，避免临时目录/网络盘/同步盘。
- 不要手工编辑 `state.json`；所有变更走调度工具。
- 升级/重启前备份 `dispatch/state.json`。
- 监控日志中的持久化失败告警；`persisted: false` 时不要假设重启可恢复。

### 7.2 磁盘增长（`collabs/`、`logs/`、`archive/`）

#### 症状

- 数据根持续变大；`collabs/` 累积大量已结束协作；`logs/waystation.log*` 很大；`archive/collabs/` 增长。
- 调度任务表/完成项累积（任务表上限 1000，完成项按 `retention.dispatch_hours` 裁剪）。

#### 诊断步骤

```powershell
$root = Join-Path $env:USERPROFILE '.waystation'
Get-ChildItem $root -Directory | ForEach-Object {
  $bytes = (Get-ChildItem $_.FullName -Recurse -File -ErrorAction SilentlyContinue |
            Measure-Object Length -Sum).Sum
  [pscustomobject]@{ Dir = $_.Name; MB = [math]::Round(($bytes / 1MB), 2) }
} | Sort-Object MB -Descending
```

```bash
du -sh ~/.waystation/* | sort -h
```

找大文件：

```powershell
Get-ChildItem $root -Recurse -File -ErrorAction SilentlyContinue |
  Sort-Object Length -Descending | Select-Object -First 20 FullName,Length
```

```bash
find ~/.waystation -type f -printf '%s %p\n' | sort -nr | head -20
```

看保留期配置：

```powershell
Get-Content "$env:USERPROFILE\.waystation\config.json" -Raw | ConvertFrom-Json |
  Select-Object -ExpandProperty retention
```

```bash
jq '.retention' ~/.waystation/config.json
```

默认值：

```json
{
  "retention": {
    "dispatch_hours": 24,
    "collabs_days": 30,
    "logs_days": 14,
    "cleanup_interval_h": 6,
    "dry_run": false
  }
}
```

#### 修复动作

1. **先 dry-run 预览**：编辑 `config.json`，把 `retention.dry_run` 设为 `true`。
2. 重启核心以执行启动清理（核心只在启动时和周期定时器执行清理；没有单独 CLI）：

   ```powershell
   waystation core stop
   # 之后任意 ws_* 调用触发冷启
   ```

   ```bash
   waystation core stop
   # 之后任意 ws_* 调用触发冷启
   ```

3. 看日志确认统计：

   ```text
   保留期清理完成   { dryRun: true, ... }
   ```

4. 预览无误后把 `dry_run` 改回 `false`，再重启核心（或等待 `cleanup_interval_h` 周期）。
5. 清理规则（保守）：
   - 只处理 `completed`/`terminated` 且超过 `collabs_days` 的协作目录；
   - 归档为 `archive/collabs/<collabId>.json.gz`（gzip JSON 清单，不是标准 tar），归档成功后才删原目录；
   - 有 `recovery.json`、旧形态、未知目录、席位未归档、活跃/冻结/提案中的协作**永不清理**；
   - 归档文件本身也按 `collabs_days` 再保留一个窗口；
   - 日志按大小轮转（`logMaxBytes` 默认 1 MiB、`logMaxFiles` 默认 5）与 `logs_days` 双条件取先到者。
6. **不要手工删除活跃协作目录**。确需手工清理时，先停核心、备份，只删已确认完成/终止且已归档的目录。
7. 当前没有归档恢复 CLI；`.json.gz` 只作审计/排查依据，不要把它当可一键恢复的备份。

#### 预防

- 保持默认保留期，或按磁盘容量调小 `collabs_days` / `logs_days`；不要设为极大值。
- 定期看数据根大小与 `archive/collabs/`；升级前做一次 dry-run。
- 不要把 `logDir`/`dispatch.state_path` 指到无限增长的共享目录。
- 调度完成项按 `dispatch_hours` 裁剪；未完成任务永不裁剪，长期挂起的任务要人工收口。

### 7.3 相邻：`config.json` 损坏

`config.json` 损坏时核心会把它改名为 `config.json.corrupt-<ts>`，按默认值重建并继续启动。
这可能导致身份名、端口、`dispatch.*`、`retention.*` 回到默认值。处置：

1. 找 `config.json.corrupt-*` 备份，读取原配置；
2. 对照当前 `config.json` 恢复身份名、端口、调度/保留期设置；
3. 重启核心生效（核心只在启动时读配置）；
4. 不要手工删除 `.corrupt-*`，它是唯一的原始配置副本。

---

## 8. 边界与待验证事项

以下内容没有在本机/本版本上完全确认，遇到时按「先取证、再动作」处理：

- **会话短码字段**：0.2.6 计划在 `ws_dispatch_scan`/`ws_status` 返回稳定短码；如果当前构建尚未包含
  该改动，字段名、是否支持短码收编/定向以实际安装版本返回为准；本文在未确认处一律建议使用完整 `sessionId`。
- **权限模式挂起**：不同 Claude Code 版本/权限模式下，注入消息被挂起的精确条件与恢复时点待验证；
  2026-11-01 实例观察到的是「inbox 未读 + 不同权限模式」现象，不是 waystation 的送达保证。
- **QQ 主动推送 `msgseq`**：1.5.1-beta.4 的回复路径已恢复；2026-11-02 本机实例在 `unsolicited` 主动推送
  路径仍看到 40054005。是否同一缺陷、是否在更高版本修复，待上游确认。
- **桥进程与会话映射**：本文的进程树定位法来自 2026-11-01 实例；不同终端/启动器（cc-connect、schtasks、
  手工终端）下父子链可能不同，杀桥前先用 `ListAgents`/启动时间交叉确认。
- **手工清理陈旧 `run/core.json`**：仅在确认 pid 已死、无活跃核心时使用；不同版本的核心仲裁对
  不可解析描述符的清理路径可能不同，优先让桥/核心自行处理。
- **自定义数据根**：`WAYSTATION_HOME` 必须在核心、桥、CLI、状态栏全部一致；只在 MCP 注册里注入时，
  CLI/状态栏会读默认目录，出现「状态看不到但工具能用」的假象。
- **0.2.6 真机心跳时延**：0.2.6 的实现测试环境实测单桥/三桥重连约 1.2–1.5 秒；真机在 cc-connect 服务树、
  高负载、多桥场景下的时延**待验证**，本文只承诺「应自动恢复」，不承诺固定秒数。

---

## 附录 A：命令速查

| 目的 | Windows（PowerShell） | POSIX（bash） |
| --- | --- | --- |
| 核心状态 | `waystation core status` 或 `node "$env:USERPROFILE\.waystation\app\bin\waystation.js" core status` | `waystation core status` 或 `node ~/.waystation/app/bin/waystation.js core status` |
| 有序停核 | `waystation core stop` | `waystation core stop` |
| 强制停核 | `waystation core stop --force` | `waystation core stop --force` |
| 读核心描述符 | `Get-Content "$env:USERPROFILE\.waystation\run\core.json" -Raw \| ConvertFrom-Json` | `jq . ~/.waystation/run/core.json` |
| 跟踪核心日志 | `Get-Content "$env:USERPROFILE\.waystation\logs\waystation.log" -Tail 100 -Wait` | `tail -f ~/.waystation/logs/waystation.log` |
| 列出 waystation 进程 | `Get-CimInstance Win32_Process \| Where-Object { $_.CommandLine -match 'waystation' } \| Select ProcessId,ParentProcessId,Name,CommandLine` | `ps -eo pid,ppid,args \| grep waystation \| grep -v grep` |
| 杀指定桥 | `Stop-Process -Id <pid> -Force` | `kill -9 <pid>` |
| 看核心进程会话号 | `Get-Process -Id <pid> \| Select Id,SessionId,StartTime` | `ps -p <pid> -o pid,sid,etime,cmd` |
| 数据根大小 | 见 §7.2 PowerShell 片段 | `du -sh ~/.waystation/* \| sort -h` |
| cc-connect 服务 | `Get-Service cc-connect` | （本机为 Windows 服务） |
| 重启 cc-connect | 管理员 `Restart-Service cc-connect -Force` | — |
| cc-connect 版本 | `npm ls -g cc-connect --depth=0` | — |
| cc-connect 日志 | `Get-Content "$env:USERPROFILE\.cc-connect\logs\cc-connect.log" -Tail 100` | — |

## 附录 B：日志与计数速查

核心日志关键行：

| 日志片段 | 含义 | 章节 |
| --- | --- | --- |
| `发现陈旧启动失败记录（失败进程已退出/心跳已停）——按陈旧处理并重新冷启` | 0.2.6 把死进程的 `startupError` 当陈旧残留 | §1 |
| `核心重启对账：标记内席位等待宽限内重绑` / `核心重启对账完成` | 核心重启后的席位对账 | §2 |
| `dispatch「…」已恢复（调度长：…）；组员与任务表保留` | 持久化恢复且调度长在线 | §3 |
| `dispatch「…」已恢复为待接管：调度长「…」当前不在线` | 持久化恢复但调度长离线 | §3 |
| `调度长「…」已恢复心跳——dispatch「…」继续执行` | 待接管期旧调度长恢复 | §3 |
| `调度状态文件损坏——按无状态启动` | `state.json` 损坏并隔离 | §7.1 |
| `调度状态持久化失败——本进程内降级为纯内存（编排继续）` | 写盘失败降级 | §7.1 |
| `调度状态残留超期（待接管且心跳超过保留期）——已删除，不恢复` | 启动清理超期 pending | §3/§7 |
| `保留期清理完成` | 清理统计（含 dry-run） | §7.2 |
| `保留期清理：已归档并删除协作目录` | 协作归档后删除 | §7.2 |
| `保留期清理：已删除超期日志` | 日志按时间清理 | §7.2 |

`ws_status` 计数：

| 路径 | 含义 |
| --- | --- |
| `net.dispatch.counters.deliveryFailures` | 拨号/写帧失败累计（含重试） |
| `net.dispatch.counters.directUndelivered` | 直投未确认、最终未达累计 |
| `net.dispatch.counters.staleConnections` | 陈旧连接计数（链路健康辅助） |
| `net.dispatch.counters.expiredTotal` | 过期未确认计数 |
| `net.inbound.*` | 入站准入/去重/注入/丢弃计数 |
