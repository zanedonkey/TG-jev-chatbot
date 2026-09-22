/**
 * tg-relay-bot — two-way Telegram relay
 *
 * Flow:
 * 1. End user DMs the bot → message is forwarded/copied to ADMIN_CHAT_ID
 *    with a label; we store message_id → user chat_id for reply routing.
 * 2. Admin replies (as a Telegram reply) to that relayed message →
 *    bot delivers the reply back to the original user.
 *
 * Mapping is an in-memory Map — lost on restart (fine for v0).
 */

import "dotenv/config";
import { Bot, Context } from "grammy";

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID_RAW = process.env.ADMIN_CHAT_ID;

if (!BOT_TOKEN) {
  console.error("Missing BOT_TOKEN. Copy .env.example → .env and fill it in.");
  process.exit(1);
}
if (!ADMIN_CHAT_ID_RAW) {
  console.error("Missing ADMIN_CHAT_ID. Message the bot /whoami as admin to get your chat id.");
  process.exit(1);
}

const ADMIN_CHAT_ID = Number(ADMIN_CHAT_ID_RAW);
if (!Number.isFinite(ADMIN_CHAT_ID)) {
  console.error("ADMIN_CHAT_ID must be a number.");
  process.exit(1);
}

const bot = new Bot(BOT_TOKEN);

/** Maps admin-side message_id → original user chat_id */
const relayMap = new Map<number, number>();

function isAdmin(ctx: Context): boolean {
  return ctx.chat?.id === ADMIN_CHAT_ID;
}

function userLabel(ctx: Context): string {
  const u = ctx.from;
  if (!u) return "unknown";
  const name = [u.first_name, u.last_name].filter(Boolean).join(" ");
  const un = u.username ? `@${u.username}` : "(no username)";
  return `${name} ${un} · id=${u.id}`;
}

/** /start — bilingual help for end users */
bot.command("start", async (ctx) => {
  await ctx.reply(
    [
      "👋 你好！直接发消息给我，管理员会回复你。",
      "Hello! Send a message and wait for a reply.",
      "",
      "支持文字 / 图片 / 文件。",
      "Text, photos, and documents are supported.",
    ].join("\n"),
  );
});

/** /whoami — admin-only helper to print chat id during setup */
bot.command("whoami", async (ctx) => {
  if (!isAdmin(ctx)) {
    await ctx.reply("This command is for the admin only.");
    return;
  }
  await ctx.reply(
    `Your chat id: \`${ctx.chat!.id}\`\nSet this as ADMIN_CHAT_ID in .env`,
    { parse_mode: "Markdown" },
  );
});

/**
 * Incoming messages from non-admin users → relay to admin.
 * Prefer copyMessage so media is preserved; fall back to text for plain messages.
 */
bot.on("message", async (ctx) => {
  const msg = ctx.message;
  if (!msg || !ctx.chat) return;

  // --- Admin branch: reply to a relayed message → deliver back to user ---
  if (isAdmin(ctx)) {
    const replyTo = msg.reply_to_message;
    if (!replyTo) {
      // Ignore non-reply admin chatter (except commands handled above)
      return;
    }
    const userChatId = relayMap.get(replyTo.message_id);
    if (userChatId === undefined) {
      await ctx.reply(
        "⚠️ 找不到对应用户（可能 bot 重启后映射已丢失）。请让用户重新发一条消息。\n" +
          "No mapping for this message (map is in-memory; restart clears it).",
      );
      return;
    }

    try {
      // Copy admin's reply (text / photo / document…) back to the user
      await ctx.api.copyMessage(userChatId, ADMIN_CHAT_ID, msg.message_id);
      await ctx.reply("✅ 已送达 / Delivered");
    } catch (err) {
      console.error("Failed to deliver reply to user:", err);
      await ctx.reply("❌ 送达失败 / Delivery failed — user may have blocked the bot.");
    }
    return;
  }

  // --- User branch: relay to admin ---
  const header =
    `📩 From: ${userLabel(ctx)}\n` +
    `chat_id=${ctx.chat.id}\n` +
    `────────`;

  try {
    // Send a small label first, then copy the original message under it
    const labelMsg = await ctx.api.sendMessage(ADMIN_CHAT_ID, header);

    // For text-only, include text in one message so admin can reply to a single bubble;
    // for media, copyMessage keeps the media and admin replies to the copied message.
    let linkedMessageId: number;

    if (msg.text && !msg.photo && !msg.document && !msg.video && !msg.audio && !msg.voice && !msg.sticker) {
      const forwarded = await ctx.api.sendMessage(
        ADMIN_CHAT_ID,
        msg.text,
        { reply_parameters: { message_id: labelMsg.message_id } },
      );
      linkedMessageId = forwarded.message_id;
    } else {
      const copied = await ctx.api.copyMessage(
        ADMIN_CHAT_ID,
        ctx.chat.id,
        msg.message_id,
        { reply_parameters: { message_id: labelMsg.message_id } },
      );
      linkedMessageId = copied.message_id;
    }

    relayMap.set(linkedMessageId, ctx.chat.id);
    // Also map the label message so admin can reply to either bubble
    relayMap.set(labelMsg.message_id, ctx.chat.id);

    await ctx.reply("✉️ 已转达，请稍候回复。 / Relayed — please wait for a reply.");
  } catch (err) {
    console.error("Failed to relay to admin:", err);
    await ctx.reply("❌ 转达失败，请稍后再试。 / Relay failed, try again later.");
  }
});

bot.catch((err) => {
  console.error("Bot error:", err);
});

console.log("tg-relay-bot starting…");
bot.start({
  onStart: (info) => {
    console.log(`Bot @${info.username} is running. Admin chat: ${ADMIN_CHAT_ID}`);
  },
});
