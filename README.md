# dsh-channel-wechat-ilink

微信通道（ClawBot / iLink 协议）——与 `dsh-channel-feishu` 同一套框架，独立包、独立工作区，可同时在线。

> 注意包名：npm 上的 `dsh-channel-wechat` 是**另一个作者**的插件（卡片转发路线）。这个包叫 `dsh-channel-wechat-ilink`，走纯文本路线。

## 安装

1. 扫码登录并写出凭据：`node scripts/wechat-login.mjs --qr`（二维码直接画在终端，并落一张 PNG；也可发到飞书扫码）。
2. 在 profile 的 `cordis.patch.yml` 里加一行（安装 bundle 时会自动插入）：

```yaml
- id: wechat-channel
  name: "dsh-channel-wechat-ilink"
  config:
    provider: wechat
    inboundEnabled: true
    sessionMode: create
    workspacePath: ""   # 空 = <非系统盘>/dsh/wechat
```

3. **重启 DSH**（插件在启动时加载，没有热更新）。

## 与飞书的差异

- 没有卡片、不能编辑消息：回答按段落分条发送，进度用「正在输入」+ 阶段性文本；
- **没有历史消息接口**：断线后无法像飞书那样按时间补拉。用两个定时器兜底——长轮询 2 分钟没完成就重建，游标 20 分钟没新消息就重置重新拉取；
- 只能在用户最近一次发消息后的 24 小时内主动推送；
- 问答是纯文本编号：回数字选择，直接回文字就是补充。

## 自测

`node scripts/wechat-e2e.mjs`：从微信发一条消息，脚本按两段回复并打印耗时；`--dry-run` 只检查凭据与状态。
