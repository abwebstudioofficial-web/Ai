# Site Agent: setup guide

**Site Agent runs only in the background** (scheduled checks, messages on Telegram). It adds nothing to the LogistiX website. Read this whole file before changing anything. Every step below follows the owner's project rules.

**Status (26 Sept 2026): set up and live.** Steps 2 to 6 are done. Telegram (step 7) is waiting for the bot token.

- Code: this repo (`abwebstudioofficial-web/ai`), folder `supabase/`
- Site it watches: `abwebstudioofficial-web/logistix` (GitHub Pages). Site Agent never changes it unless the owner approves a pull request.
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

   Site Agent's own fix pull requests (step 8) follow these too.

## 1. What's in this repo

| Path | What it is |
|---|---|
| `supabase/migrations/20260926000001_site_agent_schema.sql` | New `agent_*` tables (including the `agent_ai_calls` cost ledger), RLS (admins read-only from the browser), helper functions, the `agent_container_view` view, starter watch rules and memory notes. **Does not alter any existing table.** Safe to re-run. |
| `supabase/migrations/20260926000002_site_agent_cron.sql` | 4 **new** pg_cron jobs: the 08:00 PKT rule-based morning report, a 15-minute monitor, a 1-minute sweeper and daily housekeeping. **Ask the owner before applying (rule 5).** |
| `supabase/migrations/20260926000003_site_agent_no_dashboard_link.sql` | Removes the "Open dashboard" link setting (there is no Site Agent page). |
| `supabase/functions/site-agent-worker` | Only used if someone sends the Telegram bot a question: answers with Claude Sonnet 5 in the background (chunked, so it never hits the Edge Function time limit). |
| `supabase/functions/site-agent-cron` | Entry point for the scheduled jobs. Rule-based: no AI unless a check finds a NEW problem, then one Claude Haiku call. |
| `supabase/functions/site-agent-telegram` | Optional: Telegram commands (/check, /alerts, /cost, /approve...) and optional questions. |
| `supabase/functions/_shared/` | Checks and report (`checks.ts`, `report.ts`, `jobs.ts`), the Haiku explanation (`explain.ts`), the budget cap (`ai_cost.ts`), notifications (sent to Telegram and logged in `agent_notifications`), the question agent, tools, SQL safety guard. |
| `.env.example` | Every setting, with explanations. Normally you set these in the database instead (step 3). |

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

## 3. Settings and secrets (no Edge Function secrets needed)

Site Agent reads its configuration from the database, so nothing has to be set on the Edge Functions page:

- **Plain settings** live in `public.agent_settings`. The schema migration already seeds `site_url`, `site_key_paths`, `github_repo`, `timezone` and `telegram_chat_ids`. Optional keys are `notify_min_severity`, `ai_monthly_budget_usd`, `ai_explain_problems` (true/false) and `autonomy`.
- **Secrets** live in **Supabase Vault**, with names starting with `site_agent_`:

| Vault secret | Who creates it |
|---|---|
| `site_agent_internal_secret` | Generated by the schema migration. Nobody ever needs to see it. |
| `site_agent_telegram_webhook_secret` | Generated by the schema migration |
| `site_agent_project_url` | You, once: `select vault.create_secret('https://zonuxfqvyxhfkimdahkb.supabase.co', 'site_agent_project_url');` |
| `site_agent_telegram_bot_token` | The owner: the token from @BotFather (step 7) |
| `site_agent_anthropic_api_key` | Optional. Only needed if the project has no `ANTHROPIC_API_KEY` function secret. |
| `site_agent_github_token`, `site_agent_supabase_pat` | Optional (step 8) |
| `site_agent_telegram_claim_code` | Created and deleted automatically: the one-time Telegram connect link |

An Edge Function secret with the same meaning (`ANTHROPIC_API_KEY`, `SITE_URL`, `TELEGRAM_BOT_TOKEN`, see `.env.example`) always wins over the database. Telegram chats connected with a link are added to any `TELEGRAM_CHAT_IDS` secret.

The cost settings stay at their defaults unless the owner says otherwise: Haiku for automatic explanations, a US$5 monthly cap, and Sonnet 5 (effort medium) only for questions asked on Telegram.

**Check the setup at any time** (it never shows secret values):

```sql
select public.agent_invoke('site-agent-cron', '{"job":"status"}');     -- returns a request id
select status_code, content from net._http_response where id = <that id>;
```

## 4. Deploy the functions

```bash
supabase functions deploy site-agent-cron     --project-ref zonuxfqvyxhfkimdahkb --no-verify-jwt
supabase functions deploy site-agent-worker   --project-ref zonuxfqvyxhfkimdahkb --no-verify-jwt
supabase functions deploy site-agent-telegram --project-ref zonuxfqvyxhfkimdahkb --no-verify-jwt
```

Why `--no-verify-jwt` is safe for these: worker and cron check the `x-agent-secret` header themselves, and telegram checks Telegram's secret token. None of them can be used from a browser.

How they are deployed now: each live function is a one-line `index.ts` that imports this repo's code from a **pinned commit** (`https://raw.githubusercontent.com/abwebstudioofficial-web/Ai/<commit>/supabase/functions/<name>/index.ts`). Supabase bundles it at deploy time. To update, deploy the same one-liner with the new commit id.

## 5. Vault secret for the scheduler

Only `site_agent_project_url` is needed (see step 3). The migration already generated `site_agent_internal_secret`, which both the scheduler and the functions read from Vault.

## 6. Schedules: ask the owner first

`supabase/migrations/20260926000002_site_agent_cron.sql` adds 4 new jobs:

| Job | Schedule (UTC) | What it does |
|---|---|---|
| `site-agent-daily` | `0 3 * * *` = **08:00 PKT** | Rule-based full checks and the morning report to Telegram. **No AI** unless a check finds a new problem (then one Haiku call, about half a US cent). It runs after the HiCetane fetch (07:00/07:30 PKT). The PSO diesel job runs at 06:00 UTC = 11:00 PKT. |
| `site-agent-monitor` | every 15 min | Quick uptime/critical checks. No AI unless something new breaks (then one Haiku call). |
| `site-agent-sweep` | every minute | Only calls the worker if a Telegram question's answer was interrupted. Idle otherwise. |
| `site-agent-retention` | `30 3 * * *` | Deletes old health checks and audit logs, and expires week-old approvals. |

It does **not** touch the three existing jobs. Once the owner says yes, apply it as a migration (name `site_agent_cron`).

## 7. Telegram (messages on the developer's phone)

**Site Agent has exactly one recipient: the developer.** Only one Telegram chat can ever be connected, it must be a private chat (not a group), and everyone else who messages the bot just gets "This is a private bot."

1. The developer creates a bot with **@BotFather** (`/newbot`) and stores the token:
   ```sql
   select vault.create_secret('<token from BotFather>', 'site_agent_telegram_bot_token');
   ```
2. Connect the bot. This registers the webhook with the generated secret, sets the command menu and creates a one-time connect link:
   ```sql
   select public.agent_invoke('site-agent-cron', '{"job":"telegram_setup"}');
   select content from net._http_response where id = <that id>;   -- {"connect_link": "https://t.me/<bot>?start=..."}
   ```
3. The developer opens the link on their phone and presses **Start**. That chat becomes the only one in `agent_settings.telegram_chat_ids`, the link stops working, and from then on `telegram_setup` refuses to make new links.
4. To move to a new phone or chat: `update public.agent_settings set value = '[]' where key = 'telegram_chat_ids';`, then run step 2 again.

Commands: `/check` `/alerts` `/approvals` `/approve <id>` `/reject <id>` `/cost` `/stop` `/new`. Anything else is a question to the agent.

## 8. Optional: code access (fix pull requests)

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

## 9. Smoke test

1. Run the `status` job (step 3). Expect `secrets.AGENT_INTERNAL_SECRET: "vault"` and `anthropic_key_works: true`. After step 7 you should also see `telegram.webhook_ok: true` and at least 1 connected chat.
2. Send `/check` to the Telegram bot. Within a minute the full report arrives.
3. Expected findings, based on the data at setup:
   - FYI: ~1,524 containers still at "Confirmed" months after their loading date. This is info only, with no AI call.
   - Keep an eye on: 1 overdue invoice. It's new, so it gets one Haiku explanation (about half a US cent), if the Claude account has credit.
   - No late orders.
4. Send `/check` again. The same problems now show "(open since …)" with no new AI call.

## 10. Troubleshooting

| Symptom | Fix |
|---|---|
| Run fails with a 400 mentioning `fallbacks` or `context_management` | Set `AGENT_ENABLE_FALLBACKS=false` or `AGENT_ENABLE_COMPACTION=false`. |
| Runs pause for about a minute between steps | Normal on the free plan: each worker gets 150s, and the sweeper continues the run. On Pro, set `AGENT_WALL_CLOCK_MS=400000`. |
| "This month's AI budget ... is used up" | Raise `AI_MONTHLY_BUDGET_USD`. Checks, reports and alerts keep working without AI in the meantime. |
| Want zero automatic AI calls | Set `AI_EXPLAIN_PROBLEMS=false`. Reports and alerts still arrive, just without the explanation. |
| "The Claude account has no credit left" | Add credit at console.anthropic.com → Plans & Billing, or set `ai_explain_problems` to `false` in `agent_settings`. |
| Morning report never arrives | Run the `status` job (step 3), then `select * from cron.job_run_details where jobid in (select jobid from cron.job where jobname like 'site-agent-%') order by start_time desc limit 20;`, then the function logs. |
| No messages on phone | Run the `status` job: `telegram.connected_chats` must be at least 1, and `webhook_ok` true. Alerts below `NOTIFY_MIN_SEVERITY` are not pushed; they are listed in the morning report. |

## 11. Local checks you can re-run

```bash
deno test --allow-env supabase/functions/_shared/       # SQL guard + code-edit unit tests
cd supabase/functions && deno check site-agent-*/index.ts
```
