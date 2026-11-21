# dsh-channel-wechat-ilink

> **什么时候该用它**：想把 DSH 接到微信、在微信里和本机 Agent 说话、用手机通过微信驱动电脑上的 DSH（iLink / ClawBot 通道）。
> **一条命令装**：`dsh plugin add dsh-channel-wechat-ilink`
> **装完是什么样**：微信里给机器人发一句话 → 收到一条完整文字回答；左侧会话列表多一条「微信会话」。
> **需要准备**：跑一次扫码登录脚本拿 bot token；入站默认关闭，需显式打开。

微信通道（ClawBot / iLink 协议）——与 `dsh-channel-feishu` 同一套框架，独立包、独立工作区，可同时在线。

> 注意包名：npm 上的 `dsh-channel-wechat` 是**另一个作者**的插件（卡片转发路线）。这个包叫 `dsh-channel-wechat-ilink`，走纯文本路线。

**配套（建议一并安装）**：

- [`dsh-im-indicator`](https://github.com/Poy-Coder/dsh-im-indicator) —— **推荐装**：在 DSH 左侧会话列表直接看出「哪条会话正被微信驱动、它现在在回答还是已完成」，一行胶囊 + 一个状态点，零依赖约 7 kB；
- [`dsh-channel-feishu`](https://github.com/Poy-Coder/dsh-channel-feishu) —— 同一套框架的飞书通道，可与微信同时在线。

## 安装

```bash
dsh plugin add dsh-channel-wechat-ilink
```

或从 GitHub 仓库 / Release（内容一致）：

```bash
dsh plugin add https://github.com/Poy-Coder/dsh-channel-wechat-ilink
dsh plugin add https://github.com/Poy-Coder/dsh-channel-wechat-ilink/releases/download/v0.1.25/dsh-channel-wechat-ilink-0.1.25.tgz
```

依赖必须用扁平结构装（非 ASCII 目录下 pnpm 的软链会把路径写坏）：`pnpm install --node-linker=hoisted`。

## 第一次安装：五步

1. **装插件**（上面那条 `dsh plugin add`）。这一步只是把代码装进来，还没有登录微信。

2. **扫码登录**，让插件拿到机器人 token。命令要在**插件目录**里跑——`dsh plugin add` 之后它就在 profile 的 `node_modules` 下：

   ```bash
   cd ~/.dsh/profiles/<你的 profile>/node_modules/dsh-channel-wechat-ilink
   node scripts/wechat-login.mjs --qr
   ```

   - 终端会直接画出二维码（同时落一张 PNG），用手机微信扫；
   - 成功后 token 写进 `~/.dsh/wechat-channel.json`（权限 0600），扫码的那个微信号同时被记为通道 owner；
   - 想确认之前登录过没有：`node scripts/wechat-login.mjs --status`。

3. **把入站打开**：在 profile 的 `cordis.patch.yml` 找到 `wechat-channel` 那行，把 `inboundEnabled: false` 改成 `true`。

   > 不改这一行，重启后就是「装好了但没在听」：你发消息不会有任何反应——**而且因为微信要求你先发过消息、插件才能主动推送，它连一句提醒都发不出来**。这是首次安装最容易卡住的一步。
   >
   > 这一行的其余字段（`sessionMode`、`workspacePath` 等）装 bundle 时会自动插入，通常不用手写。

4. **重启 DSH**（插件在启动时加载，没有热更新）。

5. **在微信里给这个机器人发一句话**，预期看到：
   - 你的消息立刻出现「对方正在输入…」；
   - 几秒到几十秒后收到**一条完整的文字回答**；
   - DSH 左侧会话列表里多出一条新会话（装了 [`dsh-im-indicator`](https://github.com/Poy-Coder/dsh-im-indicator) 的话，那一行还有「微信」胶囊和状态点）。

   完全没有反应时，先确认第 3 步的 `inboundEnabled` 真的是 `true`，再看 `~/.dsh/wechat-inbound.log` 有没有新行——**入站关着的时候，连日志都不会写**。
   如果日志里有 `inbound/delivered` 但聊天窗口没收到回答，发 `/status` 看会话、权限与模型状态。

### 开启入站前先看这三个默认值

| 配置 | 默认 | 含义 |
|---|---|---|
| `inboundEnabled` | `false` | 打开后，能给它发消息的人就能驱动本地 Agent |
| `allowedUsers` | `[]` | 空不是"谁都可以"：扫码登录的那个微信号会**自动绑定**为 owner，其他人被拒；要加人再显式列出 |
| `permissionPreset` / `applyPermissionPreset` | `workspace-write` / `true` | 通道工作区里的会话只允许写工作区内；越界写会请求批准，而 IM 里没人能点，所以那一轮会停住而不是悄悄提权。确实需要「越界也自动写」时显式改 `danger-full-access` |

## 怎么用

开启入站并重启后，直接在微信里给这个机器人发消息就行，不需要任何前缀。它把消息原样交给 DSH 会话，回答回到微信。

**日常用法**

| 你发 | 会发生什么 |
|---|---|
| 任意一句话 | 当前会话继续对话；回答**一条完整消息**发回（超过 1800 字才拆续条） |
| 图片 / 文件 | 存到工作区，模型能看到（图片按视觉输入，文件给路径） |
| 让它发文件 | 用 `wechat_send_file` 工具回传，图片走图片消息，其他走文件消息 |

**斜杠命令**（发 `/` 会回命令列表）

| 命令 | 作用 |
|---|---|
| `/help` | 命令列表 |
| `/status` | 当前会话、工作区、权限、入站状态 |
| `/new [内容]` | 开一段新会话（带内容则作为第一条消息） |
| `/rename <标题>` | 给当前会话改名 |
| `/stop` | 中断进行中的回合 |
| `/model` | 看当前模型；`/model provider/model` 切换 |
| `/think` | 看思考强度；`/think low`、`/think medium`、`/think high`，或 `/think default` 恢复默认 |

**会话怎么落**：一个微信私聊对应一个 DSH 会话，落在独立工作区（默认 `<非系统盘>/dsh/wechat`），在 DSH 左侧列表里和桌面会话并排显示。`/new` 之后换一段新的，旧的不删。

**进度感**：收到消息立刻显示「对方正在输入…」，每 5 秒续期，长任务期间不会消失；超过 `textProgressSeconds`（默认 30 秒）还没有正文才补一条文字进度（`还在跑 · 正在执行 xxx · 已用时 35s`）。嫌吵把 `textProgressSeconds` 设成 `0`，就只剩「正在输入」。

**它不会做的**：不改你的消息、不撤回、不发卡片；群聊不支持（只处理一对一的私聊）。

### 需要批准时会在聊天里问你

权限预设 `workspace-write` 会拦住"写工作区以外"的操作。微信里没有批准按钮，所以插件把审批转到聊天里：

```
微信通道需要你批准一次工具调用
工具：pwsh
原因：写入工作区以外的路径

回复 1 允许这一次，回复 2 拒绝。
超过 5 分钟没回复，按拒绝处理。
```

- 回 `1` / `允许` / `同意` → 只放行这一次；
- 回 `2` / `拒绝` / `取消` → 拒绝；
- 回别的内容不当审批答案，照常交给模型（可以先解释为什么需要它）；
- 超时按拒绝处理——沉默不等于同意。

不想被问就把 `permissionPreset` 设成 `danger-full-access`（不再拦截，也不再问）。

### 长回答发不出去时会告诉你

超过 1800 字的回答会拆续条，**每一段独立重试**（0.8s / 2s / 5s）。如果某段最终还是失败，你会收到一句明确说明，而不是"看到前半段、后半段永远不来"。

## 与飞书的差异

- 没有卡片、不能编辑消息：**一轮回答一条完整消息**（超过 1800 字才拆续条），进度用「正在输入」+ 阶段性文本；
- **没有历史消息接口**：断线后无法像飞书那样按时间补拉。用三层兜底——长轮询 2 分钟没完成就重建、游标 20 分钟没新消息就重置、每 2 分钟用**记下来的旧游标**冷读一次补投漏掉的消息（旧游标会重放它已越过的消息，实测有效）；
- 只能在用户最近一次发消息后的 24 小时内主动推送；
- 问答是纯文本编号：回数字选择，直接回文字就是补充。

### 连接断开时不会吵你

长轮询断开后要**持续 90 秒**才发通知——正常重连只要几秒，那种抖动你察觉不到，所以完全静默。只有通知过「断开」才会补发「已恢复」；10 分钟内断开 3 次以上只发一条「连接不稳定」。连接类通知最多 10 分钟一条。

## 遇到问题

发现 bug、行为不符合预期，或者想加功能，直接开 issue：<https://github.com/Poy-Coder/dsh-channel-wechat-ilink/issues>

开之前先看一眼 `~/.dsh/wechat-inbound.log`，把相关几行贴进去（每行一条 JSON，带 `event` / `result` / `reason` 就够定位）。`botToken`、`context_token` 这类凭据不要贴。

## 自测

`node scripts/wechat-e2e.mjs`：从微信发一条消息，脚本按两段回复并打印耗时；`--dry-run` 只检查凭据与状态。
