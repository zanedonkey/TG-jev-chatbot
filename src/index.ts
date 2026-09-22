/**
 * tg-relay-bot — Telegram two-way relay via forum topics
 *
 * Flow:
 * 1. User DMs the bot privately.
 * 2. On first content message, bot creates a forum topic in FORUM_GROUP_ID
 *    and stores userId ↔ threadId in SQLite.
 * 3. Subsequent user DMs are copied into that topic (message_thread_id).
 * 4. Staff replies inside the topic → bot copies the reply back to the user DM.
 */

import "dotenv/config";
import { Bot, Context } from "grammy";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MappingStore } from "./store.js";

const BOT_TOKEN = process.env.BOT_TOKEN;
const FORUM_GROUP_ID_RAW = process.env.FORUM_GROUP_ID;
const TOPIC_NAME_TEMPLATE =
  process.env.TOPIC_NAME_TEMPLATE ?? "{name} · {id}";
const DB_PATH =
  process.env.DB_PATH ??
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data", "mappings.sqlite");

/** Telegram "General" forum topic thread id — ignore staff chatter there */
const GENERAL_TOPIC_ID = 1;

if (!BOT_TOKEN) {
  console.error("Missing BOT_TOKEN. Copy .env.example → .env and fill it in.");
  process.exit(1);
}
if (!FORUM_GROUP_ID_RAW) {
  console.error(
    "Missing FORUM_GROUP_ID. Use a forum-enabled supergroup id (usually -100...).",
  );
  process.exit(1);
}

const FORUM_GROUP_ID = Number(FORUM_GROUP_ID_RAW);
if (!Number.isFinite(FORUM_GROUP_ID)) {
  console.error("FORUM_GROUP_ID must be a number (e.g. -1001234567890).");
  process.exit(1);
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
  return ctx.chat?.id === FORUM_GROUP_ID;
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

bot.on("message", async (ctx) => {
  const msg = ctx.message;
  if (!msg || !ctx.chat || !ctx.from) return;

  // Never relay the bot's own messages (loop prevention)
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
  } catch (err) {
    console.error("Failed to relay user message to forum topic:", err);
    await ctx.reply("❌ 转达失败，请稍后再试。 / Relay failed, try again later.");
  }
});

bot.catch((err) => {
  console.error("Bot error:", err);
});

console.log("tg-relay-bot starting…");
console.log(`SQLite store: ${DB_PATH}`);

bot.start({
  onStart: async (info) => {
    botId = info.id;
    console.log(
      `Bot @${info.username} (id=${info.id}) running. Forum group: ${FORUM_GROUP_ID}`,
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
