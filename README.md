# TG-jev-chatbot

Two-way Telegram **support relay** using **forum topics** in a supergroup, plus **Jev suggested replies** so merchants can answer customers faster.

用户私聊 Bot → 自动在论坛超级群里开一个专属话题；**Jev 先查固定话术，再查店铺知识库**，把建议回复发到**客服话题**供人工确认；工作人员点「发送给客户」或自己打字回复 → Bot 把内容送回用户私聊。

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
- ✅ Bilingual `/start` (中文 + English)
- ✅ `/whoami` in private (debug user id); `/groupid` inside the group (debug chat id)
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
2. Start the bot with a temporary/placeholder `FORUM_GROUP_ID` **or** put the real id once you have it.
3. In the group, send: `/groupid`
4. The bot replies with `This chat id: -100…` — copy that into `.env` as `FORUM_GROUP_ID`.

**Alternatives:**

- Forward a group message to [@userinfobot](https://t.me/userinfobot) / [@getidsbot](https://t.me/getidsbot) and read the chat id.
- Call `getUpdates` after posting in the group:  
  `https://api.telegram.org/bot<BOT_TOKEN>/getUpdates` and look for `"chat":{"id":-100…}`.

## Quick start

### 1. Create the bot (BotFather)

1. Open [@BotFather](https://t.me/BotFather) → `/newbot`
2. Copy the **HTTP API token** → `BOT_TOKEN`

### 2. Create a forum-enabled supergroup

1. Create a **Supergroup** (not a basic group).
2. Group settings → **Topics** → enable.
3. Add your bot as **administrator** with **Manage topics** + **Post messages**.
4. Obtain `FORUM_GROUP_ID` (see above).

### 3. Configure env

```bash
git clone https://github.com/zanedonkey/TG-jev-chatbot.git
cd TG-jev-chatbot
cp .env.example .env
```

```env
BOT_TOKEN=123456:ABC-DEF...
FORUM_GROUP_ID=-1001234567890
# Optional:
# TOPIC_NAME_TEMPLATE={name} · {id}
# DB_PATH=./data/mappings.sqlite
# JEV_ENABLED=1
# JEV_SCRIPTS_PATH=./data/scripts.json
# JEV_KNOWLEDGE_PATH=./data/knowledge.md
```

### 4. Install & run

```bash
npm install
npm run dev          # development (tsx)
# production:
npm run build && npm start
```

You should see: `Bot @your_bot … running. Forum group: -100…` and `Jev suggested replies: ON`.

### 5. Staff workflow

1. User messages the bot in private → a new topic appears in the group.
2. If the text matches scripts/knowledge, a **💡 Jev 建议回复** appears with **发送给客户**.
3. Staff click the button **or** reply normally in the topic.
4. Bot delivers to the user’s private chat with the bot.

## Environment variables

| Variable               | Required | Description |
|------------------------|----------|-------------|
| `BOT_TOKEN`            | Yes      | BotFather token |
| `FORUM_GROUP_ID`       | Yes      | Forum supergroup id (e.g. `-100…`) |
| `TOPIC_NAME_TEMPLATE`  | No       | Default `{name} · {id}`. Also `{username}` |
| `DB_PATH`              | No       | SQLite file path (default `./data/mappings.sqlite`) |
| `JEV_ENABLED`          | No       | Default on. Set `0` / `false` to disable suggestions |
| `JEV_SCRIPTS_PATH`     | No       | Default `./data/scripts.json` |
| `JEV_KNOWLEDGE_PATH`   | No       | Default `./data/knowledge.md` |

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
- **Commands** in private (except `/start`, `/whoami`) are not relayed as content.

## Suggested GitHub topics

`telegram` · `bot` · `typescript` · `relay` · `jev` · `forum` · `grammy` · `sqlite`

## License

[MIT](./LICENSE) © zanedonkey
