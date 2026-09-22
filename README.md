# TG-jev-chatbot

Two-way Telegram **support relay** using **forum topics** in a supergroup, plus **Jev suggested replies** so merchants can answer customers faster.

用户私聊 Bot → 自动在论坛超级群里开一个专属话题；**Jev 先查固定话术，再查店铺知识库**，把建议回复发到**客服话题**供人工确认；工作人员点「发送给客户」或自己打字回复 → Bot 把内容送回用户私聊。

---

## 🚀 从零开始安装（推荐先看）

**不会写代码也能装。** 完整中文点击清单（BotFather → 超级群 Topics → `.env` → `/groupid` → 重启 → 测消息）：

👉 **[docs/SETUP.zh.md](./docs/SETUP.zh.md)**

摘要（5 步）：

1. [@BotFather](https://t.me/BotFather) 创建机器人，复制 Token → `.env` 的 `BOT_TOKEN`
2. 新建**超级群**，开启 **Topics**，把 Bot 加成管理员（**管理话题** + **发消息**）
3. 先只填 `BOT_TOKEN`，`FORUM_GROUP_ID` **可留空**；`npm i` + `npm run dev`
4. 在群里发 `/groupid`，把回覆的数字写入 `FORUM_GROUP_ID=`，**重启** Bot
5. 私聊 Bot 测一条；再按需改 `data/scripts.json` / `data/knowledge.md`

配置中也可私聊 Bot 发 **`/setup`** 查看还差哪一步；**`/help`** 看命令。

### 常见问题（速查）

| 问题 | 处理 |
|------|------|
| 群类型不对 / Topics 没开 | 必须用**超级群**并打开 Topics |
| Bot 不是管理员 | 至少勾选「管理话题」「发消息」 |
| 客服回复用户收不到 | Bot 需为群管理员才能看到话题内消息（隐私模式） |
| id 写成正数或自己的 user id | 超级群 id 几乎都是 **负数** `-100…` |
| 改了 `.env` 没变化 | **必须重启**进程 |
| Token 泄露 | BotFather `/revoke` 换新；勿提交 `.env` |

环境变量注释说明见 [`.env.example`](./.env.example)。

---

## Architecture

```
┌─────────────┐  private DM   ┌─────────┐  createForumTopic / copyMessage
│  End user   │ ────────────► │   Bot   │ ──────────────────────────────────┐
└─────────────┘               └────┬────┘                                   │
       ▲                           │                                        ▼
       │                           │ staff reply / Jev「发送给客户」  ┌───────────────────┐
       │   copyMessage / send      │ in topic                       │ Forum Supergroup  │
       └───────────────────────────┘                                │  ├─ Topic: Alice  │
                                                                    │  │   + 💡 Jev 建议 │
                                                                    │  ├─ Topic: Bob    │
                                                                    │  └─ General (ignore)
                                                                    └───────────────────┘

Persist: SQLite  user_id ↔ message_thread_id  (+ jev_suggestions for button callbacks)
```

1. User DMs the bot (`/start` then any content, or just a first message).
2. Bot creates a **forum topic** named like `Alice · 123456789` and stores the mapping.
3. Every later user DM is **copied** into that topic (`message_thread_id`).
4. For **text** DMs, **Jev** may post a staff-only suggestion in the same topic (never auto-sent to the user).
5. When staff posts **inside that topic**, or clicks **发送给客户**, the bot delivers to the user’s private chat.
6. Messages in the **General** topic (`message_thread_id = 1`) are ignored.

## Jev suggested replies

Goal: help merchants answer **fast** with reusable copy — **not** urgency/spam triage.

### Matching order

1. **`data/scripts.json`** — fixed FAQ / script table. Score by case-insensitive keyword (and optional `question`) hits in the user text. Best script with score ≥ 1 wins.
2. Else **`data/knowledge.md`** — Markdown sections (`## 标题` + body). Score by overlapping meaningful terms (CJK runs or Latin words, length ≥ 2). Best section with overlap ≥ 1 wins.
3. Else **no post** (skip noisy “未匹配” spam).

Scripts always beat knowledge when both could match.

### Staff UX

- Suggestion appears **only in the user’s forum topic**, e.g.:

  ```
  💡 Jev 建议回复（来源：固定话术 / 店铺知识库）
  …answer…
  [发送给客户]
  ```

- Clicking **发送给客户** sends that answer to the user’s DM once and clears the button.
- Staff can still type any free-text (or media) reply in the topic; that relays as before.
- Bot-posted suggestions are **not** relayed back to the user (loop-safe via `botId` / `is_bot`).

### Edit merchant content

| File | Format |
|------|--------|
| [`data/scripts.json`](./data/scripts.json) | Array of `{ id, keywords: string[], question?, answer }` |
| [`data/knowledge.md`](./data/knowledge.md) | Sections starting with `## 标题` |

Restart the bot (or call `reloadJevData()` in code) after editing files so changes load.

Sample Chinese copy covers 营业时间、运费/配送、退换货、付款方式、怎么下单, plus 店铺简介 / 热门商品 / 售后政策摘要.

Disable with `JEV_ENABLED=0`.

## Features

- ✅ Forum-topic per user (multi-staff can share one group)
- ✅ SQLite persistence (`better-sqlite3`) — mappings survive restarts
- ✅ `copyMessage` preserves text / photos / documents / stickers / etc.
- ✅ **Jev assist live**: scripts → knowledge → topic suggestion → staff send
- ✅ Chinese-first onboarding: [`docs/SETUP.zh.md`](./docs/SETUP.zh.md), `/setup`, `/help`
- ✅ **SETUP_MODE**: leave `FORUM_GROUP_ID` empty to run guided setup (`/groupid` still works)
- ✅ Bilingual `/start` (中文 + English); admin tip for `/setup`
- ✅ `/whoami` in private; `/groupid` inside the group (copy-paste `.env` line)
- ✅ Loop-safe: bot’s own messages are never relayed
- ✅ Auto-recreate topic if Telegram reports the thread was deleted

## Requirements

- Node.js **20+**
- Telegram Bot token from [@BotFather](https://t.me/BotFather)
- A **supergroup with Topics enabled**
- Bot must be **administrator** in that group (see permissions below)

## Bot permissions (important)

In the forum supergroup, add the bot as an **administrator** with at least:

| Permission            | Why                                      |
|-----------------------|------------------------------------------|
| **Manage topics**     | `createForumTopic`                       |
| **Post messages**     | Copy user messages into topics           |
| **Delete messages**   | Optional; useful for moderation          |

Privacy note: bots that are **group admins** receive all group messages (including staff replies inside topics). That is required for staff → user relay. If the bot is only a member (not admin) and privacy mode is on, it will **not** see staff replies.

## How to get `FORUM_GROUP_ID`

Supergroup ids are **negative** and usually look like `-100xxxxxxxxxx`.

**Reliable method (recommended):**

1. Add the bot to the group as admin.
2. Start with `FORUM_GROUP_ID` **empty** (SETUP_MODE) or already filled.
3. In the group, send: `/groupid`
4. Bot replies with a ready-to-paste line `FORUM_GROUP_ID=-100…` — put it in `.env` and **restart**.

**Alternatives:**

- Forward a group message to [@userinfobot](https://t.me/userinfobot) / [@getidsbot](https://t.me/getidsbot) and read the chat id.
- Call `getUpdates` after posting in the group:  
  `https://api.telegram.org/bot<BOT_TOKEN>/getUpdates` and look for `"chat":{"id":-100…}`.

## Quick start (English)

Same flow as the Chinese guide; full click-path: [docs/SETUP.zh.md](./docs/SETUP.zh.md).

```bash
git clone https://github.com/zanedonkey/TG-jev-chatbot.git
cd TG-jev-chatbot
cp .env.example .env
# Edit .env: set BOT_TOKEN; FORUM_GROUP_ID may stay empty at first
npm install
npm run dev
# In the forum group: /groupid → paste into .env → restart
# Production: npm run build && npm start
```

You should see: `Bot @your_bot … running. Forum group: -100…` (or `SETUP MODE` if group id empty) and `Jev suggested replies: ON`.

### Staff workflow

1. User messages the bot in private → a new topic appears in the group.
2. If the text matches scripts/knowledge, a **💡 Jev 建议回复** appears with **发送给客户**.
3. Staff click the button **or** reply normally in the topic.
4. Bot delivers to the user’s private chat with the bot.

## Environment variables

| Variable               | Required | Description |
|------------------------|----------|-------------|
| `BOT_TOKEN`            | Yes      | BotFather token |
| `FORUM_GROUP_ID`       | Yes\*    | Forum supergroup id (e.g. `-100…`). \*Can start empty for SETUP_MODE |
| `TOPIC_NAME_TEMPLATE`  | No       | Default `{name} · {id}`. Also `{username}` |
| `DB_PATH`              | No       | SQLite file path (default `./data/mappings.sqlite`) |
| `JEV_ENABLED`          | No       | Default on. Set `0` / `false` to disable suggestions |
| `JEV_SCRIPTS_PATH`     | No       | Default `./data/scripts.json` |
| `JEV_KNOWLEDGE_PATH`   | No       | Default `./data/knowledge.md` |

## Bot commands

| Command | Where | Who |
|---------|-------|-----|
| `/start` | Private | End users (greeting); in SETUP_MODE shows admin setup guide |
| `/setup` | Private | Operators — remaining config checklist |
| `/help` | Private / group | Command list |
| `/groupid` | Forum group | Operators — print `FORUM_GROUP_ID=…` line |
| `/whoami` | Private | Debug user / chat ids |

## Scripts

| Script          | Description                |
|-----------------|----------------------------|
| `npm run dev`   | `tsx src/index.ts`         |
| `npm run build` | `tsc` → `dist/`            |
| `npm start`     | `node dist/index.js`       |

## Persistence

Mappings live in SQLite via [`better-sqlite3`](https://github.com/WiseLibs/better-sqlite3):

```text
data/mappings.sqlite
  mappings(user_id PK, thread_id UNIQUE, display_name, created_at)
  jev_suggestions(id PK, user_id, thread_id, answer, created_at)
```

Committed sample content: `data/scripts.json`, `data/knowledge.md`. Runtime DB files under `data/` stay gitignored. If you wipe the DB, old topics become “unknown” (staff replies there won’t relay); the next user DM will create a **new** topic.

> **Note:** `better-sqlite3` needs a native build toolchain (`build-essential` / Xcode CLT). On this project it is pinned to a Node 20–compatible release. If install fails on your machine, install compiler tools first, or open an issue.

## Limitations

- **Media:** anything Telegram `copyMessage` supports (text, photo, video, document, audio, voice, sticker, animation, …). Polls / some service message types are not relayed.
- **Jev v1:** suggestions only for **user text** DMs (not photos etc.); no auto-send without the button.
- **General topic** is ignored on purpose (avoid noise / accidental loops).
- **Deleted topics:** bot tries to recreate on the next user message.
- **Blocked users:** staff → user delivery fails if the user blocked the bot; an error note is posted in the topic.
- **Single forum group:** one `FORUM_GROUP_ID` per process.
- **Commands** in private (except handled ones like `/start`, `/setup`, `/help`, `/whoami`) are not relayed as content.

## Suggested GitHub topics

`telegram` · `bot` · `typescript` · `relay` · `jev` · `forum` · `grammy` · `sqlite`

## License

[MIT](./LICENSE) © zanedonkey
