// Optional: chat with the agent and approve its requests from Telegram.
// Setup (see HANDOFF.md): create a bot with @BotFather, set TELEGRAM_BOT_TOKEN,
// TELEGRAM_WEBHOOK_SECRET and TELEGRAM_CHAT_IDS, deploy with --no-verify-jwt,
// then register the webhook with the secret token.
//
// Commands: /help  /new  /stop  /check  /cost  /alerts  /approvals  /approve <id> [note]  /reject <id> [note]
// Anything else is a message to the agent.
import { config } from "../_shared/config.ts";
import { db, errorMessage, toJson } from "../_shared/db.ts";
import { sendTelegram } from "../_shared/notify.ts";
import { contextBlock } from "../_shared/prompt.ts";
import { ActiveRunError, cancelRun, createConversation, createRun, insertMessage, kickWorker } from "../_shared/runs.ts";
import { ApprovalError, decideApproval, listPendingApprovals } from "../_shared/approvals.ts";
import { runDailyCheck } from "../_shared/jobs.ts";
import { monthToDateUsd } from "../_shared/ai_cost.ts";
import { background, timingSafeEqual } from "../_shared/http.ts";

const HELP = `Site Agent commands:
/check - run the full morning check now (rule-based, free)
/cost - AI spend this month
/alerts - open alerts
/approvals - requests waiting for you
/approve <id> [note] - approve a request
/reject <id> [note] - reject a request
/stop - stop what the agent is doing
/new - start a fresh conversation
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
        await fetch(`https://api.telegram.org/bot${config.notify.telegramBotToken}/sendChatAction`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, action: "typing" }),
        }).then((r) => r.body?.cancel()).catch(() => {});
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

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("ok");
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
  if (!config.notify.telegramChatIds.includes(chatId)) {
    // Helps with setup: tells you the id to add to TELEGRAM_CHAT_IDS.
    background(
      sendTelegram(chatId, `This chat isn't authorised. If you're the owner, add ${chatId} to TELEGRAM_CHAT_IDS.`).catch(
        () => {},
      ),
    );
    console.warn("telegram message from unauthorised chat", toJson({ chatId, from: msg.from }));
    return new Response("ok");
  }

  const from = msg.from?.username ? `@${msg.from.username}` : msg.from?.first_name ?? "owner";
  // Answer Telegram immediately; do the work in the background.
  background(handle(chatId, msg.text.trim(), from));
  return new Response("ok");
});
