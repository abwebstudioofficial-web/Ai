# Site Agent for LogistiX

Your own AI operations assistant, powered by Claude. It lives inside your Supabase project and works in the background: it watches the website and the database, fixes problems, analyses orders and ETAs, and messages you when something needs attention. You can also chat with it from the admin panel, or from your phone via Telegram.

> **Wiring it into the site:** give [`HANDOFF.md`](HANDOFF.md) to the Claude chat that works on the LogistiX code. It contains every step, written to follow your project rules.

## What it does

| When | What happens |
|---|---|
| **Every morning at 8:00 (Pakistan time)** | A full sanity check runs, covering the website and its JS/CSS files, database health, failed scheduled jobs, failed Edge Function calls, security settings, and 12 business "watch rules". The agent then investigates anything wrong, reviews orders and ETAs, and sends you a short **morning report**. |
| **Every 15 minutes** | A quick uptime check (no AI cost). If something **new** breaks (site down, pages blank, fuel-price feed stale...), you get an alert straight away and the agent starts investigating. When it's fixed, you get a "✅ Recovered" message. |
| **Whenever you ask** | Chat in the **Site Agent** tab or on Telegram: "which containers are late?", "why did the fuel price stop updating?", "check the site for broken pages", "summarise this week's orders". |

What it watches for out of the box. You or the agent can add more rules at any time.

- Orders past their ETA while containers are still undelivered, plus a heads-up list for today and tomorrow
- Containers stuck at "Picked Up" or "In Transit" for more than 7 days
- Containers still at "Confirmed" long after their loading date
- Driver licences and medicals, and vehicle insurance and registration, expiring within 30 days
- Vehicles due for service
- Overdue invoices and expiring customer contracts
- The daily fuel price not updating (the PSO/HiCetane fetch broke)
- Data mistakes: ETA before the order date, duplicate bilty numbers

**First run, from your data today:** no late orders, and 1 overdue invoice. About **1,524 containers are still at "Confirmed" months after their loading date**. That looks like old imported data; the agent will ask you before touching it.

## Safety: nothing changes without you

You asked for "no limits", but your project rules say live data must never change without your approval. So the agent can **look at everything, but every change waits for your one-click approval** (dashboard button, or `/approve 12` on Telegram).

- **Data fixes:** it always test-runs them first and tells you exactly how many rows change.
- **Schema changes:** only as proper Supabase migrations, so they show up in your migration history.
- **Code fixes:** only as small pull requests on a `maint/...` branch, built on the latest `main`. It never merges; you do. Before starting, it checks `WORKING_ON.md` and open pull requests so it doesn't clash with your other Claude sessions.
- **Your fuel-price jobs:** it never touches your existing Edge Functions or cron jobs. Anything involving cron, logins or storage always needs your approval, in every mode.
- **Hard blocks:** it can't read server files, switch database roles, or approve its own requests. Every action is recorded in an audit log.

When you trust it more, change one setting, `AGENT_AUTONOMY`:

| Mode | What runs without asking |
|---|---|
| `readonly` (default) | Nothing. Every change needs approval. |
| `standard` | Small data fixes (one statement, 25 rows or fewer) and opening pull requests. |
| `full` | Everything, except cron, auth, storage and vault changes. Merging pull requests is still yours. |

## Messages

You can receive alerts, approval requests and the morning report on any mix of channels. Configure whichever you want in `.env.example`:

- **Telegram** (recommended, free). It's two-way: you can chat and approve from your phone.
- **Email** via Resend.
- **WhatsApp or SMS** via Twilio.
- **Slack or Discord.**

## Cost (rough estimate)

- **Claude API:** roughly **US$1–3 per morning check** and a few cents per chat question. The 15-minute monitor costs nothing unless something breaks.
  - It uses `claude-opus-5`, configurable with `AGENT_MODEL`.
  - It enables Claude's server-side "fallback" option: if a request is ever declined by a safety filter, the API retries it on a recommended fallback model automatically.
  - Set a monthly spend limit in the Anthropic console.
- **Supabase:** small. About 100 function calls a day, well inside normal plan limits.

## How it works

```
 pg_cron (08:00 PKT / every 15 min / sweeper)          Admin panel (index.html) · Telegram
                │                                                     │
                ▼                                                     ▼
      site-agent-cron ──► health checks ──► alerts          site-agent-chat / site-agent-telegram
                │                                                     │
                └────────────── agent run (queued in DB) ◄───────────┘
                                      │
                                      ▼
                             site-agent-worker  ──►  Claude (claude-opus-5)
                                      │                 │ tool calls
                                      ▼                 ▼
          database (read / approved changes / migrations) · website checks · Supabase logs
          GitHub (read code, open PRs) · alerts · notifications · memory · watch rules
```

- **Background runs:** every conversation and agent step is saved in the database, so runs survive the Edge Function time limit. A long job simply continues in the next worker.
- **Memory:** the agent keeps long-term notes. It already knows your stage names, table layout, code constraints and project rules, and it adds to them as it learns.

## Files

- `supabase/migrations/`: database tables and schedules
- `supabase/functions/`: the agent, split into 4 Edge Functions plus shared code
- `web/SiteAgentPanel.jsx`: the admin panel for `index.html`
- `HANDOFF.md`: step-by-step setup for whoever wires it in
- `.env.example`: all settings, explained
