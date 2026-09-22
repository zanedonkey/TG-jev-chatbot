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

/** /start — bilingual help for end users (private only) */
bot.command("start", async (ctx) => {
  if (!isPrivateChat(ctx)) return;
  await ctx.reply(
    [
      "👋 你好！直接发消息给我，系统会为你创建专属客服话题，工作人员会在话题里回复。",
      "",
      "Hello! Send me a message and a dedicated support topic will be created. Staff will reply inside that topic.",
      "",
      "支持文字 / 图片 / 文件 / 贴纸等。",
      "Text, photos, documents, stickers, and more are supported.",
    ].join("\n"),
  );
});

/** /whoami — debug helper: print your Telegram user/chat id (private) */
bot.command("whoami", async (ctx) => {
  if (!isPrivateChat(ctx)) return;
  await ctx.reply(
    [
      `Your user id: \`${ctx.from?.id}\``,
      `Your chat id: \`${ctx.chat?.id}\``,
      "",
      `Forum group (configured): \`${FORUM_GROUP_ID}\``,
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
    await ctx.reply("Use this command inside the forum supergroup.");
    return;
  }
  await ctx.reply(
    `This chat id: \`${ctx.chat.id}\`\nSet FORUM_GROUP_ID=${ctx.chat.id}`,
    { parse_mode: "Markdown" },
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

  // Skip commands already handled (start/whoami/groupid) — other slash cmds ignore
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
    await ctx.reply(
      "⚙️ Bot 还在配置中：管理员尚未设置超级群 FORUM_GROUP_ID。\nSettings incomplete: FORUM_GROUP_ID not set yet.",
    );
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
