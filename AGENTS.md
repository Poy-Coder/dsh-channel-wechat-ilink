# AGENTS.md — installing the WeChat channel

This bundle carries the same channel framework as `dsh-channel-feishu`, but the
transport is WeChat (iLink / ClawBot). The steps that differ:

## 1. Install

```bash
dsh plugin add dsh-channel-wechat-ilink
```

The row is inserted by the bundle patch and defaults to `provider: wechat`.
Inbound defaults to off; enabling it lets allowed senders drive the local agent,
so ask first. With an empty `allowedUsers`, the account that scanned the QR is
bound as the owner automatically, and every other sender is refused.

## 2. Log in

**Your job is to finish this for the user, not to hand them a command to run.**

1. `node scripts/wechat-login.mjs --begin` — prints JSON with `url`, `qrImage`,
   `expiresInMinutes` (about 5). It does **not** wait.
2. **Show the code yourself**, by what exists:
   - **Web GUI, first install: the user has no channel yet — that is why they are
     installing this one, so `wechat_send_file` does not exist.** Use `present` with the
     `qrImage` path and give `url` as text too. `present` shows after the turn ends; the
     user scans, then says so in the next turn.
   - **An already working IM session**: send `qrImage` with the file tool.
   - A terminal QR is invisible to someone talking to you in a chat.
3. `node scripts/wechat-login.mjs --poll` — exit 0 = logged in and saved, exit 2 =
   **still waiting, not an error**, exit 1 = failed or expired.
4. Then continue: enable `inboundEnabled` in the profile row, restart, send a test
   message, run §3.

The token lands in `~/.dsh/wechat-channel.json` (0600). Never paste it into chat, a
commit, or the patch file. `node scripts/wechat-login.mjs --qr` is the old
print-and-wait form for a human at a terminal; agents should not use it.

## 3. Verify

1. `wechat_channel_status` → `configured: true`, `tokenOk: true`,
   `poll.lastOkAt` moving.
2. Send one WeChat message; the answer arrives in parts and a workspace row
   appears in the GUI.
3. `node scripts/wechat-e2e.mjs` replies "第 1/2 段" / "第 2/2 段".

## 4. Restart DSH

Plugin code loads at startup; a `dsh plugin add` without a restart keeps the old
build running — the classic "I updated it and nothing changed".

## Stability notes (do not mis-diagnose)

- **No history API.** iLink exposes only `getupdates` long polling. There is no
  way to pull "what was said while we were down"; two timers cover it instead:
  a poll that does not complete within ~2 minutes is aborted and rebuilt
  (`channel rebuild`), and a cursor idle for 20 minutes is reset once
  (`channel cursor-reset`, messages older than 30 minutes are skipped).
- **One bot per account.** A second process polling the same bot token competes
  for `getupdates`; use one DSH per WeChat bot.
- **`errcode -14` means back off.** The plugin pauses all requests for an hour
  rather than hammering the API; re-login with the QR script if it persists.

## Releasing

This bundle ships alongside `dsh-channel-feishu` from the same source tree, so it
inherits the same release rules (see that package's AGENTS.md §10): never publish a
tarball whose contents were not checked (`pack-check.ps1` runs before `npm publish`),
and start every release note with `安全：` / `修复：` / `功能：` / `文档：` so the
upgrade notice in `/status` says whether the update matters.
