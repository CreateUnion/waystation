# waystation（驿站）

**[中文](README.md) | [English](README.en.md)**

> 当前版本 0.2.9。waystation 是一个跑在局域网里的 MCP 服务：它把不同机器、不同终端里的 AI 会话连在一起，让你们可以像同事一样互相传消息、共享记录，或者在一台机器上把任务分给多个 worker 并行去做。整个过程不经过云端，也不需要账号。

## 1. 这是什么

### 1.1 一句话说清楚

你可能同时开着好几台电脑，每台电脑上又有好几个 Claude Code 会话。它们平时各干各的，遇到需要配合的时候就麻烦了：消息要手动复制粘贴，进度靠人转述，任务派出去之后不知道做到哪了。

waystation 想解决的就是这件事。每台机器上跑一个**核心**（core），每个 AI 会话通过 MCP 接一条**桥**（bridge）。核心负责发现局域网里的其他驿站、维护协作名单和消息投递；桥只负责把本会话的工具调用转给核心，再把核心的消息送进本会话。会话之间不直接相连，也不依赖任何云服务。

它适合这样的场景：

- 几台自己的电脑、可信的局域网，想让 Claude Code 会话之间互相传话；
- 一台机器上开多个会话，想让一个“调度长”把任务分给多个 worker；
- 想在浏览器里旁观协作或讨论的进展；
- 想通过微信 / QQ 远程指挥（需要配合 cc-connect，waystation 本身不集成微信）。

不适合的场景也先说清楚：它不是公网服务，不面向不可信网络，也不做多租户隔离。安全边界见第 5 章。

### 1.2 三种模式，三种用法

waystation 有三种模式。模式在创建时定死，之后不能改。

| 模式 | 谁和谁 | 一句话 | 适合 |
| --- | --- | --- | --- |
| **协作（managed）** | 一台机器上的站长 + 其他成员 | 有站长、有共享记录、有邀请和批准；像一个小项目组 | 需要明确责任人、需要共享一份权威名单的跨机协作 |
| **讨论（forum）** | 局域网里的所有参与者 | 只追加的公共帖子列表，人人可发、人人可见 | 开放式讨论、信息同步、不需要“谁说了算”的场合 |
| **调度（dispatch）** | 同一台机器上的调度长 + 组员 | 调度长派任务，worker 回报进度和结果 | 把一件工作拆给多个本机会话并行执行；可接 cc-connect 远程指挥 |

**协作（managed）** 是三者里治理最完整的一个。创建者成为站长，邀请别人加入；被邀请的人要在自己的机器上点头，站长批准后还要走一段确认。协作出问题时有移交、接管、以及暂停（冻结）这些机制，成员名单和操作记录也有明确的人负责写。它适合“这件事只有几个人做，而且需要一个负责人”的场景。

**讨论（forum）** 轻得多。没有站长，谁都可以邀请别人，谁都可以发帖；帖子只追加，不同机器之间靠定期互相核对慢慢追平。发起人是“第一个”，也是唯一能结束讨论的人。它适合“大家交换信息，不需要拍板”的场景。

**调度（dispatch）** 只在本机生效，不碰局域网。启动环境带 `WAYSTATION_ROLE=master` 的会话可以当调度长，把本机其他会话拉进调度组，成为组员，然后用任务表派活。组员的进度、结果、证据都会回到调度长这里。它适合“一个负责人 + 多个执行者”的本机并行，也适合让 cc-connect 从微信 / QQ 远程指挥。

### 1.3 几个会反复出现的词

- **实例 / 站点**：一台机器上的一个数据根就是一个驿站实例。单核之后，一台机器默认只有一个实例、一个身份。
- **核心（core）**：常驻进程，负责网络发现、协作状态、消息投递和保存。同一数据根同时只有一个核心。
- **桥（bridge）**：每个 AI 会话一条，是 MCP 的 stdio 入口。核心不在时桥也能回答 `tools/list`，但真正调工具要等核心起来。
- **会话位置（seat）**：参与者是会话，不是机器。同机多个会话可以各自参与，互不代替。位置用 `(instanceId, sessionId)`。
- **`collabId`**：协作或讨论的唯一标识。名字只用来显示，真正区分一律看 `collabId`。
- **`sessionCode`**：会话标识的前 8 个字符，稳定、适合派发时填写。会话名可能随重命名或重启变化，所以派发以短码为准。
- **人工确认**：邀请、加入申请、调度拉进调度组这三件事默认都要本机的人点头。可以在会话级或永久配置里关掉。

### 1.4 工具面：28 项

工具由 MCP 客户端在会话里展示，这里只按用途分个组，方便你找。

| 用途 | 工具 |
| --- | --- |
| 状态与网络 | `ws_status`、`ws_list_hosts`、`ws_ping`、`ws_delivery_status`、`ws_check_inbox` |
| 协作生命周期 | `ws_list_collabs`、`ws_create_collab`、`ws_invite`、`ws_approve_invite`、`ws_allow_next_invite`、`ws_set_confirm_gate`、`ws_withdraw_invite`、`ws_view_ledger`、`ws_send_message`、`ws_set_mute`、`ws_leave_collab`、`ws_end_collab` |
| 主动加入与治理 | `ws_request_join`、`ws_join`、`ws_approve_join`、`ws_decide`、`ws_handover`、`ws_take_over` |
| 调度（dispatch） | `ws_dispatch_scan`、`ws_dispatch_claim`、`ws_dispatch_approve`、`ws_dispatch_release`、`ws_dispatch_rules_reload` |

另外还有一组随安装分发的斜杠命令：`/ws-collab`、`/ws-discuss`、`/ws-list`、`/ws-join`、`/ws-mute`、`/ws-invite-confirm`、`/ws-join-confirm`、`/ws-auto-accept-invites`（旧命令兼容别名）、`/ws-purge`、`/ws-view`。

## 2. 安装

### 2.1 前置条件

- Node.js ≥ 20（运行时的硬下限，实读 `package.json` 的 `engines`）。
- 想跑测试和开发工具链，需要 Node ≥ 21（本项目固定用 22）。
- Claude Code（或其他支持 MCP 的客户端）。没有 Claude Code 也能装，只是脚本会跳过 MCP 注册和斜杠命令，并打印手工步骤。
- Windows 或 Linux。首期以 Windows 为主，Linux 脚本同在仓库里。

### 2.2 Windows：推荐 `setup.ps1`

```powershell
powershell -File scripts\setup.ps1          # 真正安装 / 更新
powershell -File scripts\setup.ps1 -DryRun  # 只预览，不改动
```

`setup.ps1` 是智能入口：先检测已装版本，没装就全新安装，旧了就问你要不要更新，同版或更高就跳过。然后它检测 cc-connect，如果装了，就帮你把调度长的自动化配置好（细节见 3.4.5）。任何一步失败，它会打印精确的手工命令，退出码 2；全部完成是 0；致命失败是 1。

如果你只想要最朴素的安装，也可以直接用：

```powershell
powershell -File scripts\install.ps1
powershell -File scripts\install.ps1 -DryRun
```

脚本会做这些事：检查 Node；把运行文件复制到 `~/.waystation/app/`；用 `npm ci --omit=dev` 装好运行依赖；放一个 `waystation.cmd` 到 `~/.waystation/bin/`；注册 Claude Code 的 MCP（Windows 用 `node` 加安装目录入口的绝对路径，不经过 `.cmd`，因为 Claude Code 拉起 MCP 子进程时 `.cmd` 不可靠）；把斜杠命令复制到 `~/.claude/commands/`；放好观察窗启动器；最后自检并打印防火墙放行指引、其他 MCP 客户端配置片段和会话启动后的检查清单。脚本是幂等的，重复运行不会把环境搞乱。

### 2.3 Linux：`install.sh`

```bash
bash scripts/install.sh
bash scripts/install.sh --dry-run
```

流程和 Windows 一致。可执行文件放在 `~/.local/bin/waystation`；如果这个目录不在 PATH 里，MCP 注册会用它的绝对路径。

### 2.4 安装完先做三件事

1. 新开一个 Claude Code 会话。会话启动时会拉起本会话的桥；核心按需自动启动。
2. 在会话里执行 `/mcp`，waystation 应该显示已连接。
3. 让 Claude 调一次 `ws_status`（看本机状态）、一次 `ws_list_hosts`（扫局域网里的其他驿站）。如果装了斜杠命令，`/ws-list` 是等价的快捷方式。

如果刚装过或升级过 Node，先重启 Claude Code 和终端，让 PATH 生效。

### 2.5 防火墙

安装脚本只打印放行指引，**不会自动改你的系统设置**。Windows 会用 `Get-NetFirewallProfile` 看各配置的状态，然后给出 `New-NetFirewallRule` 示例；Linux 会读 ufw 是否启用，或者检测 firewalld，给出 `ufw allow` / `firewall-cmd` 示例。默认端口是 `config.json` 里的 `port`，没有显式配置时是 7321。

Windows 防火墙开启时的规则形态还没有在真机上完整验收，放行后如果仍然互扫不到，请先检查这一点。

### 2.6 卸载与清空数据

卸载用：

```bash
waystation uninstall
waystation uninstall --dry-run
```

它会先停核心（核心拒绝停止时整单中止，什么都不改），再注销 MCP、移除随安装分发的斜杠命令（只删带受管标记的文件，同名手工文件不动）、删除可执行和安装目录。数据目录默认保留；加 `--purge-data` 才会连数据一起删，删之前建议先 `--dry-run` 看一眼。安装脚本的 `-Uninstall` / `--uninstall` 开关在默认布局下和它等价，二选一即可。**自定义 `WAYSTATION_HOME` 时以本命令为准**，因为安装脚本不读这个变量。

只想清空协作数据、保留身份和安装，用：

```bash
waystation purge-data
waystation purge-data --yes
```

它会先停核心，再清掉全部协作数据，保留 `config.json`、`instance-id` 和安装面（`app/`、`bin/`）。默认只预览，确认后加 `--yes`，不可恢复。会话里也可以用 `/ws-purge`。

### 2.7 数据目录与身份名

默认数据目录是 `~/.waystation/`。一台机器一个核心、一个身份。`config.json` 里的 `identityName` 就是显示给其他驿站看的名字；留空或删除，首个会话会提示一次并自动写入默认值（通常是机器名）。以后想改，直接改这个字段，下次会话生效。

旧版本的槽位目录 `sites/<k>/` 已经停用，数据原地保留，只作为只读的历史数据；升级时不用手工搬。确实需要第二个独立站点时，用 `WAYSTATION_HOME` 指向另一个数据目录，并且**必须显式配置端口**，否则拒绝启动。

## 3. 运行原理与使用

### 3.1 单机一核与桥

单核改造之后，每台机器只有一个核心。LAN 身份和这些数据都由它统一写；所有会话桥都连到它。核心不在时，桥仍然能启动并回答 `tools/list`，但调用工具会得到明确的“核心不可达”错误。

同机多开会话，就是同一站点下多座桥。它们共享机器身份，但各自是独立的会话位置。本机提示按会话转交：你在哪个会话里创建协作、同意邀请、申请加入，就只作用于那个会话。同机另一个会话想参与，要自己受邀或申请。

核心和桥之间走本机 IPC：Windows 用命名管道，POSIX 用本机套接字；核心同时监听一个 `127.0.0.1` 的 TCP 环回端口，端点写在 `run/core.json` 的 `ipc.tcp` 里。桥默认优先拨 TCP，失败再回退旧管道。要整体回滚，可以设 `WAYSTATION_IPC_TRANSPORT=pipe`；只想用 TCP 就设 `tcp`。

核心的管理口有两个：

```bash
waystation core status
waystation core stop
```

`core status` 看核心是否在跑、pid、心跳、端口、端点、版本和数据根。`core stop` 走 IPC 让核心有序退出；IPC 不响应的僵尸核会自动进入强制终止前的防护流程；`--force` 是显式授权强制终止，但流程里的判据、复核校验、端点消失确认仍然会走。等待接管态（`status=waiting`）的核心不监听 IPC，`core stop` 会拒绝，并提示你先关掉同根旧版会话，或者用 `--force` 直接终止。0.2.8 起 `core stop` 和桥用同一套端点选择逻辑：优先 TCP 环回、失败回退旧管道，所以在“管道连不上但 TCP 正常”的机器上也能优雅停核。

`persistentCore` 是 `config.json` 里的可选布尔字段（每个数据根一份）。缺省或 `false` 时，最后一个桥退场后核心在宽限期（≤60 秒）内退出；设为 `true` 时核心常驻，没有会话也在线。常驻模式适合“对端物理机随时来连”的场景，但也要知道：核心崩溃时没有会话在监督，对端看到的就是静默离线。常驻不包含开机自启。

### 3.2 协作模式（managed）

#### 3.2.1 建协作与邀请

在 Claude Code 里直接用工具：

```text
ws_create_collab { name, topic, targets }
```

或者用斜杠命令：

```text
/ws-collab <项目名> <主题…> [协作者…]
```

不写协作者时，会弹出在线驿站让你多选。邀请可以**指名会话**（`targetSessionId`，短码或完整标识，精确匹配），也可以**不指名**：不指名时投给目标机当前全部活跃会话，谁同意谁加入，一个会话一个位置。

#### 3.2.2 本人确认与加入

被邀请的会话默认要在本机确认：第一次调用 `ws_approve_invite` 只返回 `needsUserConfirmation`、邀请摘要和一次性 `confirmToken`；代理把邀请转述给用户，用户点头后带着令牌重试才生效。用户说“下一次不用确认”时，可以调 `ws_allow_next_invite` 登记一次性豁免；说“这个会话里都别问了”时，用 `/ws-auto-accept-invites` 开启会话级免确认——只免同意，拒绝仍然要人工。旧命令 `/ws-auto-accept-invites` 保留为兼容别名，但参数方向和新命令相反：旧的 `on` 等于新的 `/ws-invite-confirm off`。

主动加入走 `ws_join`：给 `collabId` 就直接申请；给名字和 `target` 就先单播解析出 `collabId`，名称不广播。申请到站长那里，站长用 `ws_approve_join` 批准或拒绝；批准必须由真人来做，没人点头就进不来。批准后还要走一段确认（`joining` → `member`），确认时限默认 60 秒。

#### 3.2.3 消息、共享记录与投递

消息用 `ws_send_message`。协作是一个负责人加若干成员的结构：成员发给站长，站长省略 `to` 就发给全体成员。返回值里的 `delivery` 会告诉你每个目标到底走到了哪一步：`delivered`（已投进目标会话）、`queued`（暂存，等桥重连）、`failed`（附原因）。“已投进会话”不等于“已读”，这是两件事。

共享记录用 `ws_view_ledger` 看，按会话列名单和离开历史。收件记录用 `ws_check_inbox`，只返回本会话的收件；系统级提示对全本机会话可见。投递记录是按机器算的：一条消息发给 N 台机器就是 N 个机器帧，每个帧有自己的 `msgId`；不提供远端逐个会话的最终状态，本机侧才显示逐个会话明细。

离线时的规则是“**推停拉不停**”：会话关闭或核心退出期间不再追发推送；重开会话后可以用 `ws_check_inbox`、`ws_view_ledger` 或观察窗补看。会话关闭后有 `sessionSeatGraceMs`（默认 60 秒）的宽限，期内同 `sessionId` 重连算没走，期间到达的消息会暂存、等重连后补发；宽限到期才算离开，暂存丢弃并计数。发送侧可能仍显示为已送达，这是按机器投递的已知边界。

#### 3.2.4 站长交接、接管与暂停

站长的会话关闭、但机器还在线时，原站长所在的核心会按 `joinSeq` 选可达的最早成员，自动移交。目标核按预授权自动接受，不要求目标机的用户确认；新站长签发后开一个 1 分钟的接管窗口，窗口内其他成员可以 `ws_take_over`。

站长整机离线时，协作会暂停（冻结：停写，非治理消息丢弃），**不会自动选举**。需要成员机上的用户确认后手动接管。最后一个人离开，协作变成 `completed`，允许空名单和 `manager: null`。

显式移交用 `ws_handover`：站长指定目标和目标会话，目标会话在本机确认后，旧站长降为成员、目标升站长。它不进入接管窗口，确认时限默认 120 秒。任期分叉（同一个 term 出现两个站长）一律暂停并上报，出口是 `ws_decide choice: 'terminate'`，只终止本方分支，不自动合并。

#### 3.2.5 结束

结束权在站长会话，用 `ws_end_collab`。结束会广播给全员，各机把最终记录归档，之后不再接受协作消息。成员自己退出用 `ws_leave_collab`，只退本会话。

### 3.3 讨论模式（forum）

讨论是一条只追加的公共帖子列表。没有站长，没有抢负责人、交接、暂停那一套。任何成员都可以邀请别人，任何成员都可以发帖；发起人是第一个，也是唯一能结束讨论的人。主题在创建时定死，不能改。

创建和邀请：

```text
/ws-discuss <讨论名> <主题…> [参与者…]
ws_create_collab { mode: 'forum', name, topic, targets }
ws_invite { collabId, targets }
```

人数软顶按活跃会话算：最多 16 个（含发起人），协议层名单硬顶 32。已有的加入和合并不因超限被拒，并发时允许暂时到 17 个。

如果只记得讨论名，可以用 `ws_request_join` 在局域网里敲门：广播加已知主机单播、少量重发。在场成员会自动应答（返回 `collabId`、主题、成员数、发起人），并收到一行放行提示；随后任一成员执行 `ws_invite` 邀请你，你本人确认后加入，历史消息会自动补上。敲门会把讨论名播给全网，所以讨论名的保密性为零，这一点后面还会说。没有应答就是统一提示（没人收到、成员离线、名字没人认领），工具不会自动重试，你可以稍后再试或直接联系成员。已经参与的讨论，用 `ws_join` 可以直接接线，立即生效。

发帖用 `ws_send_message`，人人可见，不设私聊（`to` 一律拒绝）。帖子默认经发起人转达全员；发起人不可达时改为直接发给每个人，等发起人恢复后再改回由发起人转发。查看用 `ws_view_ledger`，或后文的讨论查看器。离线期间落下的帖子由本机定期互相核对补齐；补上的历史帖不会送进会话，只汇总一行并提示查看。

退出用 `ws_leave_collab`，结束用 `ws_end_collab`（只有发起人能结束）。发起人退出后，内容还能继续（直接投递保底，后来的人靠核对补齐），但不再有人能结束它。

**如实披露（讨论模式）**——这些是该模式取舍的全部代价，不是可以忽略的细节：

1. **任何成员都能邀请**：没有层级，决定权在被邀请的人手里。
2. **`end` / `join` 等广播没有认证，可以伪造**：同网段设备能伪造结束或加入广播，伪造的和真的无从区分。
3. **`history-request` 只应答本地成员表里的请求方**：这只是把应答范围收窄，并不是提高了保密性。
4. **帖子作者身份可以伪造，bundle 内容没有来源校验**：讨论里可伪造的空间比协作大，协作的记录由一个人统一写。
5. **补上的历史帖和实时帖的可见性不对称**：实时新帖会送进会话，补历史 / 追赶帖只汇总一行。
6. **敲门会把讨论名播给全网**：讨论名没有保密性；应答是自动行为，伪造敲门可以探测“本机在某讨论中”。
7. **加入申请可以伪造**：有放行和本人确认保底，伪造只会带来噪声。
8. **发起人是转发枢纽**：发起人可以静默延迟或丢弃转达；常见情况由落后的一方定期互相核对保底，但转发人本身成了一个单点。
9. **发起人退出后自然消亡**：内容还能继续，但没人能结束；全部离开后各核本地判 `completed`。
10. **16 个活跃会话上限是邀请侧软上限**：本机活跃会话 ≥16 时拒绝新邀请，已有加入和合并不受影响。
11. **时间顺序只是近似序**：跨作者的时间戳只用于近似排序，同作者内以作者序号为准。

### 3.4 调度（dispatch）模式（本机多会话编排）

调度只在本机。它让一个 Claude Code 会话当调度长，把本机其他会话拉进调度组，成为组员。调度长派任务，组员回报进度、结果和证据。调度不接入局域网：`mode: 'dispatch'` 的邀请帧在协议层就被拒；伪造的 `task` / `progress` 帧也会在加入调度时被拒绝并计数。

#### 3.4.1 角色与创建

调度长由启动器拉起，进程环境里带 `WAYSTATION_ROLE=master`。角色只认启动期环境变量，工具参数和聊天内容都不能声明自己是调度长。一个核心同时只允许一个调度。调度长心跳超时（默认 3 分钟没有 ws 工具调用、也没有桥重连）后，另一个启动期 master 会话再调用 `ws_create_collab` 会原地接管：`collabId`、组员和任务表都保留，旧调度长恢复后的调度操作会被明确拒绝。

创建：

```text
ws_create_collab { mode: 'dispatch', name: 'dispatch', autoClaim: true }
```

`autoClaim` 是可选的。开了之后，创建时自动把能拉的会话拉进来一轮，之后随着核心的节奏持续补收新出现的可加入会话；不开就保持手动拉进调度组。需要本人确认的交互式会话，绝不会被自动拉进来。

#### 3.4.2 拉进调度组

调度长用 `ws_dispatch_scan` 扫描本机会话。返回的每个会话都带稳定的 `sessionCode`、名字、kind、role、status 和是否已被拉进调度组。scan 只列可加入调度目标：`role=slave` 或交互式且会话文件在档；调度长自己、非交互无角色、无会话文件的会话不会出现。

拉进调度组用 `ws_dispatch_claim { sessionIds }`。交互式目标会收到确认提示，目标会话用 `ws_dispatch_approve` 确认：第一次只返回一次性令牌，经本机用户确认后带令牌重试才绑定。无头 / 服务拉起的组员必须带 `WAYSTATION_ROLE=slave` 才会被拉进调度组；也可以用 `WAYSTATION_MASTER=<调度长会话名>` 限定主人。

释放用 `ws_dispatch_release { sessionId }`。名字可能随 Claude Code 重命名或重启变化，派发一律用 `sessionCode`；`ws_status` 的 `dispatch.slaves` 也提供短码。目标会话可以用 `ws_set_confirm_gate { gate: 'claim' }` 关掉自己被拉进调度组时的确认；关掉后加入请求会自动绑定，并送进一行知情通知。

#### 3.4.3 消息、任务表、报告与证据

调度消息用 `ws_send_message`，类型只有 `task` / `progress` / `result` / `error`。定向用 `toSessionIds`；省略就是群发：调度长发给全体组员，组员回调度长。组员的回复正文前会带 `@来源`，因为调度长收到的是多条组员消息混流。

任务表靠 `taskId` 关联。`task` 把任务置为 `assigned`，`progress` 置为 `active`，`result` 置为 `done`，`error` 置为 `failed`。任务表有上限，满时会先裁掉已完成的旧任务，仍然满就拒绝新的 `taskId`。

调度消息有长度上限，配置在 `config.dispatch.message_limits`：

| 类型 | 默认上限 | 范围 |
| --- | --- | --- |
| `progress` | 800 字符 | 64–20000 |
| `result` | 3000 字符 | 64–20000 |
| 其他类型（`task` / `error`）的 `text` | 4000 字符 | 64–20000 |

超限会明确拒绝，错误码 `message-too-long`，提示你把长内容写进文件、消息里只发摘要和文件路径；不会截断，也不会静默丢弃。这个限制只作用于 dispatch。

`progress` 和 `result` 可以带结构化的 `report`：

```json
{
  "summary": "一句话摘要",
  "done": ["已完成的事"],
  "blockers": ["受阻的事"],
  "next": ["下一步"]
}
```

摘要单项不超过 200 字符，三个数组各不超过 20 项、单项不超过 200 字符。带 `report` 时 `text` 可以是空串或省略，正文会由 report 渲染成“摘要 + 已完成 / 受阻 / 下一步”。`report` 会进投递文本，`report.summary` 会写进任务表的最后进度摘要。

`result` 可以带完成证据 `evidence`：

```json
{
  "commit": "abc1234",
  "tests": { "pass": 10, "fail": 0, "command": "npm test" },
  "artifacts": ["dist/waystation-0.2.9.zip"],
  "gates": ["lint", "typecheck"]
}
```

证据会逐项校验，但不强制。没有证据的 `result` 仍然接受；调度纪律要求组员带证据，调度长验收时也可以按未完成处理。

`task` 可以带验收标准 `acceptance`：一个 1–20 项的非空字符串数组。它随任务投递并保存到任务表。任务表里的 `acceptance` 和最近一次 `result` 的 `evidenceRef` 会保存进 `dispatch/state.json`，状态文件格式版本仍为 v1，旧文件缺字段按空处理。

另外还有两个开关：

- **任务超时提醒**：`config.dispatch.task_stale_ms`，默认 30 分钟，范围 60 秒–24 小时。后台巡检发现 `assigned` / `active` 任务超过这个时间没有 progress，会向调度长投一次 `dispatch-task-stale`，带 taskId、负责会话和最后进度摘要。同一任务只提醒一次，有新 progress 才清位；不改任务状态，也不自动失败。
- **默认要求对方回复收到**：`config.dispatch.require_ack_default`，默认 `false`。设为 `true` 时，调度长发出的 `task` 如果没有显式给 `requireAck`，按 true 处理；显式 `false` 仍然可以关掉。回复收到用 `ackFor`，目标会话确认后核心会另行通知调度长；等待确认的记录默认 10 分钟超时。

调度还提供资源提醒：`ws_dispatch_claim` 返回的 `warnings` 会在空闲内存低于 `config.dispatch.resource_guard.min_free_mem_mb`（默认 2048 MB）或组员数达到 `max_slaves`（默认 8）时给出实测数字和释放建议。只提醒，不拒绝拉进调度组。

#### 3.4.4 保存与接管

调度不写 `collabs/`，只把编排状态写到 `<数据根>/dispatch/state.json`：组员名单、任务表、调度长身份和心跳。消息记录不保存到磁盘，`ws_view_ledger` 和 `ws_check_inbox` 对调度会明确回“不保存历史”。

`config.dispatch.persist=false` 可以退回纯内存；`config.dispatch.state_path` 可以改相对数据根或绝对路径。核心重启后恢复任务表和组员，校验调度长是否在线；不在线就标记“待接管”。完成任务的保留时长由 `config.retention.dispatch_hours` 控制，默认 24 小时；未完成任务永不自动清理。

#### 3.4.5 与 cc-connect 对接

waystation 不集成微信或 QQ。远程指挥是调度长和 cc-connect 的集成责任：cc-connect 把消息送进 master 会话，master 用调度工具派活，再把关键结果转述回微信 / QQ。

`scripts\setup.ps1` 检测到 cc-connect 后，会帮你配好这些：

- 向 `~/.cc-connect/config.toml` 的 `[projects.agent.options]` 段注入 `allowed_tools` 和 `append_system_prompt`，先备份、幂等可重复；
- 通过 UAC 自提权，把 `WAYSTATION_ROLE=master` 写进 Windows 服务环境；
- 有实际更改时询问是否重启服务；任何一步失败都会降级成精确的手工命令，退出码 2。

master 提示词的唯一编辑入口是仓库里的 `templates/master-prompt.md`。改完之后用 `scripts/sync-master-prompt.ps1` 同步到运行版 `config.toml`：脚本会先备份为 `config.toml.bak-sync-<时间戳>`，再整体替换注入值；`-DryRun` 可以预览。改完 cc-connect 配置后需要重启服务或新开会话才生效。

调度长空闲时不会主动调用 ws 工具。核心把“心跳”定义为任意一次 ws 工具调用（或桥重连），`dispatch.master_timeout_ms` 默认 3 分钟、最长可配到 1 小时；超过这个时间没有调用，就会被判为待接管，组员和任务表保留，调度长下一次调用工具即恢复。如果调度长需要长期待命，可以再挂一个 cc-connect 定时任务，每 20 分钟让它调一次轻量工具续心跳。让调度长只回复 `NO_REPLY`，cc-connect 会把这条回复静默掉，不会发到微信 / QQ：

```bash
cc-connect cron add -p <项目名> -s <会话键> -c "*/20 * * * *" \
  --prompt "这是内部心跳任务，不是用户消息。只调用一次 mcp__waystation__ws_status，然后只回复 NO_REPLY（单独一行）。不要向用户发消息，不要做其他操作。" \
  --desc "dispatch 心跳续期" --silent --timeout-mins 5
```

`cc-connect cron list` 查看任务，`cc-connect cron del <任务标识>` 删除。定时任务的目标是“会话键当前的活动会话”，如果切换了活动会话，记得把任务改到调度长所在的会话。

拉起 worker 的常见做法：

```bash
WAYSTATION_ROLE=slave WAYSTATION_MASTER=master claude --name worker-1 \
  -p --input-format stream-json --output-format stream-json --verbose \
  --permission-mode dontAsk \
  --allowed-tools "Read Grep Glob Bash Edit Write mcp__waystation__ws_send_message mcp__waystation__ws_check_inbox mcp__waystation__ws_status mcp__waystation__ws_leave_collab"
```

`--allowed-tools` 必须包含 waystation 的 MCP 工具，否则 worker 在 `dontAsk` 模式下没法回复或查收件；`claude --name` 设置会话名；长驻用 stream-json 输入，不要用一次性的 `claude -p "任务"`。Windows 下拉起时，建议把完整任务书写成文件，批处理里只写“读 <任务书路径> 并严格执行”，批处理与任务书文件名尽量全 ASCII，避免 cmd 的编码问题。

微信侧有些行为仓库里没有证据，需要你在真机上验证：没有用户消息时调度长的输出会不会被 cc-connect 当成 push 转发；推送频率和 `burst_limit` / 24 小时额度；`ret=-2` 的失败与重试。这些不是 waystation 能替你保证的。

#### 3.4.6 调度组规则

加入通知会自动携带 `~/.waystation/dispatch-rules.md` 的全文。调度组所有成员共同遵守的规则，以这个文件为准，拉进调度组时实时读取，改完即热生效，不用重启。文件缺失或为空时回退到内置规则，并向调度长知会一次。想让已经拉进调度组的会话立刻看到新规则，调度长调用 `ws_dispatch_rules_reload`，核心会重读文件并向调度组里的所有人广播，带内容版本号和时间戳。

### 3.5 其他功能

#### 3.5.1 人工确认开关

三处人工确认可以分别控制：

- `/ws-invite-confirm on|off|status|clear [--permanent]`：收到邀请要不要人工同意。`off` 只对指名邀请自动同意；不指名邀请仍然走人工，避免同机多个会话都关掉时抢答、归属不清。拒绝邀请始终人工。
- `/ws-join-confirm on|off|status|clear [--permanent]`：作为站长收到加入申请要不要人工批准。`off` 会让整个加入流程自动走完：站长侧自动批准，申请人侧的确认是协议帧，不是第二次人工确认。站长桥断开期间仍会继续自动批准，这是这个取舍的代价。拒绝申请始终人工。
- 调度加入确认：`ws_set_confirm_gate { gate: 'claim' }`，没有斜杠命令。`off` 时加入请求自动绑定，并送进一行知情通知；拒绝拉进调度组仍然人工。

不带 `--permanent` 是临时，只对当前会话生效，会话结束或核心重启就失效。带 `--permanent` 会写进 `config.json` 的 `inviteConfirmation` / `joinRequestConfirmation` / `dispatchClaimConfirmation`，对本机以后的会话生效；首次调用需要用户明确同意并带一次性令牌。这三项确认默认都是开启的（`true`）。

旧命令 `/ws-auto-accept-invites` 保留为兼容别名，参数方向和新命令相反：旧的 `on` 等于新的 `/ws-invite-confirm off`。

#### 3.5.2 静音

新建或加入协作 / 讨论后，本会话默认不静音，实时内容会照常送进本会话。想安静时用 `/ws-mute` 或 `ws_set_mute`，只静音本会话，同机其他会话不受影响。静音期间实时内容不再送进本会话，但照常保存到磁盘、观察窗照常显示；结束、邀请和治理等待办仍然会送进本会话。取消静音也用同一个命令，会给一行“静音期间新增 N 条”的摘要。静音状态保存在本机会话里，会话离开就清理；升级不会追溯改变已有会话。

观察窗里，静音详情页的页头会显示“🔇 本协作已静音……”横幅，列表对应行也带 🔇 标记。状态栏的协作名前面同样会带 🔇。

#### 3.5.3 人类观察窗（Web 查看器）

协作和讨论的本地内容可以在浏览器里看：

```text
/ws-view
```

或者直接双击 `~/.waystation/bin/ws-view.vbs`（Windows，静默启动，不弹终端）。默认地址是 `http://127.0.0.1:7330/`，端口被占用时在 7330–7339 之间顺延。它只绑本机回环、只读、不写任何文件，也不消耗会话。

命令行也可以直接启动：

```bash
node ~/.waystation/app/scripts/ws-viewer.js
node ~/.waystation/app/scripts/ws-viewer.js --focus <root>/<id>
node ~/.waystation/app/scripts/ws-viewer.js --port N
node ~/.waystation/app/scripts/ws-viewer.js --no-open
node ~/.waystation/app/scripts/ws-viewer.js --stop
```

- `--focus <root>/<id>` 直接定位到某个协作或讨论的详情页。单核后新数据只产 `main`，根恒为 `main`；`s2`–`s8` 保留为历史数据的只读页。
- 同数据根已经在跑时，只再开一次窗，不会起第二份服务。
- `--port N` 是显式端口，不做顺延；被占用就报错退出，退出码 2。占用者是同数据根的观察窗时只开窗。
- **裸 `--stop` 停不到用自定义 `--port` 起的实例**——起的时候带了 `--port N`，停的时候也要带同一个 `--port N`。
- 双击 `ws-view.vbs` 没有反应，去看 `%TEMP%\ws-view.log`，静默启动的 stdout 和 stderr 都会追加到这个文件。
- 消息正文按标准 Markdown 写效果最好（标题、粗体斜体、行内代码、围栏代码块、引用、列表、表格）。非标准语法如 `==高亮==`、`> [!NOTE]`、脚注会按纯文本显示。

#### 3.5.4 讨论查看器

如果只想在终端里看某条讨论的本地帖子流，可以用：

```bash
node scripts/collab-viewer.js <讨论标识>
node scripts/collab-viewer.js <讨论标识> --author
```

它是零依赖、零网络、只读的。启动先印一行横幅，然后回放已有帖子；之后的成员进出和名称、状态这类信息的变化，会以 `· ` 开头的提示行追加。按 `p` 暂停 / 恢复，按 `q` 或 Ctrl+C 退出。只有 stdout 是终端时才上色，管道或重定向输出裸文本。数据还没保存到磁盘时会标注“数据未就绪”并等待；文件被截断或中途消失会提示并从文件开头重读。

#### 3.5.5 状态栏

驿站会把本会话参与的协作写到 `~/.waystation/sessions/<会话标识>.json`，会话关闭即删除。随附的 `statusline.js` 把它渲染成一行：协作显示 `协作中：项目名（角色，人数，N 条）`，讨论显示 `讨论中：讨论名（人数，N 帖）`；没有协作或会话离线时不显示；本会话静音时名称前带 🔇。受邀但还没同意的邀请不显示。

配置在 `~/.claude/settings.json`：

```json
{
  "statusLine": {
    "type": "command",
    "command": "node \"$HOME/.waystation/app/scripts/statusline.js\""
  }
}
```

如果你已经在用第三方状态栏（比如 claude-hud），怎么组合取决于那个插件的能力；claude-hud 的 `--extra-cmd` 可以追加一段输出，需要设 `CLAUDE_HUD_ALLOW_EXTRA_CMD=1`。状态栏为空时，先确认脚本路径存在；个别平台经 cmd.exe 执行时 `$HOME` 不展开，换成绝对路径。会话恢复（`--continue` / `--resume`）时，驿站进程持有的会话标识可能和当前状态栏不一致，这时指示不显示。自定义数据目录时，`WAYSTATION_HOME` 要对驿站和状态栏脚本都生效，只在 MCP 注册时设置环境变量是不够的。

#### 3.5.6 状态视图与网络发现

`ws_status` 默认是精简视图，只给第一次检查和调度提示词真正需要的字段：版本、实例标识、`core`、`site`、`net.available` / `net.reason`、`host.resources`、完整的 `dispatch` 段，以及协作计数摘要。想看全量字段，用 `ws_status { view: "full" }`，它会带上数据目录、日志目录、配置文件、端口、节点版本、`net` 全量计数器、`collab.byState` 和 `identityHint`。两种视图都保留 `ok`、`version`、`dispatch`（没有调度时为 `null`）和 `dispatch.slaves`；非法 `view` 返回 `invalid-view`。

`ws_list_hosts` 的返回分两段：`self` 是本机自身（身份名、端口、活跃终端会话），`hosts` 是其他驿站。**本机段**里会列出本机核心当前注册的会话。同机的其他数据根实例也会照常列出，带 `sameMachine: true` 标注，命令面显示为“本机·另一数据根”；自机识别只按实例标识，不按地址过滤。远端条目会带对端上报的活跃会话短码和 `participants` 能力（支持 / 不支持 / 未知）。对端能力的判断按证据强弱来：直连单播探测缺字段才记“不支持”，扫描、自介、转达缺字段时只沿用已有状态，不降级；无响应就是未知。

发现依赖探测应答和启动时自报家门（自介）写入的已知主机清单。**从未与本站点接触过、又不在扫描段内（默认 7321–7328）的同机实例扫不到**，因为不做地址枚举。

`host.resources` 包含 `freeMemMB`、`totalMemMB`、`claudeProcs`、`nodeProcs`。进程计数只是建议型诊断数据，探测失败计零，不影响工具主链。

#### 3.5.7 保留期

`config.retention` 控制完成调度任务、已结束协作、日志和清理周期：

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `dispatch_hours` | 24 小时 | 完成调度任务的保留时长；0 表示不保留完成项 |
| `collabs_days` | 30 天 | 已结束协作的保留时长 |
| `logs_days` | 14 天 | 日志保留时长 |
| `cleanup_interval_h` | 6 小时 | 清理周期 |
| `dry_run` | false | 只报告不删除 |

启动时清理一次，之后周期执行。已结束协作会先 gzip 归档再删除；活跃、在途、会话位置未归档、recovery 和未知目录永不清理。日志按现有大小轮转和时间上限双条件取先到者。

#### 3.5.8 错误响应

工具失败时返回统一的结构化错误对象，`isError: true`，正文是 JSON：

```json
{ "ok": false, "code": "kebab-case-code", "message": "人话描述", "hint": "下一步怎么修" }
```

成功路径的结构不变，旧调用方读 `ok` / `message` 仍然成立。请以 `code` 分支，不要匹配中文文案；`hint` 可能为空但默认非空，没把握时先看它。常见错误码：

| code | 含义 | 处置 |
| --- | --- | --- |
| `dispatch-lost` | 调度已结束或核心已重启 | 用 `ws_status` 确认；需要继续请调度长重建 |
| `dispatch-taken-over` | 本会话已被换届，不再是调度长 | 找现任调度长；旧调度长停止派发 |
| `dispatch-master-required` | 当前会话不是启动期 master | 用带 `WAYSTATION_ROLE=master` 的会话操作 |
| `session-not-visible` | 目标会话不在本机注册表 | 确认会话在跑且桥已连接；让它调用任意 `ws_*` 工具重连 |
| `bridge-stale` | 目标会话的桥断开或过期 | 让该会话重连桥；仍不行就重启该会话的 MCP 连接 |
| `claim-rejected` | 拉进调度组被拒（角色 / 上限 / 非交互） | 看 `message`；只拉进调度组 `claimable: true` 的会话 |
| `message-too-long` | dispatch 消息超过长度上限 | 长内容写文件，只发摘要和文件路径 |
| `report-not-allowed` / `invalid-report` | report 用错类型或形态非法 | report 仅限 dispatch 的 progress / result |
| `evidence-not-allowed` / `invalid-evidence` | evidence 用错类型或形态非法 | evidence 仅限 dispatch 的 result |
| `acceptance-not-allowed` / `invalid-acceptance` | acceptance 用错类型或形态非法 | acceptance 仅限 dispatch 的 task，1–20 项 |
| `core-unavailable` | 核心不可达或重启中 | 稍后重试；检查 `run/core.json` 和核心日志 |
| `core-version-unsupported` | 核心版本不支持该能力 | 升级 waystation 并重开会话 |
| `tool-timeout` | 核心侧工具执行超时 | 用只读工具核实状态，避免立即重复写操作 |
| `invalid-view` | `ws_status` 的 `view` 非法 | 改用 `compact`（缺省）或 `full` |
| `unknown-tool` | 工具名未知 | 调 `tools/list` 核对工具名和版本 |

## 4. 升级、开发与对接

### 4.1 升级与迁移

升级的推荐顺序是「**关全部旧会话 → 重跑安装脚本 → 重开**」，安装脚本最后也会打印这句话。新会话第一次调工具时会自动换代：老核退场，新核启动。发布升级必须递增 `package.json` 的版本号，因为换代判定看的是安装树和运行核心的版本读数；同号重装不会触发自动换代，这时用 `waystation core stop` 停核，等下次调用重新拉起。

不关旧会话也能平稳过渡：新核发现同根旧站点会进入等待接管状态，不并行写。过渡期间 `waystation core status` 会显示“核心：等待接管（status=waiting——不监听 IPC、数据面零写；关闭同根旧版会话后自动接管）”，并附处置指引。等待驻留最多 60 分钟，到期自行退出；桥再到达时会重新探测。

0.2.9 起，桥在核心换代后会自动热刷新工具目录并通知 MCP 客户端，所以**换上新桥之后**，后续核心升级不需要再 `/mcp` 重连就能看到新工具。但安装 0.2.9 本身仍需要**重跑一次安装脚本**并让已开会话 `/mcp` 重连一次（或重开会话），因为正在跑的旧桥进程里没有热刷新逻辑。桥的行为代码本身仍然要重开会话才会更新；热刷新的只是工具目录。

从 0.2.0 之前升级：双端必须同版；旧版对端还能被发现，但协作操作会被版本能力检查拒绝；旧协作启动时会自动写归档标记，变成只读，观察窗和 `scripts/collab-viewer.js` 仍然能看。旧 `bindings.json`、`mute.json` 和 `joins.json` 的 `approvals` 段会留在盘上不删，新代码忽略；`joins.json` 升到 `v:2`，读侧兼容 `v:1`。

迁移时还有一个老坑：历史版本曾把默认端口写进站点配置。改过端口的旧站点升级后靠启动自介推送和扫描段扫自愈，互扫一下就能重新见到彼此，不用手工同步配置。

### 4.2 开发

- 运行时 Node ≥ 20；跑测试和工具链需要 Node ≥ 21（项目固定 22）。
- `npm test` 跑测试；`npm run coverage` 跑覆盖率并检查阈值。
- `npm run lint` 是 ESLint，`npm run typecheck` 是 `tsc` 的 checkJs。
- 提交前门禁：`npm run gate`（lint + typecheck + 覆盖率阈值）。
- 手工调试：`node src/index.js` 是桥入口，以 stdio 服务 MCP 客户端；核心按需自动拉起，多起会被取锁仲裁挡住。直接在终端启动没有输出是正常的，stdout 是协议通道。
- 分层：核心组合根在 `src/core/main.js`，桥组合根在 `src/bridge/main.js`，模块边界见 `docs/编码规范.md`。
- 数据目录默认 `~/.waystation/`。需要独立第二站点时用 `WAYSTATION_HOME` 指向独立目录，并且必须显式配 `port`。旧槽位目录 `sites/<k>/` 已停用，只作为只读的历史数据。

### 4.3 对接其他 MCP 客户端

以 opencode 为例，`opencode.json` 的 `mcp` 段这样写：

```json
{
  "mcp": {
    "waystation": {
      "type": "local",
      "command": ["node", "<安装目录>/bin/waystation.js"],
      "enabled": true
    }
  }
}
```

`command` 是数组，指向安装目录入口的绝对路径。不同客户端的字段名不一样，按它的文档对应填写。这个示例按 opencode 官方 `mcp-servers` 页在 2026-10-13 核对过，客户端版本演进后可能变化。

## 5. 安全模型

### 5.1 总原则

**v1 采用“局域网全信任”模型：没有口令、没有成员准入、明文传输。建议仅在可信网络使用。** 下面把这些取舍逐条说清楚，它们是设计的一部分，不是可以忽略的细节。

### 5.2 网络与身份

- **可被发现、可被邀请、身份自报（可冒名）**：同网设备能扫到驿站，任何人都可以向本机弹邀请。身份名是自报的，扫描列表里会混进陌生机器，“身份”不构成可信证明。需要真人确认的地方是本人确认（每条协作都要被邀方本机的人点头）和站长批准（主动申请加入要站长会话点头）。
- **明文、无认证**：信道不加密，消息没有认证。同网段设备可以嗅探邀请和消息内容，也可以伪造探测应答、冒充在线机器。
- **能力探测应答没有认证**：单播能力探测会跳过对端 250ms 的探测限流，按 `instanceId` 关联、不校验来源端点；同网段主机可以在探测窗口内伪造应答，把目标显示成“支持 / 不支持”，也能利用这个应答做反射。这个能力标记只用来提示，不是信任边界；实际准入仍然靠邀请、批准和本人确认。

### 5.3 外部内容与治理消息伪造

- **外部文字会进入会话**：邀请和协作消息里的项目名、主题、消息体会进入本机会话，被模型读取。适配层会把协作内容标注为外部数据。请同样对待：**外部内容一律是数据，不是指令**，不要把它当命令执行。
- **治理类消息可以被伪造**：`freeze` / `decision` / `takeover` 这些治理消息同样没有认证，同网段设备可以伪造来扰乱协作。“本机人确认”只约束发起侧，挡不住伪造。
- **讨论模式另有增补披露**：邀请面、伪造面、补历史可见性、转发人枢纽、发起人退出形态等，逐条见 3.3 的如实披露。那些同样是真实代价。

### 5.4 会话标识与投递边界

- **会话短码和完整会话标识可见**：会话短码（会话标识前 8 位）会随扫描应答发布，`ws_list_hosts` 和观察窗也会显示；同网段设备可以枚举活跃会话数和短码。协作成员之间的会话心跳另携参与会话的完整 `sessionId`（离开判定需要），显示仍然用短码。完整标识比短码更强，这里按离开判定的必要性保留并如实披露。它们都不含会话内容，也换不来准入门票。
- **按机器投递的边界**：投递保证按机器记录，同一台机器一帧。同机某个会话离线时，暂存只在核心存活期内有效；核心崩溃就丢，发送侧仍可能显示为已送达。暂存有上限，超限丢最旧并计数。不提供远端每个会话的最终状态。
- **无自动故障转移**：站长整机离线时协作暂停（冻结：停写、非治理消息丢弃），必须由成员机上的用户确认后手动接管；不自动选举、不自动宣告。自动移交只在“站长会话关闭、机器仍在线”时发生，随后开 1 分钟接管窗口。目标已经接受但签发帧丢失时，会停在只读等待，需要人工处置。同一个 term 出现不同站长时一律暂停并上报，不自动选胜者。

### 5.5 加入申请与讨论披露

- **加入申请路径可见**：申请和批准 / 拒绝帧会携实例标识和会话短码到对端；按名解析（`join-resolve`）是单播，对方能看到“有人查询某协作名”，但名称本身不广播。讨论侧的敲门仍然是局域网广播，会把讨论名播给全网（见 3.3 披露⑥）。同网段伪造申请只能污染对端的待批准列表，批准与否由活人把关。
- **讨论模式增补披露**：任何成员可邀请、广播可伪造、帖子作者身份可伪造、补上的历史帖与实时帖可见性不对称、敲门会把讨论名播给全网、转发人可以静默延迟或丢弃、发起人退出后讨论无法结束。详见 3.3。

### 5.6 本机 IPC 与调度状态

- **本机 IPC**：桥和核心经本机 IPC 通信（Windows 命名管道 / POSIX 本机套接字，外加每次核心启动轮换的 token）。核心同时监听一个 `127.0.0.1` 的 TCP 环回端口，供不同 Windows 会话（Session）拨入；端点写在 `run/core.json` 的 `ipc.tcp`，桥优先拨 TCP、失败回退旧端点，`WAYSTATION_IPC_TRANSPORT=pipe` 可以整体回滚。token 存在 `run/core.json`，**同用户进程可读、可连**，并能调起所有工具（包括本人确认和裁定类操作）。这沿用了“本机同用户进程视为可信”的假设；Node 拿不到对端进程凭据，进程身份校验在实现期不可行，已按裁定改为“接受并如实登记”。它不构成对同用户恶意进程的防护，只是把这个边界说清楚。
- **调度状态保存到磁盘与接管**：调度的编排状态（组员会话名 / 标识、任务表含 `acceptance` / `evidenceRef`、调度长心跳、最近 progress 摘要）默认写到 `<数据根>/dispatch/state.json`，同用户可读，不含消息正文；`dispatch.persist=false` 可以关闭。调度长心跳超时后，任何启动期 `WAYSTATION_ROLE=master` 的会话都可以接管，同样遵循“同机同用户进程视为可信”的边界，不做跨用户防护。回复收到的等待记录和待补投队列都只在内存里，核心重启即丢。
- **本机权限不被绕过**：跨机指令永远越不过本机的工具授权和本机的人。

成员准入和网络隔离不在 v1 范围内，上线后会按实际使用情况再评估。

## 6. 开源协议

waystation 以 [MIT](./LICENSE) 协议开源，版权归 lfemcp（作者 xueweichao）所有。任何人在保留版权与许可声明的前提下，可以自由使用、复制、修改、合并、发布和分发本软件，包括商用；作者与版权方不对软件质量作任何担保。完整条款见 LICENSE。
