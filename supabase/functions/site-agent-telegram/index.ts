// Chat with the agent and approve its requests from Telegram.
// Setup (see HANDOFF.md): create a bot with @BotFather, store its token in Vault as
// site_agent_telegram_bot_token, deploy with --no-verify-jwt, then run the
// "telegram_setup" job: it registers the webhook and returns a one-time connect link.
// Opening that link (= sending "/start <code>") connects the chat.
//
// Commands: /help  /new  /stop  /check  /cost  /alerts  /approvals  /approve <id> [note]  /reject <id> [note]  /invite
// Anything else is a message to the agent.
import { config } from "../_shared/config.ts";
import { db, errorMessage, toJson } from "../_shared/db.ts";
import { notifyOwners, sendTelegram, telegramApi } from "../_shared/notify.ts";
import { contextBlock } from "../_shared/prompt.ts";
import { ActiveRunError, cancelRun, createConversation, createRun, insertMessage, kickWorker } from "../_shared/runs.ts";
import { ApprovalError, decideApproval, listPendingApprovals } from "../_shared/approvals.ts";
import { runDailyCheck } from "../_shared/jobs.ts";
import { monthToDateUsd } from "../_shared/ai_cost.ts";
import { background, timingSafeEqual } from "../_shared/http.ts";
import { addTelegramChat, ensureSettings, newTelegramClaimCode, redeemTelegramClaimCode } from "../_shared/settings.ts";
import { botUsername } from "../_shared/setup.ts";

const HELP = `Site Agent commands:
/check - run the full morning check now (rule-based, free)
/cost - AI spend this month
/alerts - open alerts
/approvals - requests waiting for you
/approve <id> [note] - approve a request
/reject <id> [note] - reject a request
/stop - stop what the agent is doing
/new - start a fresh conversation
/invite - one-time link to connect another person
Anything else: just ask (e.g. "which orders are late?" or "why is the site slow?").`;

async function currentConversation(chatId: string): Promise<string> {
  const [row] = await db()<{ id: string }[]>`
    select id from public.agent_conversations
    where source = 'telegram' and external_id = ${chatId} and not archived
    order by updated_at desc limit 1`;
  return row?.id ?? await createConversation({ title: "Telegram chat", source: "telegram", externalId: chatId });
}

async function handle(chatId: string, text: string, from: string) {
  const reply = (t: string) => sendTelegram(chatId, t);
  const [cmd, ...rest] = text.split(/\s+/);
  const command = cmd.toLowerCase().replace(/@\w+$/, ""); // "/approve@MyBot" -> "/approve"

  try {
    switch (command) {
      case "/start":
      case "/help":
        return await reply(HELP);

      case "/new": {
        await db()`update public.agent_conversations set archived = true where source = 'telegram' and external_id = ${chatId}`;
        return await reply("Started a fresh conversation.");
      }

      case "/stop": {
        const conversationId = await currentConversation(chatId);
        const [run] = await db()<{ id: string }[]>`
          select id from public.agent_runs where conversation_id = ${conversationId} and status in ('queued', 'running') limit 1`;
        return await reply(run && await cancelRun(run.id) ? "Stopped." : "Nothing is running.");
      }

      case "/check": {
        await reply("Running the full check now - the report arrives in a minute or two.");
        await runDailyCheck(); // sends the report to every configured channel
        return;
      }

      case "/cost": {
        const spent = await monthToDateUsd();
        const cap = config.monthlyBudgetUsd > 0 ? ` of your US$${config.monthlyBudgetUsd.toFixed(2)} monthly cap` : "";
        return await reply(`AI spend this month: about US$${spent.toFixed(2)}${cap}.`);
      }

      case "/alerts": {
        const rows = await db()<{ id: number; severity: string; title: string }[]>`
          select id, severity, title from public.agent_alerts where status <> 'resolved'
          order by case severity when 'critical' then 0 when 'warning' then 1 else 2 end, last_seen_at desc limit 15`;
        const icon = (s: string) => (s === "critical" ? "🔴" : s === "warning" ? "🟡" : "ℹ️");
        return await reply(
          rows.length ? rows.map((r) => `${icon(r.severity)} #${r.id} ${r.title}`).join("\n") : "No open alerts. ✅",
        );
      }

      case "/approvals": {
        const list = await listPendingApprovals();
        return await reply(
          list.length
            ? list.map((a) => `#${a.id} ${a.tool_name}: ${a.reason}`).join("\n\n") + "\n\nReply /approve <id> or /reject <id>."
            : "Nothing waiting for approval.",
        );
      }

      case "/invite": {
        const code = await newTelegramClaimCode();
        return await reply(
          `Forward this link to the person who should get Site Agent messages. It works once, and any earlier unused link stops working:\n\nhttps://t.me/${await botUsername()}?start=${code}`,
        );
      }

      case "/approve":
      case "/reject": {
        const id = Number(rest[0]);
        if (!Number.isInteger(id)) return await reply(`Usage: ${command} <id> [note]`);
        const res = await decideApproval(
          id,
          command === "/approve" ? "approve" : "reject",
          { via: "telegram" },
          rest.slice(1).join(" ") || null,
        );
        const summary = res.status === "rejected"
          ? `Rejected #${id}.`
          : `${res.status === "executed" ? "✅ Approved and done" : "⚠️ Approved but it FAILED"}: #${id}\n\n${
            (res.result ?? "").slice(0, 1500)
          }`;
        return await reply(summary);
      }

      default: {
        const conversationId = await currentConversation(chatId);
        let runId: string;
        try {
          runId = await createRun(conversationId, "chat");
        } catch (e) {
          if (e instanceof ActiveRunError) return await reply("I'm still working on your last message. Send /stop to cancel it.");
          throw e;
        }
        await insertMessage(
          conversationId,
          runId,
          "user",
          [await contextBlock(`telegram (${from})`), { type: "text", text }],
          text,
        );
        await telegramApi("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {});
        await kickWorker(runId);
        return;
      }
    }
  } catch (e) {
    if (e instanceof ApprovalError || e instanceof ActiveRunError) return await reply(e.message);
    console.error("telegram handler error", e);
    await reply(`Error: ${errorMessage(e)}`).catch(() => {});
  }
}

/** A chat that isn't connected yet: "/start <code>" (from the connect link) connects it. */
async function connect(chatId: string, text: string, from: string) {
  const code = text.match(/^\/(?:start|connect)(?:@\w+)?\s+([A-Za-z0-9_-]{16,64})$/)?.[1];
  if (!code || !(await redeemTelegramClaimCode(code))) {
    console.warn("telegram message from unconnected chat", toJson({ chatId, from }));
    await sendTelegram(
      chatId,
      "This chat isn't connected to Site Agent. Ask the owner for a connect link (they can send /invite to the bot).",
    );
    return;
  }
  await addTelegramChat(chatId);
  await sendTelegram(
    chatId,
    `✅ Connected. The morning report arrives here at 8:00, and alerts as soon as something breaks.\n\n${HELP}`,
  );
  await notifyOwners({
    kind: "system",
    severity: "info",
    force: true,
    title: "New Telegram chat connected",
    body: `${from} (chat ${chatId}) now receives Site Agent messages and can approve requests.\n` +
      `If this wasn't you, remove ${chatId} from telegram_chat_ids in the agent_settings table.`,
  });
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("ok");
  await ensureSettings();
  const secret = req.headers.get("x-telegram-bot-api-secret-token") ?? "";
  if (!config.notify.telegramWebhookSecret || !timingSafeEqual(secret, config.notify.telegramWebhookSecret)) {
    return new Response("forbidden", { status: 403 });
  }

  const update = await req.json().catch(() => null) as {
    message?: { text?: string; chat: { id: number }; from?: { first_name?: string; username?: string } };
  } | null;
  const msg = update?.message;
  if (!msg?.text) return new Response("ok");

  const chatId = String(msg.chat.id);
  const from = msg.from?.username ? `@${msg.from.username}` : msg.from?.first_name ?? "someone";
  // Settings are cached for a minute per instance: re-read before treating a chat as unknown
  // (it may have just been connected through another instance).
  if (!config.notify.telegramChatIds.includes(chatId)) await ensureSettings(true);
  if (!config.notify.telegramChatIds.includes(chatId)) {
    background(connect(chatId, msg.text.trim(), from).catch((e) => console.error("telegram connect failed", e)));
    return new Response("ok");
  }

  // Answer Telegram immediately; do the work in the background.
  background(handle(chatId, msg.text.trim(), from));
  return new Response("ok");
});
