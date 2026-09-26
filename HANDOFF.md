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
| `supabase/migrations/20260926000001_site_agent_schema.sql` | New `agent_*` tables, RLS (admins read-only from the browser), helper functions, the `agent_container_view` view, starter watch rules and memory notes. **Does not alter any existing table.** Safe to re-run. |
| `supabase/migrations/20260926000002_site_agent_cron.sql` | 4 **new** pg_cron jobs: the 08:00 PKT morning check, a 15-minute monitor, a 1-minute sweeper and daily housekeeping. **Ask the owner before applying (rule 5).** |
| `supabase/functions/site-agent-chat` | The dashboard's API (admin-only, verifies the user's session). |
| `supabase/functions/site-agent-worker` | Runs the AI agent in the background (chunked, so it never hits the Edge Function time limit). |
| `supabase/functions/site-agent-cron` | Entry point for the scheduled jobs. |
| `supabase/functions/site-agent-telegram` | Optional: chat with the agent and approve its requests from Telegram. |
| `supabase/functions/_shared/` | Agent loop, tools, SQL safety guard, checks, notifications. |
| `web/SiteAgentPanel.jsx` | The admin panel, written to paste straight into `index.html`. |
| `.env.example` | Every secret/setting, with explanations. |

## 2. Apply the schema migration

Apply `supabase/migrations/20260926000001_site_agent_schema.sql` **as a migration**:

- Supabase MCP: `apply_migration`, name `site_agent_schema`, query = the file contents.
- Or with the CLI: copy it into the project's `supabase/migrations/` and run `supabase db push`.

Then verify (read-only):

```sql
select count(*) from public.agent_watch_rules;                              -- 12
select key from public.agent_memory order by key;                           -- 5 notes
select stage_name, count(*) from public.agent_container_view group by 1;    -- mostly "Confirmed"
select public.agent_is_admin(id) from public.profiles where role = 'admin'; -- true
```

## 3. Set the Edge Function secrets

Copy `.env.example` to `site-agent.env` and fill it in. **Don't commit the filled-in file.** At minimum set:

- `ANTHROPIC_API_KEY`
- `AGENT_INTERNAL_SECRET`: generate with `openssl rand -hex 32`
- `SITE_URL`: the live GitHub Pages URL, no trailing slash
- `AGENT_WALL_CLOCK_MS`: `150000` on the free plan, `400000` on Pro

Then run:

```bash
supabase secrets set --project-ref zonuxfqvyxhfkimdahkb --env-file ./site-agent.env
```

## 4. Deploy the functions

```bash
supabase functions deploy site-agent-chat     --project-ref zonuxfqvyxhfkimdahkb
supabase functions deploy site-agent-worker   --project-ref zonuxfqvyxhfkimdahkb --no-verify-jwt
supabase functions deploy site-agent-cron     --project-ref zonuxfqvyxhfkimdahkb --no-verify-jwt
supabase functions deploy site-agent-telegram --project-ref zonuxfqvyxhfkimdahkb --no-verify-jwt   # optional
```

Why `--no-verify-jwt` is safe for these: worker and cron check the `x-agent-secret` header themselves, and telegram checks Telegram's secret token. `site-agent-chat` keeps JWT verification and also checks that the user is an admin.

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
| `site-agent-daily` | `0 3 * * *` = **08:00 PKT** | Full checks, then the AI morning review, then the report sent to the team. It runs after the HiCetane fetch (07:00/07:30 PKT). The PSO diesel job runs at 06:00 UTC = 11:00 PKT. |
| `site-agent-monitor` | every 15 min | Quick uptime/critical checks. No AI cost unless something new breaks. |
| `site-agent-sweep` | every minute | Only calls the worker if an agent run was interrupted. Idle otherwise. |
| `site-agent-retention` | `30 3 * * *` | Deletes old health checks and audit logs, and expires week-old approvals. |

It does **not** touch the three existing jobs. Once the owner says yes, apply it as a migration (name `site_agent_cron`).

## 7. Add the panel to `index.html` (one small PR)

1. Pull the latest `main`, then create branch `maint/site-agent-panel`.
2. Add to `WORKING_ON.md`: `- Site Agent panel: adding SiteAgentPanel block after the icon set, NAV_ITEMS entry, VIEW_TITLES entry, admin-only nav filter, view route (branch maint/site-agent-panel)`
3. Make these **5 edits** in `index.html`. Line numbers are from `main` @ `07a872f`, so search for the text rather than trusting the numbers.

   **a) Paste the panel.** Put the whole content of `web/SiteAgentPanel.jsx` inside the `<script type="text/babel">` block at module scope, right before `const FLEET_LINK_KEY = "logistix-fleet-url";` (~line 486, after the icon set).
   - It uses `React.useState` etc., because `index.html` already destructures the hooks at the top.
   - All its names are prefixed `SiteAgent*` / `SA*` / `sa*`. I verified that it compiles together with the current `index.html` under the page's `@babel/standalone@7.23.10`, with no name clashes.

   **b) Nav item.** In `NAV_ITEMS` (~line 488), add before the `settings` entry:
   ```js
   { key: "site_agent", label: "Site Agent", icon: SiteAgentIcon },
   ```

   **c) Title.** In `VIEW_TITLES` (~line 624), add:
   ```js
   site_agent: "Site Agent",
   ```

   **d) Admin only.** In the sidebar nav filter (~line 3790), change
   ```js
   if (item.key === "users" || item.key === "activity_log" || item.key === "order_history") return session.role === "admin";
   ```
   to
   ```js
   if (item.key === "users" || item.key === "activity_log" || item.key === "order_history" || item.key === "site_agent") return session.role === "admin";
   ```
   As of `07a872f` this is the only place the nav is filtered.

   **e) Route.** Next to the other admin-only views (~line 11332, after the `users` line), add:
   ```jsx
   {view === "site_agent" && viewSession.role === "admin" && (
     <SiteAgentPanel client={supabaseClient} supabaseUrl={SUPABASE_URL} anonKey={SUPABASE_ANON_KEY} />
   )}
   ```

4. Pull `main` again. If it moved, rebase and resolve carefully. Then push the branch, open the PR and summarise the 5 touched spots.
5. After the owner merges, remove your line from `WORKING_ON.md` (in a follow-up PR).

## 8. Optional: Telegram (chat + approvals from the phone)

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

1. Log in as an admin, open **Site Agent**, and press **Run full check**. Within a few minutes the conversation shows the agent's steps and the morning report.
2. Expected first findings, based on the data at setup:
   - ~1,524 containers still at stage "Confirmed" months after their loading date. Probably imported history; the agent will ask before touching them.
   - 1 overdue invoice.
   - No late orders.
3. Ask *"which containers are running late?"* in the chat.
4. Tell it to fix something small and check that an approval request appears. The default mode `AGENT_AUTONOMY=readonly` makes every change wait for approval. Approve it and watch the agent confirm.

## 11. Troubleshooting

| Symptom | Fix |
|---|---|
| Run fails with a 400 mentioning `fallbacks` or `context_management` | Set `AGENT_ENABLE_FALLBACKS=false` or `AGENT_ENABLE_COMPACTION=false`. |
| Runs pause for about a minute between steps | Normal on the free plan: each worker gets 150s, and the sweeper continues the run. On Pro, set `AGENT_WALL_CLOCK_MS=400000`. |
| Morning report never arrives | Check the Vault secrets, then `select * from cron.job_run_details where jobid in (select jobid from cron.job where jobname like 'site-agent-%') order by start_time desc limit 20;`, then the function logs. |
| Panel says "Only admins can use Site Agent" | The user needs `profiles.role = 'admin'`, or a row in `public.agent_admins`. |
| No messages on phone | At least one notification channel must be configured (see `.env.example`). Alerts below `NOTIFY_MIN_SEVERITY` stay in the dashboard only. |

## 12. Local checks you can re-run

```bash
deno test --allow-env supabase/functions/_shared/       # SQL guard + code-edit unit tests
cd supabase/functions && deno check site-agent-*/index.ts
```
