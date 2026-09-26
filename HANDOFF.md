# Site Agent: wiring guide

**For the Claude session that connects Site Agent to LogistiX.** Read this whole file before you start. Every step below follows the owner's project rules.

- Code: this repo (`abwebstudioofficial-web/ai`), folder `supabase/` and file `web/SiteAgentPanel.jsx`
- Site: `abwebstudioofficial-web/logistix` (GitHub Pages, so anything merged into `main` goes live)
- Supabase project: `zonuxfqvyxhfkimdahkb`

---

## 0. Project rules

1. **Before any edit, pull the latest `logistix` `main`.** Never work from an old copy.
2. **Never push to `main`.** Use one `maint/...` branch and one small pull request per change. The owner merges.
3. **Before opening the PR, pull `main` again.** If it moved, rebase and resolve carefully. Never force-push, and never overwrite someone else's work.
4. **Database changes only as Supabase migrations.** Use the Supabase MCP `apply_migration` or `supabase db push` so they appear in the migration history. Don't modify live data without the owner's explicit approval.
5. **Don't change the existing Edge Functions or cron jobs without asking the owner first.** That means `fetch-hicetane-price`, `fetch-pso-diesel-price`, and the existing pg_cron jobs `fetch-hicetane-price-daily`, `fetch-hicetane-price-retry` and `fetch-pso-diesel-price-daily`. Site Agent only adds new things; it never modifies these.
6. **Check `WORKING_ON.md` first.** Before you start, add a line saying what you're changing and which part of `index.html`. Remove the line when your PR is merged.
7. **`index.html` code constraints:**
   - The Supabase client is `createLiteClient`: no `.insert()`, no `.limit()`.
   - Keep hooks above early returns.
   - Keep `SortTh` at module scope.

   The panel already respects all of these.

## 1. What's in this repo

| Path | What it is |
|---|---|
| `supabase/migrations/20260926000001_site_agent_schema.sql` | New `agent_*` tables (including the `agent_ai_calls` cost ledger), RLS (admins read-only from the browser), helper functions, the `agent_container_view` view, starter watch rules and memory notes. **Does not alter any existing table.** Safe to re-run. |
| `supabase/migrations/20260926000002_site_agent_cron.sql` | 4 **new** pg_cron jobs: the 08:00 PKT rule-based morning report, a 15-minute monitor, a 1-minute sweeper and daily housekeeping. **Ask the owner before applying (rule 5).** |
| `supabase/functions/site-agent-api` | The site panel's API: the message thread, alerts, health and approvals. Admin-only, verifies the user's session. Never calls Claude, except "Run check now" when it finds a new problem (one Haiku call). |
| `supabase/functions/site-agent-worker` | Only used if someone sends the Telegram bot a question: answers with Claude Sonnet 5 in the background (chunked, so it never hits the Edge Function time limit). |
| `supabase/functions/site-agent-cron` | Entry point for the scheduled jobs. Rule-based: no AI unless a check finds a NEW problem, then one Claude Haiku call. |
| `supabase/functions/site-agent-telegram` | Optional: Telegram commands (/check, /alerts, /cost, /approve...) and optional questions. |
| `supabase/functions/_shared/` | Checks and report (`checks.ts`, `report.ts`, `jobs.ts`), the Haiku explanation (`explain.ts`), the budget cap (`ai_cost.ts`), notifications (saved to `agent_notifications` for the site and sent to Telegram), the question agent, tools, SQL safety guard. |
| `web/SiteAgentPanel.jsx` | The site page: every Site Agent message as a Claude-style chat thread (streams in like Claude), plus Alerts / Health / Approvals tabs. No question box. Written to paste straight into `index.html`. |
| `.env.example` | Every secret/setting, with explanations. |

## 2. Apply the schema migration

Apply `supabase/migrations/20260926000001_site_agent_schema.sql` **as a migration**:

- Supabase MCP: `apply_migration`, name `site_agent_schema`, query = the file contents.
- Or with the CLI: copy it into the project's `supabase/migrations/` and run `supabase db push`.

Then verify (read-only):

```sql
select count(*) from public.agent_watch_rules;                              -- 12
select count(*) from public.agent_ai_calls;                                 -- 0
select key from public.agent_memory order by key;                           -- 5 notes
select stage_name, count(*) from public.agent_container_view group by 1;    -- mostly "Confirmed"
select public.agent_is_admin(id) from public.profiles where role = 'admin'; -- true
```

## 3. Set the Edge Function secrets

Copy `.env.example` to `site-agent.env` and fill it in. **Don't commit the filled-in file.** At minimum set:

- `ANTHROPIC_API_KEY`: the project may already have this secret, since the research assistant uses it. It's shared by all functions, so keep it.
- `AGENT_INTERNAL_SECRET`: generate with `openssl rand -hex 32`
- `SITE_URL`: the live GitHub Pages URL, no trailing slash
- `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_IDS`: the morning report goes here (see step 8)
- `AGENT_WALL_CLOCK_MS`: `150000` on the free plan, `400000` on Pro

Leave the cost settings at their defaults unless the owner says otherwise:

- `AI_AUTO_MODEL=claude-haiku-4-5`
- `AI_MONTHLY_BUDGET_USD=5`
- `AGENT_MODEL=claude-sonnet-5` with `AGENT_EFFORT=medium` (only used if someone asks the Telegram bot a question)

Then run:

```bash
supabase secrets set --project-ref zonuxfqvyxhfkimdahkb --env-file ./site-agent.env
```

## 4. Deploy the functions

```bash
supabase functions deploy site-agent-api      --project-ref zonuxfqvyxhfkimdahkb
supabase functions deploy site-agent-worker   --project-ref zonuxfqvyxhfkimdahkb --no-verify-jwt
supabase functions deploy site-agent-cron     --project-ref zonuxfqvyxhfkimdahkb --no-verify-jwt
supabase functions deploy site-agent-telegram --project-ref zonuxfqvyxhfkimdahkb --no-verify-jwt   # optional
```

Why `--no-verify-jwt` is safe for these: worker and cron check the `x-agent-secret` header themselves, and telegram checks Telegram's secret token. `site-agent-api` keeps JWT verification and also checks that the user is an admin.

If the project has a `supabase/config.toml`, the equivalent is `[functions.site-agent-worker] verify_jwt = false`, and the same for cron and telegram.

## 5. Vault secrets for the scheduler

The owner must do this, or explicitly approve it. It's configuration, not a schema change. In the Dashboard, go to **Project Settings → Vault → Add new secret** and add:

| Name | Value |
|---|---|
| `site_agent_project_url` | `https://zonuxfqvyxhfkimdahkb.supabase.co` |
| `site_agent_internal_secret` | same value as `AGENT_INTERNAL_SECRET` |

## 6. Schedules: ask the owner first

`supabase/migrations/20260926000002_site_agent_cron.sql` adds 4 new jobs:

| Job | Schedule (UTC) | What it does |
|---|---|---|
| `site-agent-daily` | `0 3 * * *` = **08:00 PKT** | Rule-based full checks and the morning report to Telegram. **No AI** unless a check finds a new problem (then one Haiku call, about half a US cent). It runs after the HiCetane fetch (07:00/07:30 PKT). The PSO diesel job runs at 06:00 UTC = 11:00 PKT. |
| `site-agent-monitor` | every 15 min | Quick uptime/critical checks. No AI unless something new breaks (then one Haiku call). |
| `site-agent-sweep` | every minute | Only calls the worker if a Telegram question's answer was interrupted. Idle otherwise. |
| `site-agent-retention` | `30 3 * * *` | Deletes old health checks and audit logs, and expires week-old approvals. |

It does **not** touch the three existing jobs. Once the owner says yes, apply it as a migration (name `site_agent_cron`).

## 7. Add the panel to `index.html` (one small PR)

1. Pull the latest `main`, then create branch `maint/site-agent-panel`.
2. Add to `WORKING_ON.md`: `- Site Agent panel: adding SiteAgentPanel block after the icon set, NAV_ITEMS entry, VIEW_TITLES entry, admin-only nav filter, view route (branch maint/site-agent-panel)`
3. Make these **5 edits** in `index.html`. Line numbers are from `main` @ `00589e0` (after the research assistant was merged), so search for the text rather than trusting the numbers.

   **a) Paste the panel.** Put the whole content of `web/SiteAgentPanel.jsx` inside the `<script type="text/babel">` block at module scope, right before `const FLEET_LINK_KEY = "logistix-fleet-url";` (~line 487, after the icon set).
   - It uses `React.useState` etc., because `index.html` already destructures the hooks at the top.
   - All its names are prefixed `SiteAgent*` / `SA*` / `sa*`. I verified that it compiles together with `index.html` @ `00589e0` under the page's `@babel/standalone@7.23.10`, with no name clashes.
   - It's separate from the floating ✦ Research assistant (`research-agent.js`): leave that as it is.

   **b) Nav item.** In `NAV_ITEMS` (~line 489), add before the `settings` entry:
   ```js
   { key: "site_agent", label: "Site Agent", icon: SiteAgentIcon },
   ```

   **c) Title.** In `VIEW_TITLES` (~line 625), add:
   ```js
   site_agent: "Site Agent",
   ```

   **d) Admin only.** In the sidebar nav filter (~line 3791), change
   ```js
   if (item.key === "users" || item.key === "activity_log" || item.key === "order_history") return session.role === "admin";
   ```
   to
   ```js
   if (item.key === "users" || item.key === "activity_log" || item.key === "order_history" || item.key === "site_agent") return session.role === "admin";
   ```
   As of `00589e0` this is the only place the nav is filtered.

   **e) Route.** Next to the other admin-only views (~line 11352, after the `users` line), add:
   ```jsx
   {view === "site_agent" && viewSession.role === "admin" && (
     <SiteAgentPanel client={supabaseClient} supabaseUrl={SUPABASE_URL} anonKey={SUPABASE_ANON_KEY} />
   )}
   ```

4. Pull `main` again. If it moved, rebase and resolve carefully. Then push the branch, open the PR and summarise the 5 touched spots.
5. After the owner merges, remove your line from `WORKING_ON.md` (in a follow-up PR).

## 8. Telegram (messages on the phone)

1. Create a bot with **@BotFather**, then set `TELEGRAM_BOT_TOKEN`.
2. Set `TELEGRAM_WEBHOOK_SECRET` to a random string: `openssl rand -hex 24`.
3. Register the webhook:
   ```bash
   curl "https://api.telegram.org/bot<TOKEN>/setWebhook" \
     -d "url=https://zonuxfqvyxhfkimdahkb.supabase.co/functions/v1/site-agent-telegram" \
     -d "secret_token=<TELEGRAM_WEBHOOK_SECRET>"
   ```
4. The owner messages the bot. It replies with their chat id. Put it in `TELEGRAM_CHAT_IDS` (comma-separated for several people) and re-set the secrets.

Commands: `/check` `/alerts` `/approvals` `/approve <id>` `/reject <id>` `/stop` `/new`. Anything else is a question to the agent.

## 9. Optional: code access (fix pull requests)

Create a **fine-grained GitHub token** limited to `abwebstudioofficial-web/logistix` with:

- Contents: read/write
- Pull requests: read/write
- Commit statuses: read

Set `GITHUB_TOKEN`. Also turn on **branch protection for `main`** (require a pull request), so even this token can't push to `main`.

What the agent does with it:

- Branches `maint/<name>` from the latest `main`.
- Applies small find/replace edits. They fail if the code changed underneath, so it never overwrites anyone's work.
- Checks `WORKING_ON.md` and open PRs first.
- Opens a PR. It cannot merge.

## 10. Smoke test

1. Log in as an admin, open **Site Agent**, and press **Run check now**. Within a minute:
   - The morning report streams into the message thread, Claude-style.
   - The same report arrives on Telegram.
   - The header shows "AI this month $0.00 / $5.00". No AI is used unless a check finds a new problem.
2. Expected first findings, based on the data at setup:
   - FYI: ~1,524 containers still at "Confirmed" months after their loading date. This is info only, with no AI call.
   - Needs action: 1 overdue invoice. It's new, so it gets one Haiku explanation (about half a US cent), shown under "🤖 About the new problems".
   - No late orders.
3. Press **Run check now** again. The same problems now show "(open since …)" with no new AI call. Check with `select count(*) from agent_ai_calls;` (still 1).
4. Leave the page open. New messages appear on their own within 15 seconds and write themselves out.

## 11. Troubleshooting

| Symptom | Fix |
|---|---|
| Run fails with a 400 mentioning `fallbacks` or `context_management` | Set `AGENT_ENABLE_FALLBACKS=false` or `AGENT_ENABLE_COMPACTION=false`. |
| Runs pause for about a minute between steps | Normal on the free plan: each worker gets 150s, and the sweeper continues the run. On Pro, set `AGENT_WALL_CLOCK_MS=400000`. |
| "This month's AI budget ... is used up" | Raise `AI_MONTHLY_BUDGET_USD`. Checks, reports and alerts keep working without AI in the meantime. |
| Want zero automatic AI calls | Set `AI_EXPLAIN_PROBLEMS=false`. Reports and alerts still arrive, just without the explanation. |
| Morning report never arrives | Check `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_IDS`, the Vault secrets, then `select * from cron.job_run_details where jobid in (select jobid from cron.job where jobname like 'site-agent-%') order by start_time desc limit 20;`, then the function logs. |
| Panel says "Only admins can use Site Agent" | The user needs `profiles.role = 'admin'`, or a row in `public.agent_admins`. |
| No messages on phone | At least one notification channel must be configured (see `.env.example`). Alerts below `NOTIFY_MIN_SEVERITY` are shown on the site only. Every message is always on the site. |

## 12. Local checks you can re-run

```bash
deno test --allow-env supabase/functions/_shared/       # SQL guard + code-edit unit tests
cd supabase/functions && deno check site-agent-*/index.ts
```
