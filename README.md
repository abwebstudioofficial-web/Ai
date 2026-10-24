# Site Agent for LogistiX

A near-zero-cost operations assistant for LogistiX. It lives inside your Supabase project:

- It works only in the background: it checks the website and the database on a schedule and alerts you the moment something new breaks.
- Every message goes to **one person only, the developer, by email**. Nothing is added to the website itself.

**The scheduled checks use no AI at all.** They are plain database queries and HTTP checks. The only automatic AI use is when a check finds a **NEW** problem: then one short call to **Claude Haiku** explains it and suggests a fix, once per problem. A day with no new problems makes **zero** AI calls.

It's a reporter, not a chat. (An optional Telegram bot can be added later for questions, answered by **Claude Sonnet 5**.)

> **Setup details:** see [`HANDOFF.md`](HANDOFF.md).

## What happens when

**On a normal day you get no email at all.** You only hear from Site Agent when a person is genuinely needed, or when it changed the live site.

| When | What happens | AI cost |
|---|---|---|
| **08:00 every day (PKT)** | 21 rule-based checks run (website + JS/CSS files, Supabase API, database health, failed cron jobs and Edge Function calls, security settings, 12 business rules for orders, ETAs, fleet documents, invoices, contracts and the fuel-price feed). **No report is sent.** | **Free.** |
| **Every 15 minutes** | Quick uptime checks, plus the browser errors the site's error catcher reported, plus progress on any automatic fix. | **Free.** |
| A check finds a **new** problem | **One "Needs you" email**, with the details to fix it. The same problem is never emailed again while it's open. | One Haiku call (≈ US$0.005), if a Claude key is set |
| A problem you were emailed about is fixed | "✅ Recovered" email. No recovery email for problems you weren't emailed about. | Free |
| A browser error that is a **small UI bug** in `index.html` | **Automatic fix** (see below) and one short email saying what was broken and what changed, with an undo link. | ≈ US$0.10–0.50 per fix (Claude Sonnet 5) |
| A browser error Site Agent can't or may not fix | One "Needs you" / "Needs your approval" email. | Free (or the fix attempt) |

## Automatic fixes (small UI bugs only)

The site has a small **error catcher** (a script at the top of `index.html` and `fleet_drivers.html`). It sends browser errors, such as a button that throws or a page that crashes, to `agent_site_errors` via the `site-agent-errors` function. It sends no personal data and no typed values. When one is found, Site Agent:

1. Starts from the **latest `main`**. It checks `WORKING_ON.md` and open pull requests, finds the cause in `index.html`, and writes the smallest fix.
2. Opens a pull request from a `maint/auto-fix-<n>` branch, with a `WORKING_ON.md` line.
3. Waits for the **site-check** GitHub workflow. It compiles the app and opens every page in a real browser with **fake data** (the live database is never touched). It also replays the bug: the error must happen on `main` and must be gone on the branch.
4. Removes its `WORKING_ON.md` line, checks again, merges, and emails you. To undo, click **Revert** on the pull request.

What it may **never** merge on its own (enforced in code, `autofix_policy.ts`): more than 30 changed lines; anything touching data loading or saving, amounts or financial calculations, database structure, user roles, permissions or logins, deleting, the research assistant, or new scripts or links. Those become a pull request that waits for your approval. Data problems are emailed to you, never changed.

If a fixed error shows up again (from pages loaded after the fix went live), you get one email with the undo link.

## Estimated monthly cost (normal month)

| Item | Assumption | Cost |
|---|---|---|
| Daily checks + 15-minute monitor | about 2,900 runs a month, no emails on normal days | **US$0.00** |
| Explaining new problems (Claude Haiku) | about 5–10 new problems a month, ≈ US$0.005 each | **≈ US$0.03–0.05** |
| Automatic fixes (Claude Sonnet 5) | a few small UI bugs a month, ≈ US$0.10–0.50 each | **≈ US$0–1.50** |
| Questions | none (this agent isn't used for questions) | **US$0.00** |
| Supabase / email | Everything fits inside normal plan limits; Resend's free plan covers 3,000 emails a month | **US$0.00** |
| **Total** | | **≈ US$0.05 a month without bugs; a few dollars at most with fixes (hard cap US$5)** |

A bad month with 30 new problems would still be only ≈ US$0.15.

Three things keep it bounded:

- **Hard monthly cap:** `AI_MONTHLY_BUDGET_USD` (default **US$5**). When it's reached, all Site Agent AI calls stop until next month. Checks and alerts keep working.
- **Spend tracking:** every Claude call is logged with its estimated cost in `agent_ai_calls`. Run the `status` job to see this month's spend (`ai.spent_this_month_usd`).
- **Zero AI option:** set `AI_EXPLAIN_PROBLEMS=false` for zero automatic AI calls ever. Messages then arrive without the explanation.

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

Once you trust it more, the `autonomy` setting (in `agent_settings`) can be relaxed to `standard` or `full`; see `.env.example`.

## How it works

```
 pg_cron (08:00 PKT / every 15 min)
            │
            ▼
   site-agent-cron: rule-based checks (SQL + HTTP) ──► alerts
            │
            ├─► NEW problem only ─► 1 × Claude Haiku (explain + suggest fix, no tools)
            ▼
   message ──► email to the developer (Resend)
          └──► saved in agent_notifications (a log of everything sent)

 Optional (Telegram): question sent to the bot ─► site-agent-worker ─► Claude Sonnet 5 + tools
```

## Files

- `supabase/migrations/`: tables (including the AI cost ledger) and schedules
- `supabase/functions/`: 3 Edge Functions (`site-agent-cron`, `site-agent-telegram`, `site-agent-worker`) plus shared code
  - checks and report: `_shared/checks.ts`, `_shared/report.ts`, `_shared/jobs.ts`
  - the Haiku explanation: `_shared/explain.ts`
  - the cost cap: `_shared/ai_cost.ts`
- `HANDOFF.md`: step-by-step setup
- `.env.example`: all settings, explained
