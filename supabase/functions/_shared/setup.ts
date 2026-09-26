// Setup helpers, run through site-agent-cron (e.g. from the SQL editor):
//   select public.agent_invoke('site-agent-cron', '{"job":"status"}');
//   select public.agent_invoke('site-agent-cron', '{"job":"telegram_setup"}');
// then read the answer with:  select content from net._http_response where id = <returned id>;
// Secret VALUES are never returned, only where each one comes from.
import { config } from "./config.ts";
import { db, errorMessage } from "./db.ts";
import { notifyOwners, telegramApi } from "./notify.ts";
import { monthToDateUsd } from "./ai_cost.ts";
import { newTelegramClaimCode, secretSources } from "./settings.ts";

const telegramWebhookUrl = () => `${config.supabaseUrl}/functions/v1/site-agent-telegram`;

const COMMANDS = [
  ["check", "Run the full morning check now"],
  ["alerts", "Open alerts"],
  ["approvals", "Requests waiting for you"],
  ["cost", "AI spend this month"],
  ["new", "Start a fresh conversation"],
  ["stop", "Stop what the agent is doing"],
  ["help", "All commands"],
].map(([command, description]) => ({ command, description }));

/** Checks the Claude API key with a free request (lists models). */
async function anthropicKeyWorks(): Promise<boolean | string> {
  if (!config.anthropicApiKey) return "no key";
  try {
    const res = await fetch("https://api.anthropic.com/v1/models?limit=1", {
      headers: { "x-api-key": config.anthropicApiKey, "anthropic-version": "2023-06-01" },
      signal: AbortSignal.timeout(6_000),
    });
    await res.body?.cancel();
    return res.ok ? true : `HTTP ${res.status}`;
  } catch (e) {
    return errorMessage(e);
  }
}

export async function setupStatus(): Promise<Record<string, unknown>> {
  const [[counts], [claim], anthropicOk, spent] = await Promise.all([
    db()<{ rules: number; alerts: number; notifications: number; last_check: string | null }[]>`
      select (select count(*) from public.agent_watch_rules where enabled)::int as rules,
             (select count(*) from public.agent_alerts where status <> 'resolved')::int as alerts,
             (select count(*) from public.agent_notifications)::int as notifications,
             (select max(created_at)::text from public.agent_health_checks) as last_check`,
    db()<{ n: number }[]>`select count(*)::int as n from vault.decrypted_secrets where name = 'site_agent_telegram_claim_code'`,
    anthropicKeyWorks(),
    monthToDateUsd(),
  ]);

  let telegram: Record<string, unknown> = { configured: false };
  if (config.notify.telegramBotToken) {
    try {
      const [me, hook] = await Promise.all([
        telegramApi<{ username: string }>("getMe"),
        telegramApi<{ url: string; pending_update_count: number; last_error_message?: string }>("getWebhookInfo"),
      ]);
      telegram = {
        configured: true,
        bot: `@${me.username}`,
        webhook_ok: hook.url === telegramWebhookUrl(),
        pending_updates: hook.pending_update_count,
        last_error: hook.last_error_message ?? null,
      };
    } catch (e) {
      telegram = { configured: true, error: errorMessage(e) };
    }
  }

  return {
    site_url: config.siteUrl || null,
    site_key_paths: config.siteKeyPaths,
    secrets: { ...secretSources },
    anthropic_key_works: anthropicOk,
    email: {
      configured: Boolean(config.notify.resendApiKey && config.notify.emailFrom && config.notify.emailTo.length),
      recipients: config.notify.emailTo.length,
      from: config.notify.emailFrom || null,
    },
    telegram: { ...telegram, connected_chats: config.notify.telegramChatIds.length, unused_connect_code: claim.n > 0 },
    autonomy: config.autonomy,
    ai: {
      explain_problems: config.explainProblems,
      auto_model: config.autoModel,
      chat_model: config.model,
      budget_usd: config.monthlyBudgetUsd,
      spent_this_month_usd: Number(spent.toFixed(4)),
    },
    watch_rules_enabled: counts.rules,
    open_alerts: counts.alerts,
    messages: counts.notifications,
    last_check_at: counts.last_check,
  };
}

/**
 * Points the Telegram bot at site-agent-telegram and, while no chat is connected yet, returns a
 * one-time link that connects the developer's chat (the only chat that ever gets messages).
 */
export async function setupTelegram(): Promise<Record<string, unknown>> {
  if (!config.notify.telegramBotToken) {
    return { error: "No bot token. Store it in Vault as site_agent_telegram_bot_token (see HANDOFF.md)." };
  }
  if (!config.notify.telegramWebhookSecret) {
    return { error: "No webhook secret. Vault secret site_agent_telegram_webhook_secret is missing." };
  }
  const me = await telegramApi<{ username: string }>("getMe");
  await telegramApi("setWebhook", {
    url: telegramWebhookUrl(),
    secret_token: config.notify.telegramWebhookSecret,
    allowed_updates: ["message"],
    drop_pending_updates: true,
  });
  await telegramApi("setMyCommands", { commands: COMMANDS });
  if (config.notify.telegramChatIds.length > 0) {
    return {
      bot: `@${me.username}`,
      webhook: telegramWebhookUrl(),
      connected: true,
      note: "Already connected to your chat - nobody else can connect. To move to a new phone/chat, set " +
        "telegram_chat_ids to [] in agent_settings and run this job again.",
    };
  }
  const code = config.notify.telegramClaimCode || await newTelegramClaimCode();
  return {
    bot: `@${me.username}`,
    webhook: telegramWebhookUrl(),
    connect_link: `https://t.me/${me.username}?start=${code}`,
    note: "Open it on your phone (private chat). It works once; after that nobody else can connect.",
  };
}

/** Sends a test message on every configured channel (email, Telegram...) and returns what happened. */
export async function sendTestMessage(): Promise<Record<string, unknown>> {
  const delivered = await notifyOwners({
    kind: "system",
    severity: "info",
    force: true,
    title: "Site Agent test message",
    body: "If you can read this, Site Agent can reach you.\n\n" +
      "You'll get the morning report at 8:00 (Pakistan time) and an alert as soon as something new breaks, " +
      "with the details you need to fix it.",
  });
  return { delivered };
}
