/**
 * TG-jev-chatbot — Telegram two-way relay via forum topics
 *
 * Flow:
 * 1. User DMs the bot privately.
 * 2. On first content message, bot creates a forum topic in FORUM_GROUP_ID
 *    and stores userId ↔ threadId in SQLite.
 * 3. Subsequent user DMs are copied into that topic (message_thread_id).
 * 4. After a user text DM is relayed, Jev may post a staff-only suggested reply
 *    (scripts → knowledge) with a "发送给客户" button — never auto-sent.
 * 5. Staff replies inside the topic → bot copies the reply back to the user DM.
 */

import "dotenv/config";
import { Bot, Context, InlineKeyboard } from "grammy";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MappingStore } from "./store.js";
import { suggest } from "./jev.js";

const BOT_TOKEN = process.env.BOT_TOKEN;
const FORUM_GROUP_ID_RAW = process.env.FORUM_GROUP_ID?.trim() || "";
const TOPIC_NAME_TEMPLATE =
  process.env.TOPIC_NAME_TEMPLATE ?? "{name} · {id}";
const DB_PATH =
  process.env.DB_PATH ??
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data", "mappings.sqlite");

/** Telegram "General" forum topic thread id — ignore staff chatter there */
const GENERAL_TOPIC_ID = 1;

const JEV_ENABLED_RAW = (process.env.JEV_ENABLED ?? "").trim().toLowerCase();
const JEV_ENABLED =
  JEV_ENABLED_RAW === "" ||
  JEV_ENABLED_RAW === "1" ||
  JEV_ENABLED_RAW === "true" ||
  JEV_ENABLED_RAW === "yes" ||
  JEV_ENABLED_RAW === "on";

if (!BOT_TOKEN) {
  console.error("Missing BOT_TOKEN. Copy .env.example → .env and fill it in.");
  process.exit(1);
}

const SETUP_MODE = !FORUM_GROUP_ID_RAW;
const FORUM_GROUP_ID = SETUP_MODE ? 0 : Number(FORUM_GROUP_ID_RAW);
if (!SETUP_MODE && !Number.isFinite(FORUM_GROUP_ID)) {
  console.error("FORUM_GROUP_ID must be a number (e.g. -1001234567890).");
  process.exit(1);
}
if (SETUP_MODE) {
  console.warn(
    "SETUP MODE: FORUM_GROUP_ID is empty. /groupid works; relay is paused until you set it.",
  );
}

const bot = new Bot(BOT_TOKEN);
const store = new MappingStore(DB_PATH);

let botId: number | undefined;

function displayName(ctx: Context): string {
  const u = ctx.from;
  if (!u) return "unknown";
  const name = [u.first_name, u.last_name].filter(Boolean).join(" ").trim();
  return name || u.username || String(u.id);
}

function topicNameFor(ctx: Context): string {
  const u = ctx.from!;
  const name = displayName(ctx);
  const raw = TOPIC_NAME_TEMPLATE.replaceAll("{name}", name)
    .replaceAll("{id}", String(u.id))
    .replaceAll("{username}", u.username ? `@${u.username}` : "");
  // Telegram topic name max length is 128
  return raw.slice(0, 128).trim() || `User ${u.id}`;
}

function isPrivateChat(ctx: Context): boolean {
  return ctx.chat?.type === "private";
}

function isForumGroup(ctx: Context): boolean {
  return !SETUP_MODE && ctx.chat?.id === FORUM_GROUP_ID;
}

/** Service / system messages that should never be relayed */
function isServiceMessage(msg: NonNullable<Context["message"]>): boolean {
  return Boolean(
    msg.forum_topic_created ||
      msg.forum_topic_edited ||
      msg.forum_topic_closed ||
      msg.forum_topic_reopened ||
      msg.general_forum_topic_hidden ||
      msg.general_forum_topic_unhidden ||
      msg.pinned_message ||
      msg.message_auto_delete_timer_changed ||
      msg.new_chat_members ||
      msg.left_chat_member ||
      msg.new_chat_title ||
      msg.new_chat_photo ||
      msg.delete_chat_photo ||
      msg.group_chat_created ||
      msg.supergroup_chat_created ||
      msg.migrate_to_chat_id ||
      msg.migrate_from_chat_id ||
      msg.successful_payment ||
      msg.connected_website ||
      msg.write_access_allowed ||
      msg.users_shared ||
      msg.chat_shared,
  );
}

function sourceLabel(source: "script" | "knowledge" | "none"): string {
  if (source === "script") return "固定话术";
  if (source === "knowledge") return "店铺知识库";
  return "未匹配";
}

/** Operator checklist — Chinese-first; used by /setup and SETUP_MODE DMs */
function setupChecklistText(): string {
  if (SETUP_MODE) {
    return [
      "🛠️ 管理员配置清单（SETUP_MODE）",
      "",
      "✅ 步骤 1：BOT_TOKEN 已生效（你能看到这条消息，说明 Token 正确、Bot 已启动）",
      "⬜ 步骤 2：确认已新建「超级群」并开启 Topics（论坛话题）",
      "⬜ 步骤 3：把 Bot 加成管理员（至少：管理话题 + 发消息）",
      "⬜ 步骤 4：在超级群里发送 /groupid，复制回覆的负数 id",
      "⬜ 步骤 5：写入 .env：",
      "     FORUM_GROUP_ID=-100……",
      "⬜ 步骤 6：保存后重启 Bot（Ctrl+C，再 npm run dev / npm start）",
      "",
      "当前卡在：还缺 FORUM_GROUP_ID。",
      "拿群 id → 群里发 /groupid；完整图文步骤见仓库 docs/SETUP.zh.md。",
      "",
      "English: Token OK; set FORUM_GROUP_ID from /groupid in the forum supergroup, then restart.",
    ].join("\n");
  }

  return [
    "✅ 配置已完成",
    "",
    `• BOT_TOKEN：已设置`,
    `• FORUM_GROUP_ID：已设置（${FORUM_GROUP_ID}）`,
    `• Jev 建议回复：${JEV_ENABLED ? "开启" : "关闭"}`,
    "",
    "运维小提示：",
    "• 编辑 data/scripts.json（固定话术）、data/knowledge.md（知识库）后重启 Bot",
    "• 客服在用户话题里回复，或点 Jev「发送给客户」",
    "• 群内发 /groupid 可核对群 id；私聊 /whoami 看自己的 user id",
    "• 新手图文：docs/SETUP.zh.md",
    "",
    "English: Fully configured. Edit scripts/knowledge, restart after changes.",
  ].join("\n");
}

function setupModeDmHint(): string {
  return [
    "⚙️ Bot 还在配置中（SETUP_MODE）：尚未设置超级群 FORUM_GROUP_ID，暂时不能转达客服消息。",
    "",
    "管理员请按下面做：",
    "1. 确认超级群已开 Topics，且 Bot 是管理员（管理话题 + 发消息）",
    "2. 在超级群里发送 /groupid，复制回覆的数字",
    "3. 写入 .env 的 FORUM_GROUP_ID=（一般为 -100…），保存后重启 Bot",
    "",
    "私聊发送 /setup 可查看完整清单；/help 查看命令。",
    "",
    "English: FORUM_GROUP_ID missing — send /groupid in the forum group, paste into .env, restart. /setup for checklist.",
  ].join("\n");
}

async function postJevSuggestion(
  userId: number,
  threadId: number,
  userText: string,
): Promise<void> {
  if (!JEV_ENABLED) return;
  const result = suggest(userText);
  if (!result || result.source === "none" || !result.answer.trim()) return;

  const suggestionId = store.saveJevSuggestion(userId, threadId, result.answer);
  const header = `💡 Jev 建议回复（来源：${sourceLabel(result.source)}）`;
  const body = `${header}\n\n${result.answer}`;
  // Plain text — avoid parse_mode breakage from KB/script content
  const keyboard = new InlineKeyboard().text(
    "发送给客户",
    `jev:${suggestionId}`,
  );

  try {
    await bot.api.sendMessage(FORUM_GROUP_ID, body, {
      message_thread_id: threadId,
      reply_markup: keyboard,
    });
  } catch (err) {
    console.error("Failed to post Jev suggestion:", err);
    store.deleteJevSuggestion(suggestionId);
  }
}

async function ensureTopic(ctx: Context): Promise<number> {
  const userId = ctx.from!.id;
  const existing = store.getByUserId(userId);
  if (existing) return existing.threadId;

  const name = topicNameFor(ctx);
  const topic = await ctx.api.createForumTopic(FORUM_GROUP_ID, name);
  store.upsert(userId, topic.message_thread_id, displayName(ctx));

  // Optional intro banner inside the new topic
  const un = ctx.from?.username ? `@${ctx.from.username}` : "(no username)";
  await ctx.api.sendMessage(
    FORUM_GROUP_ID,
    [
      `🆕 New support topic`,
      `User: ${displayName(ctx)} ${un}`,
      `user_id: ${userId}`,
      `Reply in this topic to message the user.`,
    ].join("\n"),
    { message_thread_id: topic.message_thread_id },
  );

  return topic.message_thread_id;
}

/** /start — setup guide for operators in SETUP_MODE; bilingual greeting otherwise */
bot.command("start", async (ctx) => {
  if (!isPrivateChat(ctx)) return;

  if (SETUP_MODE) {
    await ctx.reply(
      [
        "👋 管理员配置引导",
        "",
        "Bot 已启动，但还在 SETUP_MODE（未设置 FORUM_GROUP_ID）。",
        "终端用户暂时无法把消息转到客服群。",
        "",
        setupChecklistText(),
        "",
        "也可以随时发 /setup 再看一遍清单，或 /help 看命令说明。",
      ].join("\n"),
    );
    return;
  }

  await ctx.reply(
    [
      "👋 你好！直接发消息给我，系统会为你创建专属客服话题，工作人员会在话题里回复。",
      "",
      "Hello! Send me a message and a dedicated support topic will be created. Staff will reply inside that topic.",
      "",
      "支持文字 / 图片 / 文件 / 贴纸等。",
      "Text, photos, documents, stickers, and more are supported.",
      "",
      "管理员可发 /setup 查看配置清单。",
    ].join("\n"),
  );
});

/** /setup — printable remaining-steps checklist (private) */
bot.command("setup", async (ctx) => {
  if (!isPrivateChat(ctx)) {
    await ctx.reply("请私聊 Bot 发送 /setup。 / Use /setup in a private chat with the bot.");
    return;
  }
  await ctx.reply(setupChecklistText());
});

/** /help — commands for operators vs end users */
bot.command("help", async (ctx) => {
  if (!isPrivateChat(ctx)) {
    await ctx.reply(
      [
        "群内可用：/groupid — 显示本群 chat id，用于填写 FORUM_GROUP_ID",
        "",
        "In groups: /groupid — print this chat id for FORUM_GROUP_ID",
      ].join("\n"),
    );
    return;
  }

  await ctx.reply(
    [
      "📖 命令说明",
      "",
      "【终端用户】",
      "/start — 欢迎语 / 开始使用",
      "直接发文字、图片、文件等 → 转到客服话题",
      "",
      "【管理员 / 运维】",
      "/setup — 配置清单（SETUP_MODE 时显示还差哪步）",
      "/groupid — 在超级群里发送，获取 FORUM_GROUP_ID",
      "/whoami — 查看自己的 user id / chat id",
      "/help — 本说明",
      "",
      SETUP_MODE
        ? "当前状态：SETUP_MODE（FORUM_GROUP_ID 未设置）→ 请完成 /setup 清单。"
        : "当前状态：已配置完成，可正常转达。",
      "",
      "图文安装：仓库 docs/SETUP.zh.md",
      "",
      "English: /setup checklist · /groupid in forum group · /whoami debug ids.",
    ].join("\n"),
  );
});

/** /whoami — debug helper: print your Telegram user/chat id (private) */
bot.command("whoami", async (ctx) => {
  if (!isPrivateChat(ctx)) return;
  await ctx.reply(
    [
      `你的 user id：\`${ctx.from?.id}\``,
      `你的 chat id：\`${ctx.chat?.id}\``,
      "",
      SETUP_MODE
        ? "论坛群（FORUM_GROUP_ID）：尚未设置（SETUP_MODE）"
        : `论坛群（已配置）：\`${FORUM_GROUP_ID}\``,
      "",
      `Your user id: \`${ctx.from?.id}\``,
      `Forum group: ${SETUP_MODE ? "(not set)" : `\`${FORUM_GROUP_ID}\``}`,
    ].join("\n"),
    { parse_mode: "Markdown" },
  );
});

/**
 * Capture group id when someone posts in the configured group (or any group
 * while debugging). Useful during setup if FORUM_GROUP_ID is wrong.
 */
bot.command("groupid", async (ctx) => {
  if (!ctx.chat || ctx.chat.type === "private") {
    await ctx.reply(
      [
        "请在「论坛超级群」里发送 /groupid（不要私聊发）。",
        "",
        "拿到数字后：把下面格式写入 .env，保存并重启 Bot。",
        "FORUM_GROUP_ID=-100……",
        "",
        "English: Send /groupid inside the forum supergroup, not in private chat.",
      ].join("\n"),
    );
    return;
  }

  const id = ctx.chat.id;
  await ctx.reply(
    [
      "✅ 已获取本群 chat id",
      "",
      "把下面这一行复制到 .env：",
      `FORUM_GROUP_ID=${id}`,
      "",
      "改完后重启 Bot（Ctrl+C，再 npm run dev / npm start）。",
      "超级群 id 一般是负数，形如 -100……",
      "",
      "English: Paste that line into .env, then restart the bot.",
    ].join("\n"),
  );
});

/** Staff clicks 「发送给客户」 on a Jev suggestion */
bot.on("callback_query:data", async (ctx) => {
  const data = ctx.callbackQuery.data;
  if (!data.startsWith("jev:")) return;

  const suggestionId = data.slice("jev:".length);
  const row = store.getJevSuggestion(suggestionId);
  if (!row) {
    await ctx.answerCallbackQuery({
      text: "建议已过期或不存在",
      show_alert: false,
    });
    return;
  }

  try {
    await ctx.api.sendMessage(row.userId, row.answer);
    store.deleteJevSuggestion(suggestionId);
    await ctx.answerCallbackQuery({ text: "已发送给客户 ✅" });
    try {
      await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } });
    } catch {
      /* ignore — message may be too old to edit */
    }
  } catch (err) {
    console.error("Failed to send Jev suggestion to user:", err);
    await ctx.answerCallbackQuery({
      text: "发送失败，用户可能已屏蔽 Bot",
      show_alert: true,
    });
  }
});

bot.on("message", async (ctx) => {
  const msg = ctx.message;
  if (!msg || !ctx.chat || !ctx.from) return;

  // Never relay the bot's own messages (loop prevention) — includes Jev suggestions
  if (botId !== undefined && ctx.from.id === botId) return;
  if (ctx.from.is_bot) return;

  // Skip commands already handled — other slash cmds ignore
  if (msg.text?.startsWith("/")) return;

  if (isServiceMessage(msg)) return;

  // ─── Staff → User: message inside a forum topic ─────────────────────
  if (isForumGroup(ctx)) {
    const threadId = msg.message_thread_id;
    if (threadId === undefined || threadId === GENERAL_TOPIC_ID) {
      // Ignore General topic and messages without a thread
      return;
    }

    const mapping = store.getByThreadId(threadId);
    if (!mapping) {
      // Unknown topic — not created by this bot (or DB wiped)
      return;
    }

    try {
      await ctx.api.copyMessage(mapping.userId, FORUM_GROUP_ID, msg.message_id);
    } catch (err) {
      console.error("Failed to deliver staff reply to user:", err);
      try {
        await ctx.api.sendMessage(
          FORUM_GROUP_ID,
          "❌ Delivery failed — user may have blocked the bot or deleted the chat.",
          { message_thread_id: threadId },
        );
      } catch {
        /* ignore secondary failure */
      }
    }
    return;
  }

  // ─── User → Staff: private DM ───────────────────────────────────────
  if (!isPrivateChat(ctx)) return;

  if (SETUP_MODE) {
    await ctx.reply(setupModeDmHint());
    return;
  }

  try {
    let threadId: number;
    try {
      threadId = await ensureTopic(ctx);
    } catch (err) {
      // Topic may have been deleted; clear mapping and recreate once
      console.warn("ensureTopic failed, retrying once:", err);
      store.deleteByUserId(ctx.from.id);
      threadId = await ensureTopic(ctx);
    }

    // Verify mapping still works: if copy fails with THREAD_NOT_FOUND, recreate
    try {
      await ctx.api.copyMessage(FORUM_GROUP_ID, ctx.chat.id, msg.message_id, {
        message_thread_id: threadId,
      });
    } catch (copyErr: unknown) {
      const desc =
        copyErr && typeof copyErr === "object" && "description" in copyErr
          ? String((copyErr as { description: string }).description)
          : String(copyErr);
      if (/thread not found|TOPIC_ID_INVALID|message thread not found/i.test(desc)) {
        store.deleteByUserId(ctx.from.id);
        threadId = await ensureTopic(ctx);
        await ctx.api.copyMessage(FORUM_GROUP_ID, ctx.chat.id, msg.message_id, {
          message_thread_id: threadId,
        });
      } else {
        throw copyErr;
      }
    }

    // Jev: text-only suggestions after successful relay (staff topic only)
    if (typeof msg.text === "string" && msg.text.trim()) {
      await postJevSuggestion(ctx.from.id, threadId, msg.text);
    }
  } catch (err) {
    console.error("Failed to relay user message to forum topic:", err);
    await ctx.reply("❌ 转达失败，请稍后再试。 / Relay failed, try again later.");
  }
});

bot.catch((err) => {
  console.error("Bot error:", err);
});

console.log("TG-jev-chatbot starting…");
console.log(`SQLite store: ${DB_PATH}`);
console.log(`Jev suggested replies: ${JEV_ENABLED ? "ON" : "OFF"}`);

bot.start({
  onStart: async (info) => {
    botId = info.id;
    console.log(
      SETUP_MODE
        ? `Bot @${info.username} (id=${info.id}) running in SETUP MODE (no FORUM_GROUP_ID yet).`
        : `Bot @${info.username} (id=${info.id}) running. Forum group: ${FORUM_GROUP_ID}`,
    );
  },
});

function shutdown() {
  console.log("Shutting down…");
  store.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
