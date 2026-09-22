# 从零开始安装（新手清单）

面向**没有开发经验**的管理员：按顺序点 Telegram、填 `.env`，就能跑起来。

英文仓库说明见 [README.md](../README.md)。技术细节（架构 / Jev / 权限表）仍在 README。

---

## 你需要准备什么

- 一台能装 **Node.js 20+** 的电脑（或已有服务器）
- 一个 Telegram 账号
- 约 10 分钟

---

## 步骤清单（按顺序做）

### 1. 用 BotFather 创建机器人，复制 Token

1. 打开 Telegram，搜索并进入 [@BotFather](https://t.me/BotFather)
2. 发送 `/newbot`
3. 按提示起一个显示名、以及一个以 `bot` 结尾的用户名（例如 `MyShopSupportBot`）
4. BotFather 会发来一长串 **HTTP API Token**（形如 `123456789:AAH...`）
5. **复制**整段 Token，一会儿填进 `.env` 的 `BOT_TOKEN=`

> ⚠️ **安全**：Token = 机器人的密码。不要发到群聊、不要截图发朋友圈、不要提交到 GitHub。泄露了立刻去 BotFather `/revoke` 换新。

---

### 2. 新建超级群并开启 Topics（论坛话题）

1. Telegram → 新建群组 → 选 **超级群 / Supergroup**（不要用普通群）
2. 群设置 → **话题 / Topics** → **打开**
3. 把刚创建的 Bot **拉进群**，并设为 **管理员**
4. 管理员权限至少勾选：
   - **管理话题**（Manage topics）— 用来自动开客户专属话题
   - **发消息**（Post messages）— 用来把用户消息抄进话题
5. （可选）再勾选「删除消息」，方便客服清理

> 常见翻车：开的是普通群、Topics 没开、Bot 只是普通成员不是管理员。

---

### 3. 先只填 Token，群 ID 可留空；安装并启动

在项目目录：

```bash
git clone https://github.com/zanedonkey/TG-jev-chatbot.git
cd TG-jev-chatbot
cp .env.example .env
```

用记事本 / VS Code 打开 `.env`：

```env
BOT_TOKEN=这里粘贴BotFather给你的Token
FORUM_GROUP_ID=
```

`FORUM_GROUP_ID` **现在可以留空**。留空时 Bot 进入 **SETUP_MODE（配置模式）**：不能转发客服消息，但可以用 `/groupid`、`/setup` 引导你填完。

然后：

```bash
npm install
npm run dev
```

终端里应出现类似：`running in SETUP MODE`（群 ID 还空时）或 `Forum group: -100…`（已填时）。

---

### 4. 在群里发 `/groupid`，把数字写进 `.env`，再重启

1. 打开你的**论坛超级群**（不是私聊）
2. 发一条：`/groupid`
3. Bot 会回复一串**负数**，一般以 `-100` 开头，例如 `-1001234567890`
4. 打开 `.env`，写成一行（数字前后不要空格、不要加引号）：

   ```env
   FORUM_GROUP_ID=-1001234567890
   ```

5. **保存文件**，回到终端：**停掉 Bot**（Ctrl+C），再执行 `npm run dev`（或生产环境 `npm run build && npm start`）

> 改 `.env` 后**必须重启**，否则旧配置还在内存里。

也可以私聊 Bot 发 `/setup`，随时看还差哪一步。

---

### 5. 私聊测一条；再改话术 / 知识库

1. 私聊你的 Bot，发 `/start`，再发一句「你好」或「营业时间」
2. 回到超级群：应出现一个**新话题**，里面有用户消息；若命中话术/知识库，还会有 💡 Jev 建议和「发送给客户」按钮
3. 在话题里回复几句 → 用户私聊应收到
4. 按需编辑：
   - [`data/scripts.json`](../data/scripts.json) — 固定话术（关键词 → 答案）
   - [`data/knowledge.md`](../data/knowledge.md) — 店铺知识（`## 标题` 分段）
5. 改完内容后**重启 Bot**（或之后用代码里的热重载），再测

---

## 常见问题（FAQ）

| 现象 | 可能原因 | 怎么办 |
|------|----------|--------|
| `/groupid` 没反应 | 群类型不对 / Bot 不在群里 / Bot 未启动 | 确认是**超级群**且 Topics 已开；Bot 在群内并已 `npm run dev` |
| 能收用户消息，客服回复用户收不到 | Bot **不是管理员**，或隐私模式导致看不到群消息 | 把 Bot 设为管理员（至少发消息）；管理员 Bot 才能看到话题内客服回复 |
| 创建话题失败 / 报错 | Topics 未开，或缺「管理话题」权限 | 群设置打开 Topics；给 Bot「管理话题」 |
| `FORUM_GROUP_ID` 写成正数或用户 id | 拷错了 | 超级群 id 几乎都是 **负数**，形如 `-100…`；不要填自己的 user id |
| 改了 `.env` 没变化 | 没重启进程 | Ctrl+C 停掉再 `npm run dev` |
| Token 不小心公开了 | 泄露 | 立刻 [@BotFather](https://t.me/BotFather) → `/revoke` 作废并换新 Token |
| 用户说 Bot 不理人 | 还在 SETUP_MODE，或只填了 Token | 私聊发 `/setup` 看清单；补全 `FORUM_GROUP_ID` 并重启 |
| 普通群成员发的消息 Bot 看不到 | Telegram **隐私模式**（非管理员时默认开） | 本项目需要 Bot 做**群管理员**；不要只靠关隐私模式凑合 |

---

## 配置完成后日常怎么用

- **用户**：私聊 Bot 发文字/图片/文件即可
- **客服**：在对应话题里打字回复，或点 Jev 的「发送给客户」
- **管理员**：私聊 `/setup` 看配置状态；`/help` 看命令；`/whoami` 看自己的 user id

更完整的架构、环境变量表、Jev 匹配规则 → [README.md](../README.md)。
