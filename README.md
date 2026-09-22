# tg-relay-bot

Two-way Telegram relay bot — users message the bot, you reply through it.

一个轻量的 **双向 Telegram 中继机器人**：用户私聊 bot → 消息转发到管理员；管理员在 bot 会话里 **回复** 那条消息 → bot 把回复送回原用户。适合个人客服、匿名留言、小团队值班等场景。

## Why two-way relay?

Telegram 不支持把「别人私聊 bot 的消息」直接变成你的会话线程。常见做法是让 bot 当中间人：

1. **用户 → 管理员**：bot 把用户消息复制到 `ADMIN_CHAT_ID`，并标注来源。
2. **管理员 → 用户**：你在 bot 聊天里 **Reply** 那条中继消息，bot 再把内容送回原用户。

这样你不需要把个人号暴露给陌生人，也能一对一回复。

## Features

- ✅ 用户 `/start`：中英双语简短说明
- ✅ 文字消息中继；图片 / 文件等通过 `copyMessage` 复制
- ✅ 管理员 Reply 中继消息即可回覆用户
- ✅ 管理员 `/whoami`：打印自己的 chat id，方便配置
- ✅ TypeScript + [grammY](https://grammy.dev/) + Node 20+
- ⚠️ 消息映射存在 **内存 Map** 中：进程重启后旧消息无法再 Reply 关联（v0 可接受；生产可换 Redis）

## Requirements

- Node.js **20+**
- 一个 Telegram Bot Token（[@BotFather](https://t.me/BotFather)）
- 你的 Telegram **chat id**（用作 `ADMIN_CHAT_ID`）

## Quick start

### 1. 创建 Bot（BotFather）

1. 打开 [@BotFather](https://t.me/BotFather)
2. `/newbot`，按提示设置名称与 username
3. 复制拿到的 **HTTP API token** → 填入 `.env` 的 `BOT_TOKEN`

### 2. 获取 ADMIN_CHAT_ID

最简单：

1. 先临时把 `ADMIN_CHAT_ID` 设成你自己的数字 id（若还不知道，可先用 [@userinfobot](https://t.me/userinfobot) 看自己的 id）
2. 或：把任意占位数字写上、启动 bot，用 **你的账号** 私聊 bot 发 `/whoami`（需已是 admin；首次可用 userinfobot）
3. 推荐流程：
   - 私聊 [@userinfobot](https://t.me/userinfobot) 拿到 `Id`
   - 或启动后用自己的号对 bot 发任意消息，看控制台 / 中继头里的 `chat_id=`
4. 配置好后，管理员在 bot 私聊里发 `/whoami` 可再次确认

### 3. 配置环境变量

```bash
git clone https://github.com/zanedonkey/tg-relay-bot.git
cd tg-relay-bot
cp .env.example .env
```

编辑 `.env`：

```env
BOT_TOKEN=123456:ABC-DEF...
ADMIN_CHAT_ID=123456789
```

### 4. 安装并运行

```bash
npm install
npm run dev          # 开发：tsx 直接跑 TypeScript
# 或生产：
npm run build && npm start
```

看到 `Bot @your_bot is running` 即表示长轮询已启动。

## 回复是怎么串起来的？（Reply threading）

```
用户 ──私聊──► Bot ──复制+标注──► 管理员（ADMIN_CHAT_ID）
                                      │
                              管理员 Reply 该消息
                                      │
用户 ◄──复制消息── Bot ◄─────────────┘
```

- Bot 在内存里维护：`管理员侧 message_id → 用户 chat_id`
- 管理员必须 **回复（Reply）** 那条中继消息，bot 才能知道送给谁
- **重启 bot 会清空 Map**：旧消息再 Reply 会提示找不到映射；让用户重新发一条即可

## Environment variables

| Variable         | Required | Description                                      |
|------------------|----------|--------------------------------------------------|
| `BOT_TOKEN`      | Yes      | BotFather 发放的 token                           |
| `ADMIN_CHAT_ID`  | Yes      | 接收中继消息的管理员私聊 chat id（数字）         |

## Scripts

| Script        | Description                |
|---------------|----------------------------|
| `npm run dev` | `tsx src/index.ts` 开发热跑 |
| `npm run build` | `tsc` 编译到 `dist/`     |
| `npm start`   | `node dist/index.js` 生产  |

## Suggested GitHub topics

`telegram` · `bot` · `typescript` · `relay` · `grammy`

## License

[MIT](./LICENSE) © zanedonkey
