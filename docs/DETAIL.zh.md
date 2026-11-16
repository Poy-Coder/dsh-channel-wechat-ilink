![飞书会话与 DSH 会话之间双向收发消息和附件](preview.svg)

# dsh-channel-feishu

在飞书里和 DSH 里的 Agent 对话：流式卡片答复、交互式问答卡、图片与文件自动落盘到工作区。

**不会静默**：卡片实时显示当前在跑哪个工具、已调用几个工具、已用时多少秒（工具切换立即更新，长任务期间每 10 秒刷新），思考过程另有单独一条消息——长任务也不会看起来像卡死。

- 安装：`dsh plugin add dsh-channel-feishu`
- 凭据：`~/.dsh/feishu-channel.json`（或 `FEISHU_APP_ID` / `FEISHU_APP_SECRET`）
- 一条命令写入凭据并校验：`node scripts/setup.mjs`
- 完整说明见仓库 README
