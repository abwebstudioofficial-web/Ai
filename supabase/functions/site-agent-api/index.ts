// The site panel's API. Called from the browser with the signed-in user's access
// token (Authorization: Bearer <token>). Only agent admins may use it. The panel
// reads AND writes through here, so it works with the app's lite Supabase client.
// Nothing here calls Claude, except run_check when it finds a NEW problem (one
// small Haiku call to explain it).
//
// Actions:
//   { action: "messages", after_id?, before_id? }      -> { messages }  (reports, alerts, recoveries... oldest first)
//   { action: "summary" }                              -> { alerts, approvals, health, autonomy, ai spend }
//   { action: "run_check", kind?: "daily" | "monitor" } (rule-based)
//   { action: "approve" | "reject", approval_id, note? }
//   { action: "update_alert", alert_id, status: "acknowledged" | "resolved" | "open", note? }
import { corsHeaders, getUser, isAdmin, json } from "../_shared/http.ts";
import { ActiveRunError } from "../_shared/runs.ts";
import { ApprovalError, decideApproval } from "../_shared/approvals.ts";
import { runDailyCheck, runMonitor } from "../_shared/jobs.ts";
import { monthToDateUsd } from "../_shared/ai_cost.ts";
import { setAlertStatus } from "../_shared/alerts.ts";
import { db, errorMessage } from "../_shared/db.ts";
import { config } from "../_shared/config.ts";
import { ensureSettings } from "../_shared/settings.ts";

const PAGE = 40;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  await ensureSettings();

  const user = await getUser(req);
  if (!user) return json({ error: "Please sign in." }, 401);
  if (!(await isAdmin(user.id))) return json({ error: "Only admins can use Site Agent." }, 403);

  const body = await req.json().catch(() => ({})) as Record<string, unknown>;

  try {
    switch (body.action) {
      case "messages": {
        const sql = db();
        const after = Number(body.after_id) || 0;
        const before = Number(body.before_id) || 0;
        const cols = sql`id, kind, severity, title, body, created_at`;
        const rows = after
          ? await sql`select ${cols} from public.agent_notifications where id > ${after} order by id limit 100`
          : before
          ? (await sql`select ${cols} from public.agent_notifications where id < ${before} order by id desc limit ${PAGE}`)
            .reverse()
          : (await sql`select ${cols} from public.agent_notifications order by id desc limit ${PAGE}`).reverse();
        return json({ messages: rows, has_more: !after && rows.length === PAGE });
      }

      case "summary": {
        const sql = db();
        const [alerts, approvals, health] = await Promise.all([
          sql`select id, severity, category, title, body, ai_note, status, occurrences, first_seen_at, last_seen_at
              from public.agent_alerts
              where status <> 'resolved'
              order by case severity when 'critical' then 0 when 'warning' then 1 else 2 end, last_seen_at desc limit 100`,
          sql`select id, tool_name, tool_input, reason, created_at from public.agent_approvals
              where status = 'pending' order by id desc limit 50`,
          sql`select h.job, h.check_name, h.status, h.summary, h.created_at
              from public.agent_health_checks h
              where h.batch_id in (
                (select batch_id from public.agent_health_checks where job in ('daily', 'agent_full') order by created_at desc limit 1),
                (select batch_id from public.agent_health_checks where job in ('monitor', 'agent_quick') order by created_at desc limit 1))
              order by h.id`,
        ]);
        const isFull = (j: string) => j === "daily" || j === "agent_full";
        return json({
          alerts,
          approvals,
          health: { full: health.filter((h) => isFull(h.job)), quick: health.filter((h) => !isFull(h.job)) },
          autonomy: config.autonomy,
          ai_spend_month_usd: await monthToDateUsd(),
          ai_budget_usd: config.monthlyBudgetUsd,
        });
      }

      case "run_check": {
        // Rule-based. The result arrives as a new message (the report, or an alert).
        if (body.kind === "monitor") {
          const { newProblems } = await runMonitor();
          return json({ ok: true, new_problems: newProblems });
        }
        await runDailyCheck();
        return json({ ok: true });
      }

      case "approve":
      case "reject": {
        const id = Number(body.approval_id);
        if (!Number.isInteger(id)) return json({ error: "approval_id is required" }, 400);
        const res = await decideApproval(
          id,
          body.action,
          { userId: user.id, via: "web" },
          typeof body.note === "string" ? body.note : null,
        );
        return json(res);
      }

      case "update_alert": {
        const id = Number(body.alert_id);
        const status = body.status;
        if (!Number.isInteger(id) || (status !== "open" && status !== "acknowledged" && status !== "resolved")) {
          return json({ error: "alert_id and a valid status are required" }, 400);
        }
        const ok = await setAlertStatus(
          id,
          status,
          typeof body.note === "string" ? body.note : `Set to ${status} from the dashboard`,
        );
        return json({ updated: ok });
      }

      default:
        return json({ error: "unknown action" }, 400);
    }
  } catch (e) {
    if (e instanceof ActiveRunError) return json({ error: e.message }, 409);
    if (e instanceof ApprovalError) return json({ error: e.message }, 409);
    console.error("site-agent-api error", e);
    return json({ error: errorMessage(e) }, 500);
  }
});
