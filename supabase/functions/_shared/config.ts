// All configuration comes from Edge Function secrets (supabase secrets set ...).
// See .env.example at the repo root for the full list with explanations.

export type Autonomy = "readonly" | "standard" | "full";
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
export type Severity = "info" | "warning" | "critical";

function env(key: string, fallback = ""): string {
  const v = Deno.env.get(key);
  return v === undefined || v.trim() === "" ? fallback : v.trim();
}

function envInt(key: string, fallback: number): number {
  const n = Number.parseInt(env(key), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function envBool(key: string, fallback: boolean): boolean {
  const v = env(key).toLowerCase();
  if (v === "") return fallback;
  return ["1", "true", "yes", "on"].includes(v);
}

function envList(key: string): string[] {
  return env(key)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function oneOf<T extends string>(value: string, allowed: readonly T[], fallback: T): T {
  return (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

const supabaseUrl = env("SUPABASE_URL").replace(/\/+$/, "");

export const config = {
  // --- Claude -----------------------------------------------------------------
  anthropicApiKey: env("ANTHROPIC_API_KEY"),
  // Model for questions you ask directly (dashboard chat / Telegram).
  model: env("AGENT_MODEL", "claude-opus-5"),
  // medium keeps chat answers cheaper; raise to high for harder investigations.
  effort: oneOf<Effort>(env("AGENT_EFFORT"), ["low", "medium", "high", "xhigh", "max"], "medium"),
  // Model for the only automatic AI use: explaining NEW problems found by the checks.
  autoModel: env("AI_AUTO_MODEL", "claude-haiku-4-5"),
  // Explain new problems with AI (false = checks and alerts only, never any AI call).
  explainProblems: envBool("AI_EXPLAIN_PROBLEMS", true),
  // Hard monthly cap on estimated Claude spend in US$ (0 = no cap). When reached, all AI
  // calls stop until next month; checks, reports and alerts keep working.
  monthlyBudgetUsd: Number.parseFloat(env("AI_MONTHLY_BUDGET_USD", "5")) || 0,
  maxTokens: envInt("AGENT_MAX_TOKENS", 16000),
  enableFallbacks: envBool("AGENT_ENABLE_FALLBACKS", true),
  enableCompaction: envBool("AGENT_ENABLE_COMPACTION", true),
  enableWebSearch: envBool("AGENT_ENABLE_WEB_SEARCH", true),

  // --- How much the agent may do on its own ------------------------------------
  // readonly: (default) the agent investigates freely, but EVERY change - data,
  //           schema migration, pull request - waits for your one-click approval
  // standard: small data fixes (one UPDATE/INSERT with WHERE, <= AGENT_MAX_AUTO_ROWS
  //           rows) and pull requests run automatically; deletes, bulk changes and
  //           schema migrations need your approval
  // full:     no approvals except for pg_cron / auth / storage / vault changes
  // Pull requests are never merged by the agent - you merge them on GitHub.
  autonomy: oneOf<Autonomy>(env("AGENT_AUTONOMY"), ["readonly", "standard", "full"], "readonly"),
  maxAutoRows: envInt("AGENT_MAX_AUTO_ROWS", 25),
  maxTurnsPerRun: envInt("AGENT_MAX_TURNS_PER_RUN", 30),

  // --- Edge Function runtime limits ---------------------------------------------
  // Free plan: 150s wall clock. Paid plans: 400s (set AGENT_WALL_CLOCK_MS=400000).
  wallClockMs: envInt("AGENT_WALL_CLOCK_MS", 150_000),
  // Don't start a new Claude call unless this much time is left in the worker.
  minTurnMs: envInt("AGENT_MIN_TURN_MS", 85_000),

  // --- Internal ----------------------------------------------------------------
  internalSecret: env("AGENT_INTERNAL_SECRET"),
  supabaseUrl,
  anonKey: env("SUPABASE_ANON_KEY"),
  serviceRoleKey: env("SUPABASE_SERVICE_ROLE_KEY"),
  dbUrl: env("SUPABASE_DB_URL"),
  projectRef: env("AGENT_PROJECT_REF") || (supabaseUrl.match(/^https:\/\/([a-z0-9]+)\.supabase\.co/)?.[1] ?? ""),
  // Personal access token for the Supabase Management API (logs + advisors).
  // Optional. (Secret names may not start with SUPABASE_, hence AGENT_ prefix.)
  managementToken: env("AGENT_SUPABASE_PAT"),

  // --- Your website -----------------------------------------------------------
  siteUrl: env("SITE_URL").replace(/\/+$/, ""),
  siteKeyPaths: envList("SITE_KEY_PATHS"),

  // --- Your code on GitHub (optional) --------------------------------------------
  github: {
    token: env("GITHUB_TOKEN"),
    repo: env("GITHUB_REPO"), // "owner/name"
    defaultBranch: env("GITHUB_DEFAULT_BRANCH", "main"),
  },

  // --- Notifications ---------------------------------------------------------------
  notify: {
    minSeverity: oneOf<Severity>(env("NOTIFY_MIN_SEVERITY"), ["info", "warning", "critical"], "warning"),
    dashboardUrl: env("AGENT_DASHBOARD_URL"),
    telegramBotToken: env("TELEGRAM_BOT_TOKEN"),
    telegramChatIds: envList("TELEGRAM_CHAT_IDS"),
    telegramWebhookSecret: env("TELEGRAM_WEBHOOK_SECRET"),
    resendApiKey: env("RESEND_API_KEY"),
    emailFrom: env("ALERT_EMAIL_FROM"),
    emailTo: envList("ALERT_EMAIL_TO"),
    twilioSid: env("TWILIO_ACCOUNT_SID"),
    twilioToken: env("TWILIO_AUTH_TOKEN"),
    twilioFrom: env("TWILIO_FROM"),
    twilioTo: envList("ALERT_PHONE_TO"),
    webhookUrl: env("ALERT_WEBHOOK_URL"), // Slack or Discord incoming webhook
  },
};

export const githubEnabled = () => Boolean(config.github.token && config.github.repo);
export const platformApiEnabled = () => Boolean(config.managementToken && config.projectRef);

const SEVERITY_RANK: Record<Severity, number> = { info: 0, warning: 1, critical: 2 };
export const severityAtLeast = (s: Severity, min: Severity) => SEVERITY_RANK[s] >= SEVERITY_RANK[min];
