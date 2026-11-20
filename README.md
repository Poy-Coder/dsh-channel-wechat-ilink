# dsh-channel-wechat-ilink

微信通道（ClawBot / iLink 协议）——与 `dsh-channel-feishu` 同一套框架，独立包、独立工作区，可同时在线。

> 注意包名：npm 上的 `dsh-channel-wechat` 是**另一个作者**的插件（卡片转发路线）。这个包叫 `dsh-channel-wechat-ilink`，走纯文本路线。

**配套（建议一并安装）**：

- [`dsh-im-indicator`](https://github.com/Poy-Coder/dsh-im-indicator) —— **推荐装**：在 DSH 左侧会话列表直接看出「哪条会话正被微信驱动、它现在在回答还是已完成」，一行胶囊 + 一个状态点，零依赖约 7 kB；
- [`dsh-channel-feishu`](https://github.com/Poy-Coder/dsh-channel-feishu) —— 同一套框架的飞书通道，可与微信同时在线。

## 安装

1. 扫码登录并写出凭据：`node scripts/wechat-login.mjs --qr`（二维码直接画在终端，并落一张 PNG；也可发到飞书扫码）。
2. 在 profile 的 `cordis.patch.yml` 里加一行（安装 bundle 时会自动插入）：

```yaml
- id: wechat-channel
  name: "dsh-channel-wechat-ilink"
  config:
    provider: wechat
    inboundEnabled: false   # 默认关；开启前先确认下面三个安全项
    sessionMode: create
    workspacePath: ""   # 空 = <非系统盘>/dsh/wechat
```

### 开启入站前先看这三个默认值

| 配置 | 默认 | 含义 |
|---|---|---|
| `inboundEnabled` | `false` | 打开后，能给它发消息的人就能驱动本地 Agent |
| `allowedUsers` | `[]` | 空不是"谁都可以"：扫码登录的那个微信号会**自动绑定**为 owner，其他人被拒；要加人再显式列出 |
| `permissionPreset` / `applyPermissionPreset` | `workspace-write` / `true` | 通道工作区里的会话只允许写工作区内；越界写会请求批准，而 IM 里没人能点，所以那一轮会停住而不是悄悄提权。确实需要「越界也自动写」时显式改 `danger-full-access` |

3. **重启 DSH**（插件在启动时加载，没有热更新）。

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
