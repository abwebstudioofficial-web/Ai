// Settings saved in the database instead of Edge Function secrets, so Site Agent can be
// set up and changed without the dashboard's secrets page:
//   - secrets in Supabase Vault, named "site_agent_..." (e.g. site_agent_telegram_bot_token)
//   - plain settings in public.agent_settings (e.g. site_url, telegram_chat_ids)
// An Edge Function secret (environment variable) with the same meaning always wins.
import { type Autonomy, config, type Severity } from "./config.ts";
import { db } from "./db.ts";

const TTL_MS = 60_000;
let loadedAt = 0;

/** Where each secret came from (for the setup status report; never the values). */
export const secretSources: Record<string, "env" | "vault" | "missing"> = {};

const envSet = (key: string) => (Deno.env.get(key) ?? "").trim() !== "";
const text = (v: unknown) => (typeof v === "string" ? v.trim() : v === null || v === undefined ? "" : String(v).trim());
const list = (v: unknown) => (Array.isArray(v) ? v.map(text) : text(v).split(",")).map((s) => s.trim()).filter(Boolean);

/** Loads Vault secrets + agent_settings into `config` (cached for a minute per function instance). */
export async function ensureSettings(force = false): Promise<void> {
  if (!force && loadedAt && Date.now() - loadedAt < TTL_MS) return;
  try {
    const sql = db();
    const [secrets, settings] = await Promise.all([
      sql<{ name: string; value: string }[]>`
        select name, decrypted_secret as value from vault.decrypted_secrets where left(name, 11) = 'site_agent_'`,
      sql<{ key: string; value: unknown }[]>`select key, value from public.agent_settings`,
    ]);
    const S: Record<string, string> = Object.fromEntries(secrets.map((r) => [r.name, r.value ?? ""]));
    const V: Record<string, unknown> = Object.fromEntries(settings.map((r) => [r.key, r.value]));

    // secrets (Vault)
    const source = (envKey: string, vaultName: string) =>
      secretSources[envKey] = envSet(envKey) ? "env" : S[vaultName] ? "vault" : "missing";
    source("AGENT_INTERNAL_SECRET", "site_agent_internal_secret");
    source("ANTHROPIC_API_KEY", "site_agent_anthropic_api_key");
    source("TELEGRAM_BOT_TOKEN", "site_agent_telegram_bot_token");
    source("TELEGRAM_WEBHOOK_SECRET", "site_agent_telegram_webhook_secret");
    source("AGENT_SUPABASE_PAT", "site_agent_supabase_pat");
    source("GITHUB_TOKEN", "site_agent_github_token");
    source("RESEND_API_KEY", "site_agent_resend_api_key");
    if (!envSet("AGENT_INTERNAL_SECRET") && S.site_agent_internal_secret) config.internalSecret = S.site_agent_internal_secret;
    if (!envSet("ANTHROPIC_API_KEY") && S.site_agent_anthropic_api_key) config.anthropicApiKey = S.site_agent_anthropic_api_key;
    if (!envSet("TELEGRAM_BOT_TOKEN") && S.site_agent_telegram_bot_token) {
      config.notify.telegramBotToken = S.site_agent_telegram_bot_token;
    }
    if (!envSet("TELEGRAM_WEBHOOK_SECRET") && S.site_agent_telegram_webhook_secret) {
      config.notify.telegramWebhookSecret = S.site_agent_telegram_webhook_secret;
    }
    config.notify.telegramClaimCode = S.site_agent_telegram_claim_code ?? "";
    if (!envSet("AGENT_SUPABASE_PAT") && S.site_agent_supabase_pat) config.managementToken = S.site_agent_supabase_pat;
    if (!envSet("GITHUB_TOKEN") && S.site_agent_github_token) config.github.token = S.site_agent_github_token;
    if (!envSet("RESEND_API_KEY") && S.site_agent_resend_api_key) config.notify.resendApiKey = S.site_agent_resend_api_key;

    // plain settings (agent_settings)
    if (!envSet("SITE_URL") && text(V.site_url)) config.siteUrl = text(V.site_url).replace(/\/+$/, "");
    if (!envSet("SITE_KEY_PATHS") && V.site_key_paths !== undefined) config.siteKeyPaths = list(V.site_key_paths);
    // Chats connected with the connection code are added to whatever TELEGRAM_CHAT_IDS lists.
    config.notify.telegramChatIds = [...new Set([...list(Deno.env.get("TELEGRAM_CHAT_IDS")), ...list(V.telegram_chat_ids)])];
    if (!envSet("AGENT_DASHBOARD_URL") && text(V.dashboard_url)) config.notify.dashboardUrl = text(V.dashboard_url);
    // Email (Resend): exactly one recipient - the developer.
    if (!envSet("ALERT_EMAIL_TO") && V.email_to !== undefined) config.notify.emailTo = list(V.email_to).slice(0, 1);
    // Without a verified domain, Resend only sends from onboarding@resend.dev (to the account's own address).
    if (!envSet("ALERT_EMAIL_FROM")) config.notify.emailFrom = text(V.email_from) || "Site Agent <onboarding@resend.dev>";
    if (!envSet("GITHUB_REPO") && text(V.github_repo)) config.github.repo = text(V.github_repo);
    const sev = text(V.notify_min_severity);
    if (!envSet("NOTIFY_MIN_SEVERITY") && ["info", "warning", "critical"].includes(sev)) {
      config.notify.minSeverity = sev as Severity;
    }
    const budget = Number(text(V.ai_monthly_budget_usd));
    if (!envSet("AI_MONTHLY_BUDGET_USD") && text(V.ai_monthly_budget_usd) !== "" && Number.isFinite(budget)) {
      config.monthlyBudgetUsd = budget;
    }
    if (!envSet("AI_EXPLAIN_PROBLEMS") && typeof V.ai_explain_problems === "boolean") {
      config.explainProblems = V.ai_explain_problems;
    }
    const autonomy = text(V.autonomy);
    if (!envSet("AGENT_AUTONOMY") && ["readonly", "standard", "full"].includes(autonomy)) {
      config.autonomy = autonomy as Autonomy;
    }
    loadedAt = Date.now();
  } catch (e) {
    console.error("loading Site Agent settings from the database failed", e);
  }
}

/**
 * Makes `chatId` THE Telegram chat that receives Site Agent messages - only if no chat is
 * connected yet (Site Agent has exactly one recipient: the developer). Returns false otherwise.
 */
export async function connectOwnerChat(chatId: string): Promise<boolean> {
  const sql = db();
  const connected = await sql.begin(async (tx) => {
    const [row] = await tx<{ value: unknown }[]>`
      select value from public.agent_settings where key = 'telegram_chat_ids' for update`;
    if (list(row?.value).length > 0) return false;
    await tx`
      insert into public.agent_settings (key, value) values ('telegram_chat_ids', ${tx.json([chatId])})
      on conflict (key) do update set value = excluded.value, updated_at = now()`;
    return true;
  });
  await ensureSettings(true);
  return connected;
}

const CLAIM_SECRET = "site_agent_telegram_claim_code";

/**
 * Creates a new one-time connection code (replacing any unused one). Opening
 * https://t.me/<bot>?start=<code> in a private chat connects that chat - while no chat is connected.
 */
export async function newTelegramClaimCode(): Promise<string> {
  const code = crypto.randomUUID().replace(/-/g, "");
  const sql = db();
  await sql.begin(async (tx) => {
    await tx`delete from vault.secrets where name = ${CLAIM_SECRET}`;
    await tx`select vault.create_secret(${code}, ${CLAIM_SECRET}, 'Site Agent: one-time code to connect a Telegram chat')`;
  });
  await ensureSettings(true);
  return code;
}

/** Uses up the connection code: true if `code` matched (the code is then deleted). */
export async function redeemTelegramClaimCode(code: string): Promise<boolean> {
  if (code.length < 16) return false;
  const sql = db();
  const deleted = await sql<{ name: string }[]>`
    delete from vault.secrets s
    using vault.decrypted_secrets d
    where s.id = d.id and d.name = ${CLAIM_SECRET} and d.decrypted_secret = ${code}::text
    returning s.name`;
  await ensureSettings(true);
  return deleted.length > 0;
}
