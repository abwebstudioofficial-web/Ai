# Site Agent for LogistiX

A low-cost operations assistant for LogistiX. It lives inside your Supabase project:

- It checks the website and the database on a schedule and sends you a morning report on Telegram.
- It alerts you the moment something new breaks.
- You can ask it questions from the admin panel or from Telegram.

**The scheduled checks use no AI at all.** They are plain database queries and HTTP checks. Claude is only used in two situations:

1. **A check finds a NEW problem.** One short call to **Claude Haiku** (the cheapest model) explains it and suggests a fix. That happens once per problem, never again while it stays open.
2. **You ask a question.** Then the bigger model (`claude-opus-5`) answers, using tools to look into your data, site and code.

A day with no new problems makes **zero** AI calls.

> **Wiring it into the site:** give [`HANDOFF.md`](HANDOFF.md) to the Claude chat that works on the LogistiX code.

## What happens when

| When | What happens | AI cost |
|---|---|---|
| **08:00 every morning (PKT)** | 21 rule-based checks run: the website and its JS/CSS files, the Supabase API, database health, failed cron jobs, failed Edge Function calls, security settings, and 12 business rules for orders, ETAs, fleet documents, invoices, contracts and the fuel-price feed. A **morning report** goes to Telegram (and email or WhatsApp if you set them up). | **Free.** Plus one Haiku call (≈ US$0.005) only if a problem is new. |
| **Every 15 minutes** | Quick uptime checks. A new failure sends you an alert with a short explanation. When it's fixed, you get "✅ Recovered". | **Free.** Plus one Haiku call only if a problem is new. |
| **You ask a question** (dashboard or Telegram) | The agent investigates with tools and answers. Any change it proposes waits for your approval. | ≈ US$0.05 (simple lookup) to ≈ US$0.50 (deep investigation); typically ≈ US$0.15 |
| **You approve or reject a change** | The change runs (or doesn't). The result is shown to you directly. | **Free** |

Example morning report on a healthy day:

```
📋 Morning report - Sat, 26 Sept 2026

✅ All 21 checks passed - nothing needs your attention.

📦 Orders: In transit 12 · due today/tomorrow 3 · late 0 · delivered yesterday 5 · new orders yesterday 7
```

A problem that is still open the next day shows up as `(open since 26 Sept)`, with the fix that was suggested earlier. It is not explained again.

## Estimated monthly cost (normal month)

| Item | Assumption | Cost |
|---|---|---|
| Morning checks + 15-minute monitor | 30 reports, about 2,900 monitor runs | **US$0.00** |
| Explaining new problems (Claude Haiku) | about 5–10 new problems a month, ≈ US$0.005 each | **≈ US$0.03–0.05** |
| Your questions (Claude Opus 5, medium effort) | 0 questions → US$0; 20 questions × ≈ US$0.15 average | **US$0 – ≈ US$3** |
| Supabase / Telegram | Everything fits inside normal plan limits; Telegram is free | **US$0.00** |
| **Total** | | **≈ US$0.05 with no questions; ≈ US$3 if you ask about 20 questions** |

These are estimates. Question cost depends on how much digging a question needs, and a simple lookup is only a few cents. Three things keep it bounded:

- **Hard monthly cap:** `AI_MONTHLY_BUDGET_USD` (default **US$5**). When it's reached, all Site Agent AI calls stop until next month. Checks, reports and alerts keep working.
- **Spend tracking:** every Claude call is logged with its estimated cost in `agent_ai_calls`. The panel shows "AI this month", and `/cost` on Telegram tells you.
- **Cheaper questions if you want:** set `AGENT_MODEL=claude-sonnet-5` (roughly half the price per question) or `AGENT_EFFORT=low`. To turn off the automatic explanations entirely, set `AI_EXPLAIN_PROBLEMS=false`; that means zero automatic AI calls ever.

> The separate **✦ Research assistant** already in LogistiX (the `research-agent` function) is not part of Site Agent. It uses Claude Opus 5 plus web searches for every message, and it is **not** covered by this cap.

## What the checks look for

You or the agent can add more rules at any time.

- Orders past their ETA while containers are still undelivered, plus a heads-up list for today and tomorrow
- Containers stuck at "Picked Up" or "In Transit" for more than 7 days
- Containers still at "Confirmed" long after their loading date. Today about 1,524 look like old imported data; they're listed under FYI, not as a problem.
- Driver licences and medicals, and vehicle insurance and registration, expiring within 30 days
- Vehicles due for service
- Overdue invoices and expiring customer contracts
- The daily fuel price not updating
- Data mistakes: ETA before the order date, duplicate bilty numbers
- Site and platform: pages or JS/CSS missing, API down, failed cron jobs, failed Edge Function calls, tables without row-level security, and optionally Supabase advisors and API error logs

## Safety: nothing changes without you

- The agent can look at everything, but **every change waits for your one-click approval**. That covers data fixes (always test-run first, showing the exact row count), schema migrations, and code pull requests.
- Code changes are small pull requests on `maint/...` branches from the latest `main`. It checks `WORKING_ON.md` and open PRs first, and it never merges.
- It never touches your existing Edge Functions or cron jobs. Anything involving cron, logins or storage always needs your approval.
- It can't read server files, switch database roles, or approve its own requests. Every action is recorded in an audit log.

Once you trust it more, `AGENT_AUTONOMY` can be relaxed to `standard` or `full`; see `.env.example`.

## How it works

```
 pg_cron (08:00 PKT / every 15 min)                   Admin panel (index.html) · Telegram
            │                                                    │ your question
            ▼                                                    ▼
   site-agent-cron: rule-based checks (SQL + HTTP)      site-agent-chat / site-agent-telegram
            │                                                    │
            ├─► alerts + morning report ─► Telegram / email      ▼
            │                                           site-agent-worker ─► Claude Opus 5 + tools
            └─► NEW problem only ─► 1 × Claude Haiku           (database, site checks, logs,
                (explain + suggest fix, no tools)               GitHub PRs, alerts, memory)
```

## Files

- `supabase/migrations/`: tables (including the AI cost ledger) and schedules
- `supabase/functions/`: 4 Edge Functions plus shared code
  - checks and report: `_shared/checks.ts`, `_shared/report.ts`, `_shared/jobs.ts`
  - the Haiku explanation: `_shared/explain.ts`
  - the cost cap: `_shared/ai_cost.ts`
- `web/SiteAgentPanel.jsx`: the admin panel for `index.html`
- `HANDOFF.md`: step-by-step setup for whoever wires it in
- `.env.example`: all settings, explained
